-- =============================================================================
--  XMP / WorKXKloud (djwork_v2)  —  USER / RESOURCE SECTION  —  DATABASE SETUP
-- -----------------------------------------------------------------------------
--  Ye file "user" (resource / tester / developer) section ke saare pages ko
--  LIVE karne ke liye tables banati hai:
--
--    - src/pages/MyTasksPage.jsx            (For You — mere saare projects)
--    - src/pages/MyTaskProjectDetailPage.jsx(Summary / List / Project Status / Board / Discussions)
--    - src/pages/RiskPage.jsx               (Risk register)
--    - src/components/notifications/*       (bell icon panel)
--    - src/components/projects/ProjectBoardSection.jsx   (Kanban board)
--    - src/components/projects/ProjectDiscussionSection.jsx
--
--  Server        : MySQL 8.0.x       Database : xmp_db
--  Safe to re-run: YES (idempotent — CREATE TABLE IF NOT EXISTS + guarded ALTER)
--
--  RUN:  mysql -u root xmp_db < db_bkp/xmp_db_user_module.sql
--
--  NOTE: pehle db_bkp/xmp_db_pm_pmo_module.sql chala lena (ye usi ke upar banta
--        hai — sub_projects / boards / project_discussions kuch tables share hote).
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
--  helper — column add karo sirf agar exist na kare
-- -----------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS `xmp_add_col2`;
DELIMITER $$
CREATE PROCEDURE `xmp_add_col2`(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(1024))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @s = CONCAT('ALTER TABLE `', t, '` ADD COLUMN ', ddl);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$
DELIMITER ;

-- =============================================================================
--  1.  PROJECT SCHEDULE  (Gantt tasks + subtasks)
-- -----------------------------------------------------------------------------
--  Ye ek hi table top-level task aur subtask dono rakhta hai:
--     parent_id IS NULL  -> top-level task   (type = 'project')
--     parent_id set       -> subtask          (type = 'subproject')
--
--  Endpoints:
--    POST /api/projectManager/get_project_schedule  { project_id, pm_id }
--         -> { success, data: [ { id, task_name, ... } ] }
--    POST /api/users/get_userProjectList            { resource }
--         -> ye table + projects se flat rows (jinme resource_id = logged-in user)
-- =============================================================================
CREATE TABLE IF NOT EXISTS `project_schedule` (
  `id`             INT           NOT NULL AUTO_INCREMENT,
  `project_id`     INT           NOT NULL,
  `parent_id`      INT           DEFAULT NULL,                 -- NULL = task, set = subtask
  `type`           VARCHAR(20)   NOT NULL DEFAULT 'project',   -- 'project' | 'subproject'
  `task_name`      VARCHAR(255)  NOT NULL,
  `sub_project_name` VARCHAR(255) DEFAULT NULL,                -- subtask ka display name
  `description`    TEXT          DEFAULT NULL,
  `resource_id`    INT           DEFAULT NULL,                 -- assigned resource (users.id)
  `pm_id`          INT           DEFAULT NULL,
  `predecessor`    VARCHAR(100)  DEFAULT NULL,
  `planned_start`  DATE          DEFAULT NULL,
  `planned_end`    DATE          DEFAULT NULL,
  `duration`       INT           DEFAULT NULL,
  `progress`       DECIMAL(5,2)  DEFAULT 0,
  `priority`       VARCHAR(20)   DEFAULT NULL,
  `status`         VARCHAR(50)   DEFAULT NULL,
  `sort_order`     INT           NOT NULL DEFAULT 0,
  `is_active`      TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sched_project` (`project_id`),
  KEY `idx_sched_resource` (`resource_id`),
  KEY `idx_sched_parent` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  2.  BOARDS  (Kanban cards)  —  djwork_v2 shape
-- -----------------------------------------------------------------------------
--  getBoard cards ko in 5 status keys me group karta hai:
--     in_discussion | to_do | in_work | in_progress | completed
--
--  Endpoints:
--    POST /api/projectManager/getBoard    { pm_id, project_id }
--    POST /api/users/create_board         { project_id, task_id, status, resource_id, pm_id }
--    POST /api/users/editBoard            { id, project_id, task_id, resource_id, status, pm_id, title?, priority?, due_date?, description? }
--    POST /api/users/deleteBoard          { id }
-- =============================================================================
CREATE TABLE IF NOT EXISTS `boards` (
  `board_id`      INT           NOT NULL AUTO_INCREMENT,
  `project_id`    INT           DEFAULT NULL,
  `task_id`       INT           DEFAULT NULL,               -- project_schedule.id
  `sub_project_id` INT          DEFAULT NULL,
  `pm_id`         INT           DEFAULT NULL,
  `resource_id`   INT           DEFAULT NULL,
  `title`         VARCHAR(255)  DEFAULT NULL,               -- editBoard se aata hai; warna schedule task name
  `description`   TEXT          DEFAULT NULL,
  `priority`      VARCHAR(20)   DEFAULT NULL,
  `status`        VARCHAR(50)   NOT NULL DEFAULT 'to_do',   -- in_discussion|to_do|in_work|in_progress|completed
  `due_date`      DATE          DEFAULT NULL,
  `attachments`   VARCHAR(255)  DEFAULT NULL,
  `sort_order`    INT           NOT NULL DEFAULT 0,
  `is_active`     TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`board_id`),
  KEY `idx_boards_project` (`project_id`),
  KEY `idx_boards_resource` (`resource_id`),
  KEY `idx_boards_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- boards agar pehle pm_pmo module se bani thi to naye columns add kar do
CALL xmp_add_col2('boards', 'task_id',       "`task_id` INT DEFAULT NULL AFTER `project_id`");
CALL xmp_add_col2('boards', 'attachments',   "`attachments` VARCHAR(255) DEFAULT NULL");
CALL xmp_add_col2('boards', 'due_date',      "`due_date` DATE DEFAULT NULL");

-- =============================================================================
--  3.  BOARD STATUS  (per-project custom Kanban columns)
-- -----------------------------------------------------------------------------
--  Endpoints (POST /api/projectManager/...):
--    saveBoardStatus  { project_id, pm_id, status_name }  ya { ..., statuses:[...] }
--    getBoardStatus   { project_id, pm_id }
--    editBoardStatus  { id, status_name }
--    deleteBoardStatus{ id }
-- =============================================================================
CREATE TABLE IF NOT EXISTS `board_status` (
  `id`           INT          NOT NULL AUTO_INCREMENT,
  `project_id`   INT          NOT NULL,
  `pm_id`        INT          DEFAULT NULL,
  `status_name`  VARCHAR(100) NOT NULL,
  `status_key`   VARCHAR(100) NOT NULL,
  `sort_order`   INT          NOT NULL DEFAULT 0,
  `wip_limit`    INT          DEFAULT NULL,
  `is_default`   TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_board_status` (`project_id`, `status_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  4.  NOTIFICATIONS  (bell icon panel)
-- -----------------------------------------------------------------------------
--  Endpoints (/api/users/...):
--    GET    /get_notifications              -> { notifications: [...] }   (?user_id= optional)
--    POST   /mark_notification_read         { id }
--    POST   /mark_all_notifications_read    { user_id? }
--    DELETE /clear_all_notifications        { user_id? }
--    POST   /delete_notification            { id }
--
--  Frontend keys: id, type, title, message, projectName, projectId, time, read
-- =============================================================================
CREATE TABLE IF NOT EXISTS `notifications` (
  `id`           INT           NOT NULL AUTO_INCREMENT,
  `user_id`      INT           DEFAULT NULL,               -- NULL = broadcast (sabko)
  `type`         VARCHAR(50)   NOT NULL DEFAULT 'SYSTEM_MAINTENANCE',
  `title`        VARCHAR(255)  NOT NULL,
  `message`      TEXT          DEFAULT NULL,
  `project_id`   VARCHAR(50)   DEFAULT NULL,
  `project_name` VARCHAR(255)  DEFAULT NULL,
  `is_read`      TINYINT(1)    NOT NULL DEFAULT 0,
  `is_cleared`   TINYINT(1)    NOT NULL DEFAULT 0,
  `created_at`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notif_user` (`user_id`, `is_cleared`, `is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  5.  RISKS  (Risk register — RiskPage.jsx)
-- -----------------------------------------------------------------------------
--  Endpoints (/api/users/...):
--    GET  /get_risks?project_id=&resource_id=
--    POST /create_risk   { project_id, task_name, due_date, state, impact, probability, resource_id }
--    POST /update_risk   { id, ...fields }
--    POST /delete_risk   { id }  ya { ids: [1,2,3] }
--
--  Frontend keys: id, projectId, taskName, dueDate, state, impact, probability
-- =============================================================================
CREATE TABLE IF NOT EXISTS `risks` (
  `id`           INT           NOT NULL AUTO_INCREMENT,
  `project_id`   INT           DEFAULT NULL,
  `resource_id`  INT           DEFAULT NULL,               -- kisne add kiya
  `task_name`    VARCHAR(255)  NOT NULL,
  `due_date`     VARCHAR(100)  DEFAULT NULL,               -- UI label as-is ("24-Feb-26 / Today")
  `state`        VARCHAR(50)   NOT NULL DEFAULT 'Identified',
  `impact`       VARCHAR(50)   NOT NULL DEFAULT 'Medium',
  `probability`  VARCHAR(50)   NOT NULL DEFAULT 'Likely',
  `is_active`    TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_risks_project` (`project_id`),
  KEY `idx_risks_resource` (`resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  6.  PROJECT DISCUSSIONS  (agar pm_pmo module se nahi bani)
-- =============================================================================
CREATE TABLE IF NOT EXISTS `project_discussions` (
  `discussion_id`             INT           NOT NULL AUTO_INCREMENT,
  `project_id`                INT           DEFAULT NULL,
  `project_name`              VARCHAR(255)  DEFAULT NULL,
  `project_scope`             TEXT          DEFAULT NULL,
  `resource_id`               INT           DEFAULT NULL,
  `type`                      VARCHAR(50)   DEFAULT NULL,
  `created_by`                INT           DEFAULT NULL,
  `sender_name`               VARCHAR(150)  DEFAULT NULL,
  `upload_personal_document`  VARCHAR(255)  DEFAULT NULL,
  `start_date`                DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `is_active`                 TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at`                DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`discussion_id`),
  KEY `idx_disc_project` (`project_id`),
  KEY `idx_disc_resource` (`resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP PROCEDURE IF EXISTS `xmp_add_col2`;
SET FOREIGN_KEY_CHECKS = 1;

-- =============================================================================
--  7.  SEED DATA  (demo — production me hata dena)
--  users.id = 3 ko 'testResource' (tester) maan ke, projects.id 1 par tasks.
-- =============================================================================
INSERT INTO `project_schedule` (`project_id`, `parent_id`, `type`, `task_name`, `resource_id`, `pm_id`, `planned_start`, `planned_end`, `priority`, `status`)
SELECT 1, NULL, 'project', 'Design Login Screen', 3, 1, '2026-08-21', '2026-08-27', 'High', 'in_progress'
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule` WHERE `project_id` = 1 AND `task_name` = 'Design Login Screen');

INSERT INTO `project_schedule` (`project_id`, `parent_id`, `type`, `task_name`, `resource_id`, `pm_id`, `planned_start`, `planned_end`, `priority`, `status`)
SELECT 1, NULL, 'project', 'Fix API Integration', 3, 1, '2026-08-18', '2026-08-25', 'Medium', 'to_do'
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule` WHERE `project_id` = 1 AND `task_name` = 'Fix API Integration');

INSERT INTO `project_schedule` (`project_id`, `parent_id`, `type`, `task_name`, `sub_project_name`, `resource_id`, `pm_id`, `planned_start`, `planned_end`)
SELECT 1,
       (SELECT id FROM (SELECT id FROM project_schedule WHERE project_id = 1 AND task_name = 'Design Login Screen' LIMIT 1) x),
       'subproject', 'Design Login Screen', 'Build form validation', 3, 1, '2026-08-22', '2026-08-24'
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule` WHERE `project_id` = 1 AND `sub_project_name` = 'Build form validation');

INSERT INTO `boards` (`project_id`, `task_id`, `pm_id`, `resource_id`, `title`, `priority`, `status`, `due_date`)
SELECT 1,
       (SELECT id FROM (SELECT id FROM project_schedule WHERE project_id = 1 AND task_name = 'Design Login Screen' LIMIT 1) x),
       1, 3, 'Design Login Screen', 'High', 'in_progress', '2026-08-27'
WHERE NOT EXISTS (SELECT 1 FROM `boards` WHERE `project_id` = 1 AND `title` = 'Design Login Screen');

INSERT INTO `board_status` (`project_id`, `pm_id`, `status_name`, `status_key`, `sort_order`, `is_default`) VALUES
  (1, 1, 'In Discussion', 'in_discussion', 1, 1),
  (1, 1, 'To Do',         'to_do',         2, 1),
  (1, 1, 'In Work',       'in_work',       3, 1),
  (1, 1, 'In Progress',   'in_progress',   4, 1),
  (1, 1, 'Completed',     'completed',     5, 1)
ON DUPLICATE KEY UPDATE `sort_order` = VALUES(`sort_order`);

INSERT INTO `notifications` (`user_id`, `type`, `title`, `message`, `project_id`, `project_name`, `is_read`) VALUES
  (3, 'TASK_ASSIGNED', 'Task assigned to you', 'You have been assigned "Design Login Screen".', '1', 'ERP System Updated', 0),
  (3, 'DEADLINE_REMINDER', 'Upcoming deadline', 'Task "Fix API Integration" is due soon.', '1', 'ERP System Updated', 0),
  (NULL, 'SYSTEM_MAINTENANCE', 'System maintenance', 'Scheduled maintenance this weekend.', NULL, NULL, 0);

INSERT INTO `risks` (`project_id`, `resource_id`, `task_name`, `due_date`, `state`, `impact`, `probability`)
SELECT 1, 3, 'Design Login Screen', '27-Aug-26 / Deadline', 'Identified', 'Major', 'Rare'
WHERE NOT EXISTS (SELECT 1 FROM `risks` WHERE `project_id` = 1 AND `task_name` = 'Design Login Screen');

-- =============================================================================
--  END
-- =============================================================================
