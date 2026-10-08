-- =============================================================================
--  XMP  —  BACKLOG + BOARD  (Jira-style)  —  DATABASE SETUP
-- -----------------------------------------------------------------------------
--  Jira jaisa model:
--    * `boards`  = issues (story / task / bug / epic / subtask), har ek ka
--                  item_key (ERP-1), type, priority, story_points, rank_order.
--    * `sprints` = time-boxed iteration. state: future | active | closed.
--    * BACKLOG   = issues jinka  sprint_id IS NULL.
--    * BOARD     = ACTIVE sprint ke issues, status columns me grouped.
--
--  Move backlog -> board  = issue ko active sprint me daalna (sprint_id set).
--  Move board  -> backlog = sprint_id = NULL.
--  Drag between columns   = status change.
--  Reorder                = rank_order change (midpoint ranking).
--
--  RUN (baaki SQL files ke baad):
--     mysql -u root xmp_db < db_bkp/xmp_db_backlog_board_module.sql
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP PROCEDURE IF EXISTS `xmp_add_col3`;
DELIMITER $$
CREATE PROCEDURE `xmp_add_col3`(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(1024))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @s = CONCAT('ALTER TABLE `', t, '` ADD COLUMN ', ddl);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$
DELIMITER ;

-- =============================================================================
--  1.  SPRINTS
-- =============================================================================
CREATE TABLE IF NOT EXISTS `sprints` (
  `id`            INT           NOT NULL AUTO_INCREMENT,
  `project_id`    INT           NOT NULL,
  `name`          VARCHAR(120)  NOT NULL,
  `goal`          VARCHAR(500)  DEFAULT NULL,
  `state`         VARCHAR(12)   NOT NULL DEFAULT 'future',   -- future | active | closed
  `start_date`    DATE          DEFAULT NULL,
  `end_date`      DATE          DEFAULT NULL,
  `sort_order`    INT           NOT NULL DEFAULT 0,
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at`  DATETIME      DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sprint_project` (`project_id`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  2.  BOARDS (issues)  —  naye Jira columns
-- =============================================================================
CALL xmp_add_col3('boards', 'item_key',     "`item_key` VARCHAR(24) DEFAULT NULL AFTER `board_id`");
CALL xmp_add_col3('boards', 'type',         "`type` VARCHAR(16) NOT NULL DEFAULT 'task' AFTER `item_key`");
CALL xmp_add_col3('boards', 'story_points', "`story_points` DECIMAL(6,1) DEFAULT NULL");
CALL xmp_add_col3('boards', 'sprint_id',    "`sprint_id` INT DEFAULT NULL");
CALL xmp_add_col3('boards', 'epic_id',      "`epic_id` INT DEFAULT NULL");
CALL xmp_add_col3('boards', 'parent_id',    "`parent_id` INT DEFAULT NULL");
CALL xmp_add_col3('boards', 'reporter_id',  "`reporter_id` INT DEFAULT NULL");
CALL xmp_add_col3('boards', 'labels',       "`labels` TEXT DEFAULT NULL");
CALL xmp_add_col3('boards', 'rank_order',   "`rank_order` BIGINT NOT NULL DEFAULT 0");
CALL xmp_add_col3('boards', 'resolved_at',  "`resolved_at` DATETIME DEFAULT NULL");
CALL xmp_add_col3('boards', 'task_id',      "`task_id` INT DEFAULT NULL");
CALL xmp_add_col3('boards', 'due_date',     "`due_date` DATE DEFAULT NULL");
CALL xmp_add_col3('boards', 'title',        "`title` VARCHAR(255) DEFAULT NULL");

-- priority NOT NULL / DEFAULT 'Medium' (purani pm_pmo wali table me NOT NULL thi
-- aur controller null bhej raha tha -> 500). Ensure a sane default + backfill.
UPDATE `boards` SET `priority` = 'Medium' WHERE `priority` IS NULL OR `priority` = '';
ALTER TABLE `boards` MODIFY COLUMN `priority` VARCHAR(20) NOT NULL DEFAULT 'Medium';

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'boards' AND INDEX_NAME = 'idx_boards_sprint');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `boards` ADD INDEX `idx_boards_sprint` (`sprint_id`, `status`, `rank_order`)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

DROP PROCEDURE IF EXISTS `xmp_add_col3`;
SET FOREIGN_KEY_CHECKS = 1;

-- =============================================================================
--  3.  SEED  —  project 1 (ERP System Updated)  ke liye realistic Jira data
--     users: 13=PM(Rahul), 14=Priya(Tester), 3=test(Frontend Dev)
-- =============================================================================

-- ── purana demo board data hata do (fresh Jira seed) ──
DELETE FROM `boards` WHERE `project_id` = 1;
DELETE FROM `sprints` WHERE `project_id` = 1;

-- ── Sprints ──
INSERT INTO `sprints` (`id`, `project_id`, `name`, `goal`, `state`, `start_date`, `end_date`, `sort_order`) VALUES
  (1, 1, 'ERP Sprint 1', 'Auth module + project setup', 'active',  '2026-08-18', '2026-09-01', 1),
  (2, 1, 'ERP Sprint 2', 'Reporting + dashboards',       'future',  NULL,          NULL,         2);

-- ── Epics (pehle) ──
INSERT INTO `boards` (`project_id`, `item_key`, `type`, `title`, `description`, `priority`, `status`, `sprint_id`, `pm_id`, `reporter_id`, `rank_order`) VALUES
  (1, 'ERP-1', 'epic', 'Authentication & Access Control', 'Login, roles, permissions', 'High',   'to_do', NULL, 13, 13, 1000),
  (1, 'ERP-2', 'epic', 'Reporting & Dashboards',          'Finance + HR reports',      'Medium', 'to_do', NULL, 13, 13, 2000);

-- epic ids variables me (INSERT..SELECT FROM boards allowed nahi hai)
SET @erp1 := (SELECT board_id FROM boards WHERE project_id = 1 AND item_key = 'ERP-1' LIMIT 1);
SET @erp2 := (SELECT board_id FROM boards WHERE project_id = 1 AND item_key = 'ERP-2' LIMIT 1);

-- ── ACTIVE sprint (id 1) ke issues — board par dikhenge ──
INSERT INTO `boards`
  (`project_id`, `item_key`, `type`, `title`, `description`, `priority`, `status`, `sprint_id`, `epic_id`, `resource_id`, `pm_id`, `reporter_id`, `story_points`, `due_date`, `rank_order`) VALUES
  (1, 'ERP-3', 'story', 'Design Login Screen',        'Wireframe + hi-fi',      'High',   'in_progress', 1, @erp1, 14,   13, 13, 5, '2026-08-27', 3000),
  (1, 'ERP-4', 'task',  'Wire login API',             'JWT issue + refresh',    'High',   'to_do',       1, @erp1, 3,    13, 13, 3, '2026-08-29', 4000),
  (1, 'ERP-5', 'bug',   'Session expiry not handled', 'Redirect to login',     'Medium', 'in_work',     1, @erp1, 14,   13, 13, 2, '2026-08-25', 5000),
  (1, 'ERP-6', 'task',  'Project scaffolding',        'Repo, CI, lint',        'Low',    'completed',   1, NULL,  3,    13, 13, 2, '2026-08-20', 6000),
  (1, 'ERP-7', 'story', 'Role-based menu',            'Sidebar per role',      'Medium', 'to_do',       1, @erp1, NULL, 13, 13, 3, NULL,         7000);

-- ── BACKLOG issues (sprint_id NULL) ──
INSERT INTO `boards`
  (`project_id`, `item_key`, `type`, `title`, `description`, `priority`, `status`, `sprint_id`, `epic_id`, `resource_id`, `pm_id`, `reporter_id`, `story_points`, `rank_order`) VALUES
  (1, 'ERP-8',  'story', 'Finance report export (PDF/Excel)', 'Server-side render', 'High',   'to_do', NULL, @erp2, NULL, 13, 13, 8,  8000),
  (1, 'ERP-9',  'story', 'HR headcount dashboard',            'Charts + filters',  'Medium', 'to_do', NULL, @erp2, 14,   13, 13, 5,  9000),
  (1, 'ERP-10', 'task',  'Add audit log table',               'Track all writes',  'Medium', 'to_do', NULL, NULL,  NULL, 13, 13, 3,  10000),
  (1, 'ERP-11', 'bug',   'Date picker off-by-one (UTC)',       'Local vs UTC',      'High',   'to_do', NULL, NULL,  3,    13, 13, 2,  11000),
  (1, 'ERP-12', 'task',  'Rate-limit login endpoint',          'express-rate-limit','Medium', 'to_do', NULL, @erp1, NULL, 13, 13, 2,  12000),
  (1, 'ERP-13', 'story', 'Forgot-password email flow',         'OTP via email',     'Low',    'to_do', NULL, @erp1, NULL, 13, 13, 3,  13000),
  (1, 'ERP-14', 'task',  'Seed demo data script',              'Idempotent',        'Low',    'to_do', NULL, NULL,  NULL, 13, 13, 1,  14000),
  (1, 'ERP-15', 'story', 'Export dashboard as image',          'html2canvas',       'Low',    'to_do', NULL, @erp2, NULL, 13, 13, 3,  15000);

-- ── board_status columns (agar nahi bani) ──
INSERT INTO `board_status` (`project_id`, `pm_id`, `status_name`, `status_key`, `sort_order`, `is_default`) VALUES
  (1, 13, 'In Discussion', 'in_discussion', 1, 1),
  (1, 13, 'To Do',         'to_do',         2, 1),
  (1, 13, 'In Work',       'in_work',       3, 1),
  (1, 13, 'In Progress',   'in_progress',   4, 1),
  (1, 13, 'Completed',     'completed',     5, 1)
ON DUPLICATE KEY UPDATE `sort_order` = VALUES(`sort_order`);

-- =============================================================================
--  END
-- =============================================================================
