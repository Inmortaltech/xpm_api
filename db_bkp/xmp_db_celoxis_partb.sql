-- =============================================================================
--  XMP  —  CELOXIS PARITY  —  PART B  (deep scheduling / approval / reporting)
-- -----------------------------------------------------------------------------
--  Teen deep features jo pehle "advisory" the, ab fully working:
--     B1. Gantt auto-shift   — predecessor slip par successor dates auto push
--                              (projects.auto_schedule flag)
--     B2. Approval SLA        — har step ka due_at + time-based escalation
--                              + "due soon" reminders
--     B3. Scheduled reports   — saved_reports ko daily/weekly/monthly deliver
--                              karo (report_deliveries audit trail)
--
--  MariaDB 10.2+ / MySQL 8 — "IF NOT EXISTS" DDL use karta hai, so idempotent.
--  RUN order: saare celoxis files ke baad.
--     mysql -u root xmp_db < db_bkp/xmp_db_celoxis_partb.sql
-- =============================================================================

SET NAMES utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
--  B1.  GANTT AUTO-SHIFT
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `projects`
  ADD COLUMN IF NOT EXISTS `auto_schedule` TINYINT(1) NOT NULL DEFAULT 0;

-- last cascade run (informational)
ALTER TABLE `projects`
  ADD COLUMN IF NOT EXISTS `schedule_rebuilt_at` DATETIME DEFAULT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
--  B2.  APPROVAL SLA / ESCALATION
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `approvals`
  ADD COLUMN IF NOT EXISTS `sla_hours` INT NOT NULL DEFAULT 48;

ALTER TABLE `approval_steps`
  ADD COLUMN IF NOT EXISTS `assigned_at`  DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `due_at`       DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `escalated`    TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `escalated_at` DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `reminded_at`  DATETIME DEFAULT NULL;

-- backfill due_at for already-open steps so the first sweep has something to act on
UPDATE `approval_steps` s
  JOIN `approvals` a ON a.id = s.approval_id
   SET s.assigned_at = COALESCE(s.assigned_at, a.created_at),
       s.due_at      = COALESCE(s.due_at, a.created_at + INTERVAL a.sla_hours HOUR)
 WHERE s.status = 'pending' AND a.status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
--  B3.  SCHEDULED REPORT DELIVERY
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `saved_reports`
  ADD COLUMN IF NOT EXISTS `schedule_freq`  VARCHAR(12)   DEFAULT NULL,  -- daily | weekly | monthly
  ADD COLUMN IF NOT EXISTS `schedule_hour`  TINYINT       NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS `recipients`     VARCHAR(1000) DEFAULT NULL,  -- comma-separated emails
  ADD COLUMN IF NOT EXISTS `next_run_at`    DATETIME      DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `last_run_at`    DATETIME      DEFAULT NULL;

CREATE TABLE IF NOT EXISTS `report_deliveries` (
  `id`          INT           NOT NULL AUTO_INCREMENT,
  `report_id`   INT           DEFAULT NULL,
  `report_name` VARCHAR(150)  DEFAULT NULL,
  `recipients`  VARCHAR(1000) DEFAULT NULL,
  `row_count`   INT           NOT NULL DEFAULT 0,
  `status`      VARCHAR(16)   NOT NULL DEFAULT 'sent',   -- sent | failed | skipped
  `mode`        VARCHAR(16)   NOT NULL DEFAULT 'log',    -- smtp | log
  `detail`      VARCHAR(500)  DEFAULT NULL,
  `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_rdel_report` (`report_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =============================================================================
--  DEMO SEED (idempotent) — ek scheduled report taaki sweep turant kuch kare
-- =============================================================================
UPDATE `saved_reports`
   SET schedule_freq = 'weekly', schedule_hour = 7,
       recipients = 'pmo@xmp.test',
       next_run_at = NOW() - INTERVAL 1 MINUTE
 WHERE schedule_freq IS NULL
 ORDER BY id
 LIMIT 1;
