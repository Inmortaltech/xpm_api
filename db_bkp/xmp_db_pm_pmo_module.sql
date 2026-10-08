-- =============================================================================
--  XMP / WorKXKloud  —  PM & PMO MODULE  —  DATABASE SETUP
-- -----------------------------------------------------------------------------
--  Ye file PM (Project Manager) aur PMO (Project Allocation) section ke
--  saare features ko LIVE karne ke liye zaroori tables / columns banati hai.
--
--  Frontend pages jinke liye ye banayi gayi hai:
--    - src/pages/NewAssignedProjectPage.jsx   (PM: accept / decline / required resource)
--    - src/pages/MyProjectsPage.jsx           (PM: overview, board, backlog, discussion)
--    - src/pages/CreateProjectPage.jsx        (PMO: assign PM / re-allocate / denied history)
--    - src/components/projects/ProjectBoardSection.jsx
--    - src/components/projects/ProjectBacklogsSection.jsx
--    - src/components/projects/ProjectDiscussionSection.jsx
--
--  Server            : MySQL 8.0.x
--  Database          : xmp_db
--  Safe to re-run    : YES (idempotent — column add ke liye stored proc use hota hai)
--
--  RUN:
--    mysql -u root xmp_db < db_bkp/xmp_db_pm_pmo_module.sql
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
--  0.  HELPER  —  column ko sirf tab add karo jab woh exist na kare
--     (MySQL 8 me "ALTER TABLE ... ADD COLUMN IF NOT EXISTS" nahi hota,
--      isliye ye chhota stored procedure use kar rahe hain)
-- -----------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS `xmp_add_column`;
DELIMITER $$
CREATE PROCEDURE `xmp_add_column`(
  IN in_table  VARCHAR(64),
  IN in_column VARCHAR(64),
  IN in_ddl    VARCHAR(1024)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = in_table
      AND COLUMN_NAME  = in_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', in_table, '` ADD COLUMN ', in_ddl);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- =============================================================================
--  1.  PROJECTS TABLE  —  PM WORKFLOW KE LIYE NAYE COLUMNS
-- -----------------------------------------------------------------------------
--  request_status : PM ne project accept kiya ya decline
--                   ( NULL / 'Pending' / 'Accept' / 'Declined' )
--  decline_reason : agar PM ne decline kiya to uska reason
--  project_manager_id : users.id  (abhi sirf naam string save hota hai — id se
--                       filtering fast + reliable hoti hai)
--  technical_lead / technology / methodology / resource_allocations :
--                       Create-Project wizard bhejta hai lekin backup me
--                       ye columns missing the.
-- =============================================================================
CALL xmp_add_column('projects', 'methodology',          "`methodology` VARCHAR(50) DEFAULT NULL AFTER `priority`");
CALL xmp_add_column('projects', 'technical_lead',        "`technical_lead` VARCHAR(255) DEFAULT NULL AFTER `project_manager`");
CALL xmp_add_column('projects', 'technology',            "`technology` VARCHAR(255) DEFAULT NULL AFTER `technical_lead`");
CALL xmp_add_column('projects', 'project_manager_id',    "`project_manager_id` INT DEFAULT NULL AFTER `project_manager`");
CALL xmp_add_column('projects', 'technical_lead_id',     "`technical_lead_id` INT DEFAULT NULL AFTER `technical_lead`");
CALL xmp_add_column('projects', 'request_status',        "`request_status` VARCHAR(30) DEFAULT NULL AFTER `status`");
CALL xmp_add_column('projects', 'decline_reason',        "`decline_reason` TEXT DEFAULT NULL AFTER `request_status`");
CALL xmp_add_column('projects', 'pm_responded_at',       "`pm_responded_at` DATETIME DEFAULT NULL AFTER `decline_reason`");
CALL xmp_add_column('projects', 'assigned_at',           "`assigned_at` DATETIME DEFAULT NULL AFTER `pm_responded_at`");
CALL xmp_add_column('projects', 'resource_allocations',  "`resource_allocations` LONGTEXT DEFAULT NULL");

-- Index for "get projects by PM"
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projects'
               AND INDEX_NAME = 'idx_projects_pm');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `projects` ADD INDEX `idx_projects_pm` (`project_manager_id`, `request_status`)',
  'SELECT "idx_projects_pm already exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- =============================================================================
--  2.  SUB PROJECTS  (a.k.a. "phases" / board task groups)
-- -----------------------------------------------------------------------------
--  Board cards ek sub-project / phase se belong karte hain. Agar aap phases
--  use nahi karte to board.sub_project_id NULL rakh sakte ho.
-- =============================================================================
CREATE TABLE IF NOT EXISTS `sub_projects` (
  `id`               INT           NOT NULL AUTO_INCREMENT,
  `project_id`       INT           NOT NULL,
  `name`             VARCHAR(255)  NOT NULL,
  `description`      TEXT          DEFAULT NULL,
  `planned_start`    DATE          DEFAULT NULL,
  `planned_end`      DATE          DEFAULT NULL,
  `status`           VARCHAR(50)   DEFAULT 'To Do',
  `sort_order`       INT           DEFAULT 0,
  `is_active`        TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sub_projects_project` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  3.  REQUIRED RESOURCES
-- -----------------------------------------------------------------------------
--  Jab PM project accept karte waqt "additional resource" maangta hai
--  (NewAssignedProjectPage → Add Required Resource modal).
--  Endpoint: POST /api/projectManager/create_requiredResource
--  Body    : { pm_id, project_id, resources_id, role, required_resource, status }
-- =============================================================================
CREATE TABLE IF NOT EXISTS `required_resources` (
  `id`                INT           NOT NULL AUTO_INCREMENT,
  `project_id`        INT           NOT NULL,
  `pm_id`             INT           DEFAULT NULL,
  `resources_id`      INT           DEFAULT NULL,
  `role`              VARCHAR(150)  NOT NULL,
  `required_resource` INT           NOT NULL DEFAULT 0,
  `current_resource`  INT           NOT NULL DEFAULT 0,
  `status`            VARCHAR(30)   NOT NULL DEFAULT 'pending',  -- pending / approved / rejected / fulfilled
  `remark`            VARCHAR(255)  DEFAULT NULL,
  `created_at`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_reqres_project` (`project_id`),
  KEY `idx_reqres_pm` (`pm_id`),
  KEY `idx_reqres_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  4.  BOARDS  (Kanban tasks)
-- -----------------------------------------------------------------------------
--  My Projects → "Board" tab  aur  "Backlogs" tab dono isi table se chalte hain.
--
--  Endpoints (POST /api/users/...):
--     get_BoardsByResource : { resource_id, type, project_id }
--     create_board         : { project_id, sub_project_id, status, resource_id, pm_id, title }
--     update_board         : { board_id, <field>: value }   field ∈ title|priority|due_date|resource_id|description
--     update_boardStatus   : { board_id, status }
--     delete_board          : { board_id }
--  Backlog (POST /api/projectManager/get_pmBacklog) : { pm_id }
--
--  Frontend jo keys padhta hai:
--     board_id, sub_project_name (card title), project_name, project_id,
--     priority, assignee_avatar, due_date, status, resource_id, resource_name,
--     resource_role, planned_end
-- =============================================================================
CREATE TABLE IF NOT EXISTS `boards` (
  `board_id`          INT           NOT NULL AUTO_INCREMENT,
  `project_id`        INT           DEFAULT NULL,
  `sub_project_id`    INT           DEFAULT NULL,
  `pm_id`             INT           DEFAULT NULL,
  `resource_id`       INT           DEFAULT NULL,
  `title`             VARCHAR(255)  NOT NULL,             -- UI: sub_project_name
  `description`       TEXT          DEFAULT NULL,
  `priority`          VARCHAR(20)   NOT NULL DEFAULT 'Medium',   -- High / Medium / Low
  `status`            VARCHAR(50)   NOT NULL DEFAULT 'To Do',    -- To Do / In Progress / Review / Completed / <custom>
  `due_date`          DATE          DEFAULT NULL,
  `planned_start`     DATE          DEFAULT NULL,
  `planned_end`       DATE          DEFAULT NULL,
  `sort_order`        INT           NOT NULL DEFAULT 0,
  `is_active`         TINYINT(1)    NOT NULL DEFAULT 1,
  `created_by`        INT           DEFAULT NULL,
  `created_at`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`board_id`),
  KEY `idx_boards_project` (`project_id`),
  KEY `idx_boards_resource` (`resource_id`),
  KEY `idx_boards_pm` (`pm_id`),
  KEY `idx_boards_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  5.  BOARD COLUMNS  (per-project custom Kanban columns + WIP limit)
-- -----------------------------------------------------------------------------
--  Optional — frontend abhi localStorage me rakhta hai. Multi-user ke liye:
-- =============================================================================
CREATE TABLE IF NOT EXISTS `board_columns` (
  `id`           INT          NOT NULL AUTO_INCREMENT,
  `project_id`   INT          NOT NULL,
  `title`        VARCHAR(100) NOT NULL,
  `sort_order`   INT          NOT NULL DEFAULT 0,
  `wip_limit`    INT          DEFAULT NULL,
  `is_default`   TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_board_col` (`project_id`, `title`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  6.  PROJECT DISCUSSIONS
-- -----------------------------------------------------------------------------
--  My Projects → "Discussion" tab.
--  Endpoint: POST /api/users/get_userDiscussion   (FormData: resource_id, type)
--
--  Frontend jo keys padhta hai:
--     discussion_id, project_name (subject), project_scope (message body,
--     newline-separated bullets), start_date (last post), upload_personal_document
-- =============================================================================
CREATE TABLE IF NOT EXISTS `project_discussions` (
  `discussion_id`             INT           NOT NULL AUTO_INCREMENT,
  `project_id`                INT           DEFAULT NULL,
  `project_name`              VARCHAR(255)  DEFAULT NULL,   -- UI subject
  `project_scope`             TEXT          DEFAULT NULL,   -- UI message (\n = new bullet)
  `resource_id`               INT           DEFAULT NULL,   -- kis resource/PM ko dikhani hai
  `type`                      VARCHAR(50)   DEFAULT NULL,   -- role / user_type
  `created_by`                INT           DEFAULT NULL,
  `sender_name`               VARCHAR(150)  DEFAULT NULL,
  `upload_personal_document`  VARCHAR(255)  DEFAULT NULL,   -- attachment filename/url
  `start_date`                DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- last post on
  `is_active`                 TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at`                DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`discussion_id`),
  KEY `idx_disc_project` (`project_id`),
  KEY `idx_disc_resource` (`resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  7.  PROJECT ↔ PM HISTORY / AUDIT TRAIL
-- -----------------------------------------------------------------------------
--  Har baar jab PMO PM assign / re-allocate kare, aur jab PM accept / decline
--  kare — ek row yahan. "Denied PM History" modal (CreateProjectPage) isi se.
--
--  Endpoints jo isme likhte hain:
--     POST /api/projectManager/assign_project
--     POST /api/projectManager/project_approvalBYPM
--     POST /api/admin/re-allocated
--  Endpoint jo isse padhta hai:
--     GET  /api/projectManager/denied_pm_history
-- =============================================================================
CREATE TABLE IF NOT EXISTS `project_pm_history` (
  `id`                  INT           NOT NULL AUTO_INCREMENT,
  `project_id`          INT           NOT NULL,
  `project_name`        VARCHAR(255)  DEFAULT NULL,
  `action`              VARCHAR(30)   NOT NULL,          -- assigned / re-allocated / accepted / declined
  `pm_id`               INT           DEFAULT NULL,      -- jis PM par action hua
  `pm_name`             VARCHAR(150)  DEFAULT NULL,
  `previous_pm_id`      INT           DEFAULT NULL,
  `previous_pm_name`    VARCHAR(150)  DEFAULT NULL,
  `reassigned_to_id`    INT           DEFAULT NULL,
  `reassigned_to_name`  VARCHAR(150)  DEFAULT NULL,
  `reason`              TEXT          DEFAULT NULL,       -- decline / re-allocation reason
  `performed_by`        INT           DEFAULT NULL,      -- kis user ne kiya (PMO / PM)
  `created_at`          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pmhist_project` (`project_id`),
  KEY `idx_pmhist_action` (`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  8.  CLEAN UP HELPER
-- =============================================================================
DROP PROCEDURE IF EXISTS `xmp_add_column`;

SET FOREIGN_KEY_CHECKS = 1;

-- =============================================================================
--  9.  OPTIONAL SEED DATA  (demo ke liye — production me hata dena)
-- -----------------------------------------------------------------------------
--  Assumes: users table me id=1 ek 'Project manager' hai, projects me id 1 & 2.
-- =============================================================================

-- 9.1  Existing projects ko PM se link + Pending request bana do
UPDATE `projects`
   SET `project_manager_id` = 1,
       `request_status`     = 'Pending',
       `assigned_at`        = NOW()
 WHERE `id` IN (1, 2)
   AND `project_manager_id` IS NULL;

-- 9.2  Sub-project / phases
INSERT INTO `sub_projects` (`project_id`, `name`, `planned_start`, `planned_end`, `status`, `sort_order`)
SELECT 1, 'Requirement & Analysis', '2026-05-05', '2026-05-15', 'In Progress', 1
WHERE NOT EXISTS (SELECT 1 FROM `sub_projects` WHERE `project_id` = 1 AND `name` = 'Requirement & Analysis');

INSERT INTO `sub_projects` (`project_id`, `name`, `planned_start`, `planned_end`, `status`, `sort_order`)
SELECT 1, 'Design Phase', '2026-05-16', '2026-05-30', 'To Do', 2
WHERE NOT EXISTS (SELECT 1 FROM `sub_projects` WHERE `project_id` = 1 AND `name` = 'Design Phase');

-- 9.3  Board cards
INSERT INTO `boards` (`project_id`, `sub_project_id`, `pm_id`, `resource_id`, `title`, `priority`, `status`, `due_date`, `planned_end`)
SELECT 1, (SELECT id FROM sub_projects WHERE project_id = 1 AND name = 'Requirement & Analysis' LIMIT 1),
       1, 3, 'Collect BRD from client', 'High', 'In Progress', '2026-05-12', '2026-05-12'
WHERE NOT EXISTS (SELECT 1 FROM `boards` WHERE `project_id` = 1 AND `title` = 'Collect BRD from client');

INSERT INTO `boards` (`project_id`, `sub_project_id`, `pm_id`, `resource_id`, `title`, `priority`, `status`, `due_date`, `planned_end`)
SELECT 1, (SELECT id FROM sub_projects WHERE project_id = 1 AND name = 'Design Phase' LIMIT 1),
       1, 3, 'Wireframe main dashboard', 'Medium', 'To Do', '2026-05-20', '2026-05-20'
WHERE NOT EXISTS (SELECT 1 FROM `boards` WHERE `project_id` = 1 AND `title` = 'Wireframe main dashboard');

-- 9.4  Default Kanban columns for project 1
INSERT INTO `board_columns` (`project_id`, `title`, `sort_order`, `is_default`) VALUES
  (1, 'To Do', 1, 1), (1, 'In Progress', 2, 1), (1, 'Review', 3, 1), (1, 'Completed', 4, 1)
ON DUPLICATE KEY UPDATE `sort_order` = VALUES(`sort_order`);

-- 9.5  A discussion thread
INSERT INTO `project_discussions` (`project_id`, `project_name`, `project_scope`, `resource_id`, `type`, `sender_name`, `start_date`)
SELECT 1, 'ERP System Updated',
       'Kickoff call done with client.\nBRD sign-off pending from finance team.\nNext sync on Monday 10 AM.',
       1, 'Project manager', 'Soni Mishra', NOW()
WHERE NOT EXISTS (SELECT 1 FROM `project_discussions` WHERE `project_id` = 1);

-- 9.6  A required-resource request
INSERT INTO `required_resources` (`project_id`, `pm_id`, `role`, `required_resource`, `status`)
SELECT 1, 1, 'Backend Developer', 2, 'pending'
WHERE NOT EXISTS (SELECT 1 FROM `required_resources` WHERE `project_id` = 1 AND `role` = 'Backend Developer');

-- =============================================================================
--  END
-- =============================================================================
