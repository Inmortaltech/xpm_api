-- =============================================================================
--  XMP  —  CELOXIS FULL PARITY  —  remaining gaps
-- -----------------------------------------------------------------------------
--     * Portfolios / programs
--     * Baseline snapshot + variance (columns already exist; add flag)
--     * Critical path (no new tables — pure compute)
--     * Invoicing & AR
--     * Unified / configurable approval engine
--     * Forward capacity planning (uses project_schedule.allocation_pct)
--     * Custom report builder + saved reports
--     * Client portal (client role + scoped read)
--
--  RUN (after xmp_db_celoxis_polish.sql):
--     mysql -u root xmp_db < db_bkp/xmp_db_celoxis_full.sql
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP PROCEDURE IF EXISTS `xmp_c`;
DELIMITER $$
CREATE PROCEDURE `xmp_c`(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(1024))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @s = CONCAT('ALTER TABLE `', t, '` ADD COLUMN ', ddl);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$
DELIMITER ;

-- =============================================================================
--  1.  PORTFOLIOS / PROGRAMS
-- =============================================================================
CREATE TABLE IF NOT EXISTS `portfolios` (
  `id`          INT           NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(150)  NOT NULL,
  `code`        VARCHAR(30)   DEFAULT NULL,
  `description` VARCHAR(500)  DEFAULT NULL,
  `owner_id`    INT           DEFAULT NULL,
  `color`       VARCHAR(12)   DEFAULT '#3b5bdb',
  `is_active`   TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CALL xmp_c('projects', 'portfolio_id',   "`portfolio_id` INT DEFAULT NULL");
CALL xmp_c('projects', 'baseline_set_at',"`baseline_set_at` DATETIME DEFAULT NULL");

-- =============================================================================
--  2.  INVOICING & AR
-- =============================================================================
CREATE TABLE IF NOT EXISTS `invoices` (
  `id`           INT           NOT NULL AUTO_INCREMENT,
  `invoice_no`   VARCHAR(30)   NOT NULL,
  `project_id`   INT           DEFAULT NULL,
  `client_name`  VARCHAR(200)  DEFAULT NULL,
  `type`         VARCHAR(20)   NOT NULL DEFAULT 'time_material',  -- time_material | milestone | fixed
  `status`       VARCHAR(16)   NOT NULL DEFAULT 'draft',          -- draft | sent | paid | overdue | void
  `issue_date`   DATE          DEFAULT NULL,
  `due_date`     DATE          DEFAULT NULL,
  `currency`     VARCHAR(6)    NOT NULL DEFAULT 'INR',
  `subtotal`     DECIMAL(15,2) NOT NULL DEFAULT 0,
  `tax_pct`      DECIMAL(5,2)  NOT NULL DEFAULT 0,
  `tax_amount`   DECIMAL(15,2) NOT NULL DEFAULT 0,
  `total`        DECIMAL(15,2) NOT NULL DEFAULT 0,
  `paid_amount`  DECIMAL(15,2) NOT NULL DEFAULT 0,
  `paid_date`    DATE          DEFAULT NULL,
  `notes`        VARCHAR(500)  DEFAULT NULL,
  `created_by`   INT           DEFAULT NULL,
  `created_at`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoice_no` (`invoice_no`),
  KEY `idx_inv_project` (`project_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `invoice_lines` (
  `id`           INT           NOT NULL AUTO_INCREMENT,
  `invoice_id`   INT           NOT NULL,
  `description`  VARCHAR(300)  NOT NULL,
  `qty`          DECIMAL(10,2) NOT NULL DEFAULT 1,
  `unit`         VARCHAR(20)   DEFAULT 'hrs',
  `rate`         DECIMAL(12,2) NOT NULL DEFAULT 0,
  `amount`       DECIMAL(15,2) NOT NULL DEFAULT 0,
  `source_type`  VARCHAR(20)   DEFAULT 'manual',   -- time | expense | milestone | manual
  `source_id`    VARCHAR(40)   DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_iline_invoice` (`invoice_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- mark time / expense rows as invoiced so they aren't billed twice
CALL xmp_c('timesheets', 'invoiced', "`invoiced` TINYINT(1) NOT NULL DEFAULT 0");
CALL xmp_c('expenses',   'invoiced', "`invoiced` TINYINT(1) NOT NULL DEFAULT 0");

-- =============================================================================
--  3.  APPROVAL ENGINE  (configurable multi-step, delegation, unified inbox)
-- =============================================================================
CREATE TABLE IF NOT EXISTS `approvals` (
  `id`           INT           NOT NULL AUTO_INCREMENT,
  `entity_type`  VARCHAR(40)   NOT NULL,        -- project_intake | schedule_freeze | resource_change | timesheet | expense | invoice | generic
  `entity_id`    VARCHAR(40)   DEFAULT NULL,
  `project_id`   INT           DEFAULT NULL,
  `title`        VARCHAR(255)  NOT NULL,
  `summary`      VARCHAR(500)  DEFAULT NULL,
  `requested_by` INT           DEFAULT NULL,
  `requested_by_name` VARCHAR(150) DEFAULT NULL,
  `amount`       DECIMAL(15,2) DEFAULT NULL,
  `status`       VARCHAR(16)   NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | cancelled
  `current_step` INT           NOT NULL DEFAULT 1,
  `created_at`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `closed_at`    DATETIME      DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_appr_status` (`status`),
  KEY `idx_appr_entity` (`entity_type`, `entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `approval_steps` (
  `id`            INT           NOT NULL AUTO_INCREMENT,
  `approval_id`   INT           NOT NULL,
  `step_no`       INT           NOT NULL DEFAULT 1,
  `approver_id`   INT           DEFAULT NULL,
  `approver_role` VARCHAR(60)   DEFAULT NULL,
  `status`        VARCHAR(16)   NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | skipped | delegated
  `decided_at`    DATETIME      DEFAULT NULL,
  `delegated_to`  INT           DEFAULT NULL,
  `note`          VARCHAR(500)  DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_astep_appr` (`approval_id`, `step_no`),
  KEY `idx_astep_approver` (`approver_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  4.  SAVED REPORTS  (report builder)
-- =============================================================================
CREATE TABLE IF NOT EXISTS `saved_reports` (
  `id`         INT           NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(150)  NOT NULL,
  `entity`     VARCHAR(30)   NOT NULL,       -- projects | timesheets | expenses | risks | issues | resources | invoices
  `config`     TEXT          NOT NULL,       -- JSON { columns, filters, group_by, order_by }
  `owner_id`   INT           DEFAULT NULL,
  `is_shared`  TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  5.  CLIENT PORTAL  —  client login role + scoped mapping
-- =============================================================================
CREATE TABLE IF NOT EXISTS `client_access` (
  `id`         INT           NOT NULL AUTO_INCREMENT,
  `user_id`    INT           NOT NULL,        -- users.id whose role = 'Client'
  `project_id` INT           NOT NULL,
  `can_view_financials` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_client_project` (`user_id`, `project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP PROCEDURE IF EXISTS `xmp_c`;
SET FOREIGN_KEY_CHECKS = 1;

-- =============================================================================
--  6.  SEED
-- =============================================================================

-- 6.1 portfolios
INSERT INTO `portfolios` (`id`, `name`, `code`, `description`, `owner_id`)
SELECT 1, 'Digital Transformation', 'DX', 'ERP + reporting modernisation', 12
WHERE NOT EXISTS (SELECT 1 FROM `portfolios` WHERE id = 1);
INSERT INTO `portfolios` (`id`, `name`, `code`, `description`, `owner_id`)
SELECT 2, 'Client Delivery', 'CD', 'Fixed-bid client projects', 12
WHERE NOT EXISTS (SELECT 1 FROM `portfolios` WHERE id = 2);
UPDATE `projects` SET portfolio_id = 1 WHERE id = 1 AND portfolio_id IS NULL;
UPDATE `projects` SET portfolio_id = 2 WHERE id = 2 AND portfolio_id IS NULL;

-- 6.2 baseline snapshot for project 1 (planned -> baseline)
UPDATE `project_schedule` SET baseline_start = planned_start, baseline_end = planned_end
 WHERE project_id = 1 AND baseline_start IS NULL;
UPDATE `projects` SET baseline_set_at = NOW() WHERE id = 1 AND baseline_set_at IS NULL;

-- 6.3 one demo invoice (draft) for project 1
INSERT INTO `invoices` (`invoice_no`, `project_id`, `client_name`, `type`, `status`, `issue_date`, `due_date`, `subtotal`, `tax_pct`, `tax_amount`, `total`)
SELECT 'INV-2026001', 1, 'ABC Pvt Ltd', 'time_material', 'sent', CURDATE() - INTERVAL 10 DAY, CURDATE() + INTERVAL 5 DAY,
       45000, 18, 8100, 53100
WHERE NOT EXISTS (SELECT 1 FROM `invoices` WHERE invoice_no = 'INV-2026001');
INSERT INTO `invoice_lines` (`invoice_id`, `description`, `qty`, `unit`, `rate`, `amount`, `source_type`)
SELECT (SELECT id FROM invoices WHERE invoice_no = 'INV-2026001'), 'Approved billable time — Aug', 15, 'hrs', 3000, 45000, 'time'
WHERE NOT EXISTS (SELECT 1 FROM `invoice_lines` WHERE description = 'Approved billable time — Aug');

-- 6.4 client user + access (login: client@xmp.test / client123)
INSERT INTO `users` (`name`, `email`, `password`, `role`, `user_type`, `status`, `createdAt`, `updatedAt`)
SELECT 'David Miller', 'client@xmp.test', 'client123', 'Client', 'customer', 'enable', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE email = 'client@xmp.test');
INSERT INTO `client_access` (`user_id`, `project_id`, `can_view_financials`)
SELECT (SELECT id FROM users WHERE email = 'client@xmp.test'), 1, 0
WHERE NOT EXISTS (SELECT 1 FROM `client_access` WHERE user_id = (SELECT id FROM users WHERE email = 'client@xmp.test') AND project_id = 1);

-- 6.5 a saved report
INSERT INTO `saved_reports` (`name`, `entity`, `config`, `owner_id`)
SELECT 'Overdue projects', 'projects',
  JSON_OBJECT('columns', JSON_ARRAY('project_code','project_name','project_manager','end_date','status','health','progress_pct'),
              'filters', JSON_ARRAY(JSON_OBJECT('field','health','op','in','value',JSON_ARRAY('red','amber'))),
              'order_by', JSON_OBJECT('field','end_date','dir','asc')),
  12
WHERE NOT EXISTS (SELECT 1 FROM `saved_reports` WHERE name = 'Overdue projects');

-- =============================================================================
--  END
-- =============================================================================
