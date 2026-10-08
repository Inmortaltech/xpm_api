-- =============================================================================
--  XMP  —  PMO SECTION  —  DATABASE SETUP
-- -----------------------------------------------------------------------------
--  PMO sidebar ke pages ko backend se connect karta hai:
--    - src/pages/PMOReviewPage.jsx                 (schedule freeze/approve/reject)
--    - src/pages/ResourceChangeRequestsListPage.jsx
--    - src/pages/ResourceApprovalQueuePage.jsx
--    - src/pages/ResourceChangeRequestDetailPage.jsx
--    - src/pages/CreateProjectPage.jsx  (Denied PM History modal)
--
--  RUN (baaki SQL files ke baad):
--     mysql -u root xmp_db < db_bkp/xmp_db_pmo_module.sql
-- =============================================================================

SET NAMES utf8mb4;

-- =============================================================================
--  1.  PROJECT STATUS  —  PM freeze -> PMO review workflow
-- -----------------------------------------------------------------------------
--  Ek row per project. PM aur PMO dono apni-apni status column update karte.
--    pm_status  : draft | frozen
--    pmo_status : pending | approved | rejected
--
--  Endpoints:
--    POST /api/admin/getProjectsStatus            { pmo_id } | { pm_id }
--    POST /api/projectManager/scheduleStatusByPm  PM:  { project_id, pm_id, pm_status, reason }
--                                                 PMO: { project_id, pmo_id, pmo_status, reason }
-- =============================================================================
CREATE TABLE IF NOT EXISTS `project_status` (
  `id`             INT           NOT NULL AUTO_INCREMENT,
  `project_id`     INT           NOT NULL,
  `pm_id`          INT           DEFAULT NULL,
  `pmo_id`         INT           DEFAULT NULL,
  `pm_status`      VARCHAR(30)   NOT NULL DEFAULT 'draft',
  `pmo_status`     VARCHAR(30)   NOT NULL DEFAULT 'pending',
  `reason`         TEXT          DEFAULT NULL,
  `schedule_data`  LONGTEXT      DEFAULT NULL,          -- PM ne jo schedule freeze kiya (JSON snapshot)
  `pm_updated_at`  DATETIME      DEFAULT NULL,
  `pmo_updated_at` DATETIME      DEFAULT NULL,
  `created_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_project_status` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  2.  RESOURCE CHANGE REQUESTS
-- -----------------------------------------------------------------------------
--  Pura request object ek JSON blob me (`payload`) — top-level columns sirf
--  list / filter / badge ke liye. Frontend ka data layer
--  (src/data/resourceChangeRequestsData.js) isi shape ko padhta hai.
--
--  status: 'Pending PMO Review' | 'Approved' | 'Rejected' | 'Clarification Requested'
--
--  Endpoints:
--    GET  /api/admin/resource_change_requests
--    GET  /api/admin/resource_change_request_detail?id=RCR-xxxx
--    POST /api/admin/approve_resource_change      { id, notes }
--    POST /api/admin/reject_resource_change       { id, reason }
--    POST /api/admin/clarify_resource_change      { id, query }
--    POST /api/projectManager/create_resource_change_request   { ...payload }
-- =============================================================================
CREATE TABLE IF NOT EXISTS `resource_change_requests` (
  `id`             INT           NOT NULL AUTO_INCREMENT,
  `request_code`   VARCHAR(40)   NOT NULL,              -- 'RCR-2026001'
  `project_id`     VARCHAR(50)   DEFAULT NULL,
  `project_name`   VARCHAR(255)  DEFAULT NULL,
  `pm_id`          INT           DEFAULT NULL,
  `project_manager` VARCHAR(150) DEFAULT NULL,
  `priority`       VARCHAR(20)   DEFAULT 'High',
  `department`     VARCHAR(100)  DEFAULT NULL,
  `status`         VARCHAR(40)   NOT NULL DEFAULT 'Pending PMO Review',
  `payload`        LONGTEXT      NOT NULL,              -- poora request object (JSON)
  `pmo_action_notes` TEXT        DEFAULT NULL,
  `decided_at`     VARCHAR(60)   DEFAULT NULL,
  `created_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME      NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rcr_code` (`request_code`),
  KEY `idx_rcr_status` (`status`),
  KEY `idx_rcr_project` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  3.  SEED  (demo)
-- =============================================================================
INSERT INTO `project_status` (`project_id`, `pm_id`, `pmo_id`, `pm_status`, `pmo_status`)
SELECT 1, 13, 12, 'frozen', 'pending'
WHERE NOT EXISTS (SELECT 1 FROM `project_status` WHERE `project_id` = 1);

INSERT INTO `project_status` (`project_id`, `pm_id`, `pmo_id`, `pm_status`, `pmo_status`)
SELECT 2, 13, 12, 'draft', 'pending'
WHERE NOT EXISTS (SELECT 1 FROM `project_status` WHERE `project_id` = 2);

INSERT INTO `resource_change_requests`
  (`request_code`, `project_id`, `project_name`, `pm_id`, `project_manager`, `priority`, `department`, `status`, `payload`)
SELECT 'RCR-2026001', '1', 'ERP System Updated', 13, 'Rahul Sharma', 'High', 'IT', 'Pending PMO Review',
  JSON_OBJECT(
    'id', 'RCR-2026001',
    'requestedOnFormatted', '31 May 2025, 11:30 AM',
    'status', 'Pending PMO Review',
    'priority', 'High',
    'department', 'IT',
    'projectId', '1',
    'projectName', 'ERP System Updated',
    'projectManager', 'Rahul Sharma',
    'reasonProvidedByPM', 'Ravi is overloaded on another critical project. Need a replacement UI dev + one extra QA.',
    'requestSummary', 'PM has requested changes in the resource allocation for better project execution.',
    'currentAllocation', JSON_ARRAY(
      JSON_OBJECT('srNo',1,'id','res-101','resourceName','Ravi Sharma','role','UI Developer','allocation',100,'workingDays',JSON_ARRAY('M','T','W','T','F')),
      JSON_OBJECT('srNo',2,'id','res-102','resourceName','Sagar Patel','role','Backend Developer','allocation',100,'workingDays',JSON_ARRAY('M','T','W','T','F'))
    ),
    'requestedAllocation', JSON_ARRAY(
      JSON_OBJECT('srNo',1,'id','res-104','resourceName','Aman Singh','role','UI Developer','allocation',100,'workingDays',JSON_ARRAY('M','T','W','T','F'),'change','Added'),
      JSON_OBJECT('srNo',2,'id','res-102','resourceName','Sagar Patel','role','Backend Developer','allocation',100,'workingDays',JSON_ARRAY('M','T','W','T','F'),'change','Unchanged')
    ),
    'attachments', JSON_ARRAY(),
    'paymentMilestones', JSON_ARRAY(),
    'clientDetails', JSON_OBJECT('clientName','ABC Pvt Ltd','role','VP Engineering','email','vp@abc.test'),
    'activityLog', JSON_ARRAY(
      JSON_OBJECT('id','act-1','timestamp','31 May 2025, 11:25 AM','author','Rahul Sharma (PM)','avatarTone','bg-emerald-100 text-emerald-700','action','Resource Change Request Submitted','details','Requested replacement of Ravi with Aman + 1 extra QA.')
    )
  )
WHERE NOT EXISTS (SELECT 1 FROM `resource_change_requests` WHERE `request_code` = 'RCR-2026001');

-- =============================================================================
--  END
-- =============================================================================
