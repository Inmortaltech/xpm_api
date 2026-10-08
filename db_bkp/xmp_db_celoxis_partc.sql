-- =============================================================================
--  XMP  —  CELOXIS PARITY  —  PART C  (Workload / Resource Load demo data)
-- -----------------------------------------------------------------------------
--  Workload grid ab project_schedule se driven hai (resource_id + planned dates
--  + allocation_pct / planned_hours) — bilkul Celoxis Resource Load Chart jaisa.
--  Ye file kuch demo schedule tasks daalti hai (relative dates, CURDATE se) taaki
--  grid me under / full / over-allocation dono dikhein.
--
--  Idempotent: har task project_id + task_name + resource_id par guarded hai.
--  RUN order: saare celoxis files ke baad.
-- =============================================================================

SET NAMES utf8mb4;

-- ── data hygiene: older project rows stored the literal string "null" in
--    priority (multipart-form artefact). Normalise to a real value. ──────────
UPDATE `projects`
   SET priority = 'Medium'
 WHERE priority IN ('null', 'undefined', '') OR priority IS NULL;
UPDATE `projects` SET methodology    = NULL WHERE methodology    IN ('null', 'undefined', '');
UPDATE `projects` SET project_type   = NULL WHERE project_type   IN ('null', 'undefined', '');
UPDATE `projects` SET project_scope  = NULL WHERE project_scope  IN ('null', 'undefined', '');
UPDATE `projects` SET company_name   = NULL WHERE company_name   IN ('null', 'undefined', '');
UPDATE `projects` SET location       = NULL WHERE location       IN ('null', 'undefined', '');
UPDATE `projects` SET technology     = NULL WHERE technology     IN ('null', 'undefined', '');
UPDATE `projects` SET technical_lead = NULL WHERE technical_lead IN ('null', 'undefined', '');

-- helper: insert a schedule task only if that (project, task, resource) trio
-- doesn't already exist.  resource_id here is resources.id (1/2/3) — the engine
-- also matches on the linked users.id, so either works.

-- ── Project 1 — spread of allocations on resource 1 (will tip into OVER) ──────
INSERT INTO `project_schedule`
  (project_id, type, task_name, resource_id, planned_start, planned_end,
   allocation_pct, planned_hours, status, priority, is_active, sort_order)
SELECT 1, 'project', 'WL: API integration', 1,
       CURDATE(), CURDATE() + INTERVAL 20 DAY, 60, NULL, 'in_progress', 'High', 1, 90
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule`
  WHERE project_id = 1 AND task_name = 'WL: API integration' AND resource_id = 1);

INSERT INTO `project_schedule`
  (project_id, type, task_name, resource_id, planned_start, planned_end,
   allocation_pct, planned_hours, status, priority, is_active, sort_order)
SELECT 1, 'project', 'WL: Perf hardening', 1,
       CURDATE() + INTERVAL 5 DAY, CURDATE() + INTERVAL 25 DAY, 70, NULL, 'to_do', 'Medium', 1, 91
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule`
  WHERE project_id = 1 AND task_name = 'WL: Perf hardening' AND resource_id = 1);

INSERT INTO `project_schedule`
  (project_id, type, task_name, resource_id, planned_start, planned_end,
   allocation_pct, planned_hours, status, priority, is_active, sort_order)
SELECT 1, 'project', 'WL: Release cutover', 2,
       CURDATE() + INTERVAL 14 DAY, CURDATE() + INTERVAL 35 DAY, 40, NULL, 'to_do', 'Medium', 1, 92
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule`
  WHERE project_id = 1 AND task_name = 'WL: Release cutover' AND resource_id = 2);

INSERT INTO `project_schedule`
  (project_id, type, task_name, resource_id, planned_start, planned_end,
   allocation_pct, planned_hours, status, priority, is_active, sort_order)
SELECT 1, 'project', 'WL: Regression suite', 3,
       CURDATE() + INTERVAL 7 DAY, CURDATE() + INTERVAL 21 DAY, 50, NULL, 'to_do', 'Medium', 1, 93
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule`
  WHERE project_id = 1 AND task_name = 'WL: Regression suite' AND resource_id = 3);

-- ── Project 2 — planned_hours driven (fixed effort, not %-of-capacity) ───────
INSERT INTO `project_schedule`
  (project_id, type, task_name, resource_id, planned_start, planned_end,
   allocation_pct, planned_hours, status, priority, is_active, sort_order)
SELECT 2, 'project', 'WL: Data migration', 1,
       CURDATE() + INTERVAL 2 DAY, CURDATE() + INTERVAL 16 DAY, 100, 60, 'to_do', 'High', 1, 94
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule`
  WHERE project_id = 2 AND task_name = 'WL: Data migration' AND resource_id = 1);

INSERT INTO `project_schedule`
  (project_id, type, task_name, resource_id, planned_start, planned_end,
   allocation_pct, planned_hours, status, priority, is_active, sort_order)
SELECT 2, 'project', 'WL: Client UAT support', 3,
       CURDATE() + INTERVAL 21 DAY, CURDATE() + INTERVAL 45 DAY, 30, NULL, 'to_do', 'Low', 1, 95
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule`
  WHERE project_id = 2 AND task_name = 'WL: Client UAT support' AND resource_id = 3);

INSERT INTO `project_schedule`
  (project_id, type, task_name, resource_id, planned_start, planned_end,
   allocation_pct, planned_hours, status, priority, is_active, sort_order)
SELECT 2, 'project', 'WL: Solution design', 2,
       CURDATE(), CURDATE() + INTERVAL 12 DAY, 55, NULL, 'in_progress', 'Medium', 1, 96
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule`
  WHERE project_id = 2 AND task_name = 'WL: Solution design' AND resource_id = 2);
