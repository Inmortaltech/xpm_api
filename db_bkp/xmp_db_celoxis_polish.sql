-- =============================================================================
--  XMP  —  CELOXIS-PARITY POLISH  —  DATABASE SETUP
-- -----------------------------------------------------------------------------
--  Celoxis ke reference par jo PM/PMO/User pillars missing the — unhe add karta
--  hai:
--     * Project HEALTH (RAG) + PROGRESS rollup            -> projects
--     * Activity feed (har entity ka audit trail)          -> activity_log
--     * Time tracking / timesheets                          -> timesheets
--     * Expenses + approval                                 -> expenses
--     * Schedule task dependencies + baseline + hours       -> project_schedule
--     * Risk scoring (probability x impact)                 -> risks
--     * Resource cost / bill rate + capacity                -> resources
--
--  RUN (baaki sab SQL files ke baad):
--     mysql -u root xmp_db < db_bkp/xmp_db_celoxis_polish.sql
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP PROCEDURE IF EXISTS `xmp_col`;
DELIMITER $$
CREATE PROCEDURE `xmp_col`(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(1024))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @s = CONCAT('ALTER TABLE `', t, '` ADD COLUMN ', ddl);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$
DELIMITER ;

-- =============================================================================
--  1.  PROJECTS  —  health / progress / phase
-- =============================================================================
CALL xmp_col('projects', 'health',        "`health` VARCHAR(12) DEFAULT NULL");       -- green | amber | red (computed)
CALL xmp_col('projects', 'health_note',   "`health_note` VARCHAR(255) DEFAULT NULL");
CALL xmp_col('projects', 'progress_pct',  "`progress_pct` DECIMAL(5,2) DEFAULT 0");   -- 0..100 rollup
CALL xmp_col('projects', 'phase',         "`phase` VARCHAR(60) DEFAULT NULL");        -- Initiation / Planning / Execution / Closure
CALL xmp_col('projects', 'actual_cost',   "`actual_cost` DECIMAL(15,2) DEFAULT 0");
CALL xmp_col('projects', 'billed_amount', "`billed_amount` DECIMAL(15,2) DEFAULT 0");

-- =============================================================================
--  2.  ACTIVITY LOG  —  unified audit trail (Celoxis "Activity")
-- =============================================================================
CREATE TABLE IF NOT EXISTS `activity_log` (
  `id`            BIGINT        NOT NULL AUTO_INCREMENT,
  `entity_type`   VARCHAR(40)   NOT NULL,           -- project | issue | sprint | risk | resource_request | timesheet | expense | schedule_task
  `entity_id`     VARCHAR(40)   DEFAULT NULL,
  `project_id`    INT           DEFAULT NULL,
  `actor_id`      INT           DEFAULT NULL,
  `actor_name`    VARCHAR(150)  DEFAULT NULL,
  `action`        VARCHAR(60)   NOT NULL,           -- created | updated | assigned | approved | rejected | moved | started | completed ...
  `detail`        VARCHAR(500)  DEFAULT NULL,
  `meta`          TEXT          DEFAULT NULL,        -- JSON
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_act_project` (`project_id`, `created_at`),
  KEY `idx_act_entity` (`entity_type`, `entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  3.  TIMESHEETS  —  time tracking (Celoxis "Time")
-- =============================================================================
CREATE TABLE IF NOT EXISTS `timesheets` (
  `id`            INT           NOT NULL AUTO_INCREMENT,
  `resource_id`   INT           NOT NULL,
  `project_id`    INT           DEFAULT NULL,
  `task_id`       INT           DEFAULT NULL,         -- project_schedule.id or boards.board_id
  `task_name`     VARCHAR(255)  DEFAULT NULL,
  `work_date`     DATE          NOT NULL,
  `hours`         DECIMAL(5,2)  NOT NULL DEFAULT 0,
  `billable`      TINYINT(1)    NOT NULL DEFAULT 1,
  `note`          VARCHAR(500)  DEFAULT NULL,
  `status`        VARCHAR(16)   NOT NULL DEFAULT 'draft',  -- draft | submitted | approved | rejected
  `week_start`    DATE          DEFAULT NULL,
  `approver_id`   INT           DEFAULT NULL,
  `decided_at`    DATETIME      DEFAULT NULL,
  `decision_note` VARCHAR(500)  DEFAULT NULL,
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ts_resource` (`resource_id`, `work_date`),
  KEY `idx_ts_project` (`project_id`, `status`),
  KEY `idx_ts_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  4.  EXPENSES  —  cost claims + approval (Celoxis "Expenses")
-- =============================================================================
CREATE TABLE IF NOT EXISTS `expenses` (
  `id`            INT           NOT NULL AUTO_INCREMENT,
  `expense_code`  VARCHAR(30)   DEFAULT NULL,
  `project_id`    INT           DEFAULT NULL,
  `resource_id`   INT           DEFAULT NULL,        -- who claimed
  `category`      VARCHAR(60)   DEFAULT NULL,        -- Travel | Software | Hardware | Other
  `description`   VARCHAR(500)  DEFAULT NULL,
  `amount`        DECIMAL(15,2) NOT NULL DEFAULT 0,
  `currency`      VARCHAR(6)    NOT NULL DEFAULT 'INR',
  `billable`      TINYINT(1)    NOT NULL DEFAULT 0,
  `expense_date`  DATE          DEFAULT NULL,
  `receipt`       VARCHAR(255)  DEFAULT NULL,
  `status`        VARCHAR(16)   NOT NULL DEFAULT 'submitted', -- submitted | approved | rejected | reimbursed
  `approver_id`   INT           DEFAULT NULL,
  `decided_at`    DATETIME      DEFAULT NULL,
  `decision_note` VARCHAR(500)  DEFAULT NULL,
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_exp_project` (`project_id`, `status`),
  KEY `idx_exp_resource` (`resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  5.  PROJECT_SCHEDULE  —  dependencies + baseline + hours (Celoxis "Plan")
-- =============================================================================
CALL xmp_col('project_schedule', 'predecessor_id',   "`predecessor_id` INT DEFAULT NULL");
CALL xmp_col('project_schedule', 'predecessor_type', "`predecessor_type` VARCHAR(4) DEFAULT 'FS'");  -- FS | SS | FF | SF
CALL xmp_col('project_schedule', 'lag_days',         "`lag_days` INT DEFAULT 0");
CALL xmp_col('project_schedule', 'baseline_start',   "`baseline_start` DATE DEFAULT NULL");
CALL xmp_col('project_schedule', 'baseline_end',     "`baseline_end` DATE DEFAULT NULL");
CALL xmp_col('project_schedule', 'planned_hours',    "`planned_hours` DECIMAL(8,2) DEFAULT NULL");
CALL xmp_col('project_schedule', 'actual_hours',     "`actual_hours` DECIMAL(8,2) DEFAULT 0");
CALL xmp_col('project_schedule', 'is_milestone',     "`is_milestone` TINYINT(1) NOT NULL DEFAULT 0");
CALL xmp_col('project_schedule', 'allocation_pct',   "`allocation_pct` DECIMAL(5,2) DEFAULT 100");

-- =============================================================================
--  6.  RISKS  —  probability x impact scoring (Celoxis risk matrix)
-- =============================================================================
CALL xmp_col('risks', 'probability_score', "`probability_score` TINYINT DEFAULT NULL");  -- 1..5
CALL xmp_col('risks', 'impact_score',      "`impact_score` TINYINT DEFAULT NULL");       -- 1..5
CALL xmp_col('risks', 'severity_score',    "`severity_score` TINYINT DEFAULT NULL");     -- prob*impact 1..25
CALL xmp_col('risks', 'severity',          "`severity` VARCHAR(12) DEFAULT NULL");       -- low | medium | high | critical
CALL xmp_col('risks', 'mitigation',        "`mitigation` VARCHAR(1000) DEFAULT NULL");
CALL xmp_col('risks', 'owner_id',          "`owner_id` INT DEFAULT NULL");
CALL xmp_col('risks', 'target_date',       "`target_date` DATE DEFAULT NULL");

-- backfill scores from the existing text values
UPDATE `risks` SET probability_score = CASE LOWER(probability)
    WHEN 'rare' THEN 1 WHEN 'unlikely' THEN 2 WHEN 'possible' THEN 3
    WHEN 'likely' THEN 4 WHEN 'certain' THEN 5 ELSE 3 END
  WHERE probability_score IS NULL;
UPDATE `risks` SET impact_score = CASE LOWER(impact)
    WHEN 'minor' THEN 1 WHEN 'medium' THEN 2 WHEN 'major' THEN 4 WHEN 'severe' THEN 5 ELSE 3 END
  WHERE impact_score IS NULL;
UPDATE `risks` SET severity_score = probability_score * impact_score WHERE severity_score IS NULL;
UPDATE `risks` SET severity = CASE
    WHEN severity_score >= 15 THEN 'critical'
    WHEN severity_score >= 8  THEN 'high'
    WHEN severity_score >= 4  THEN 'medium'
    ELSE 'low' END
  WHERE severity IS NULL;

-- =============================================================================
--  7.  RESOURCES  —  cost / bill rate + capacity (Celoxis resource economics)
-- =============================================================================
CALL xmp_col('resources', 'cost_rate',      "`cost_rate` DECIMAL(10,2) DEFAULT NULL");   -- per hour, internal
CALL xmp_col('resources', 'bill_rate',      "`bill_rate` DECIMAL(10,2) DEFAULT NULL");   -- per hour, to client
CALL xmp_col('resources', 'capacity_hours', "`capacity_hours` DECIMAL(4,1) DEFAULT 8");  -- per working day
CALL xmp_col('resources', 'user_id',        "`user_id` INT DEFAULT NULL");               -- link to users.id (login)

DROP PROCEDURE IF EXISTS `xmp_col`;
SET FOREIGN_KEY_CHECKS = 1;

-- =============================================================================
--  8.  SEED  (demo)  —  users 13=Rahul(PM), 14=Priya(Tester), 3=test(FE dev)
-- =============================================================================

-- 8.1 project phase / progress starter
UPDATE `projects` SET phase = 'Execution' WHERE id = 1 AND (phase IS NULL OR phase = '');
UPDATE `projects` SET phase = 'Planning'  WHERE id = 2 AND (phase IS NULL OR phase = '');

-- 8.2 resource pool — ensure the seed login users exist as resources (Celoxis
--     keeps a resource pool separate from logins; here we mirror the 3 demo users)
INSERT INTO `resources` (`resource_type`, `name`, `role`, `email`, `is_active`, `cost_rate`, `bill_rate`, `capacity_hours`, `user_id`,
                         `monday`,`tuesday`,`wednesday`,`thursday`,`friday`, `start_time`,`end_time`)
SELECT 'inhouse', u.name, u.role, u.email, 1,
       CASE u.role WHEN 'Project Manager' THEN 1800 WHEN 'Tester' THEN 1000 ELSE 1200 END,
       CASE u.role WHEN 'Project Manager' THEN 4500 WHEN 'Tester' THEN 2600 ELSE 3000 END,
       8, u.id, 1,1,1,1,1, '09:00','18:00'
FROM `users` u
WHERE u.id IN (3, 13, 14)
  AND NOT EXISTS (SELECT 1 FROM `resources` r WHERE r.user_id = u.id OR r.email = u.email);

-- link any pre-existing resources to logins by email; default rates for the rest
UPDATE `resources` r JOIN `users` u ON u.email = r.email SET r.user_id = u.id WHERE r.user_id IS NULL;
UPDATE `resources` SET cost_rate = 1200 WHERE cost_rate IS NULL;
UPDATE `resources` SET bill_rate = 3000 WHERE bill_rate IS NULL;
UPDATE `resources` SET capacity_hours = 8 WHERE capacity_hours IS NULL;

-- 8.3 schedule tasks -> planned hours + a dependency chain (project 1)
UPDATE `project_schedule` SET planned_hours = COALESCE(planned_hours, duration * 8), allocation_pct = 100
  WHERE project_id = 1;
UPDATE `project_schedule` s
  JOIN (SELECT id FROM project_schedule WHERE project_id = 1 AND task_name = 'Design Login Screen' LIMIT 1) a
  SET s.predecessor_id = a.id, s.predecessor_type = 'FS'
  WHERE s.project_id = 1 AND s.task_name = 'Fix API Integration';

-- 8.4 timesheets (project 1, this week)
INSERT INTO `timesheets` (`resource_id`, `project_id`, `task_id`, `task_name`, `work_date`, `hours`, `billable`, `note`, `status`, `week_start`, `approver_id`)
SELECT 14, 1, (SELECT id FROM project_schedule WHERE project_id=1 AND task_name='Design Login Screen' LIMIT 1),
       'Design Login Screen', CURDATE() - INTERVAL 1 DAY, 6.0, 1, 'Wireframes + review', 'submitted',
       CURDATE() - INTERVAL WEEKDAY(CURDATE()) DAY, 13
WHERE NOT EXISTS (SELECT 1 FROM timesheets WHERE resource_id=14 AND task_name='Design Login Screen' AND work_date = CURDATE() - INTERVAL 1 DAY);

INSERT INTO `timesheets` (`resource_id`, `project_id`, `task_id`, `task_name`, `work_date`, `hours`, `billable`, `note`, `status`, `week_start`, `approver_id`)
SELECT 3, 1, (SELECT id FROM project_schedule WHERE project_id=1 AND task_name='Fix API Integration' LIMIT 1),
       'Fix API Integration', CURDATE() - INTERVAL 1 DAY, 7.5, 1, 'JWT refresh flow', 'approved',
       CURDATE() - INTERVAL WEEKDAY(CURDATE()) DAY, 13
WHERE NOT EXISTS (SELECT 1 FROM timesheets WHERE resource_id=3 AND task_name='Fix API Integration' AND work_date = CURDATE() - INTERVAL 1 DAY);

-- 8.5 expenses
INSERT INTO `expenses` (`expense_code`, `project_id`, `resource_id`, `category`, `description`, `amount`, `billable`, `expense_date`, `status`)
SELECT 'EXP-2026001', 1, 14, 'Software', 'Figma team seat', 4500, 0, CURDATE() - INTERVAL 5 DAY, 'submitted'
WHERE NOT EXISTS (SELECT 1 FROM expenses WHERE expense_code = 'EXP-2026001');
INSERT INTO `expenses` (`expense_code`, `project_id`, `resource_id`, `category`, `description`, `amount`, `billable`, `expense_date`, `status`, `approver_id`, `decided_at`)
SELECT 'EXP-2026002', 1, 3, 'Travel', 'Client kickoff — cab', 1200, 1, CURDATE() - INTERVAL 8 DAY, 'approved', 13, NOW()
WHERE NOT EXISTS (SELECT 1 FROM expenses WHERE expense_code = 'EXP-2026002');

-- 8.6 risk scoring already backfilled above; add mitigation text
UPDATE `risks` SET mitigation = 'Add integration tests + staging soak before release', owner_id = 13
  WHERE project_id = 1 AND (mitigation IS NULL OR mitigation = '');

-- 8.7 seed a few activity rows
INSERT INTO `activity_log` (`entity_type`, `entity_id`, `project_id`, `actor_id`, `actor_name`, `action`, `detail`) VALUES
  ('project', '1', 1, 12, 'PMO Admin',    'assigned',  'Assigned Rahul Sharma as Project Manager'),
  ('project', '1', 1, 13, 'Rahul Sharma', 'accepted',  'PM accepted the project'),
  ('sprint',  '1', 1, 13, 'Rahul Sharma', 'started',   'Started "ERP Sprint 1"'),
  ('timesheet','1',1, 3,  'test',         'submitted', 'Logged 7.5h on Fix API Integration');

-- =============================================================================
--  END
-- =============================================================================
