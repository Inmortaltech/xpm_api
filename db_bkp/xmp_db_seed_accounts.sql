-- =============================================================================
--  XMP  —  DEMO LOGIN ACCOUNTS  (PMO / PM / USER)  +  demo data re-point
-- -----------------------------------------------------------------------------
--  Ye 3 clean login accounts banata hai aur user-section ka demo data
--  (project_schedule / boards / notifications / risks) inhi ke ids par set
--  kar deta hai — taaki login karte hi sab dikhe.
--
--  RUN (baaki SQL files ke baad):
--     mysql -u root xmp_db < db_bkp/xmp_db_seed_accounts.sql
--
--  Passwords PLAINTEXT hain (app abhi bcrypt use nahi karta).
--
--  ┌────────┬────────────────────┬──────────┬────────────────────┬─────────────┐
--  │ Role   │ Email              │ Password │ users.role         │ Lands on    │
--  ├────────┼────────────────────┼──────────┼────────────────────┼─────────────┤
--  │ PMO    │ pmo@xmp.test       │ pmo123   │ PMO                │ / (Dashboard)│
--  │ PM     │ pm@xmp.test        │ pm123    │ Project Manager    │ /new-assigned-project │
--  │ USER   │ user@xmp.test      │ user123  │ Tester             │ /my-tasks   │
--  └────────┴────────────────────┴──────────┴────────────────────┴─────────────┘
-- =============================================================================

SET NAMES utf8mb4;

-- ── 1. Accounts (idempotent — email par upsert) ─────────────────────────────
INSERT INTO `users` (`name`, `email`, `password`, `role`, `user_type`, `status`, `mobile`, `createdAt`, `updatedAt`)
VALUES ('PMO Admin', 'pmo@xmp.test', 'pmo123', 'PMO', 'inhouse', 'enable', '9000000001', NOW(), NOW())
ON DUPLICATE KEY UPDATE password = VALUES(password), role = VALUES(role),
                        user_type = VALUES(user_type), status = 'enable', updatedAt = NOW();

INSERT INTO `users` (`name`, `email`, `password`, `role`, `user_type`, `status`, `mobile`, `createdAt`, `updatedAt`)
VALUES ('Rahul Sharma', 'pm@xmp.test', 'pm123', 'Project Manager', 'inhouse', 'enable', '9000000002', NOW(), NOW())
ON DUPLICATE KEY UPDATE password = VALUES(password), role = VALUES(role),
                        user_type = VALUES(user_type), status = 'enable', updatedAt = NOW();

INSERT INTO `users` (`name`, `email`, `password`, `role`, `user_type`, `status`, `mobile`, `createdAt`, `updatedAt`)
VALUES ('Priya Singh', 'user@xmp.test', 'user123', 'Tester', 'inhouse', 'enable', '9000000003', NOW(), NOW())
ON DUPLICATE KEY UPDATE password = VALUES(password), role = VALUES(role),
                        user_type = VALUES(user_type), status = 'enable', updatedAt = NOW();

-- ── 2. ids pakdo ───────────────────────────────────────────────────────────
SET @pmo_id  = (SELECT id FROM users WHERE email = 'pmo@xmp.test'  LIMIT 1);
SET @pm_id   = (SELECT id FROM users WHERE email = 'pm@xmp.test'   LIMIT 1);
SET @user_id = (SELECT id FROM users WHERE email = 'user@xmp.test' LIMIT 1);

-- ── 3. Projects -> naya PM assign (Pending acceptance) ──────────────────────
UPDATE `projects`
   SET `project_manager`    = 'Rahul Sharma',
       `project_manager_id` = @pm_id,
       `request_status`     = 'Pending',
       `assigned_at`        = NOW()
 WHERE `id` IN (1, 2);

-- ── 4. Schedule tasks -> naye USER ko assign, PM = naya pm ──────────────────
UPDATE `project_schedule`
   SET `resource_id` = @user_id,
       `pm_id`       = @pm_id
 WHERE `project_id` = 1;

-- agar demo schedule rows abhi nahi hain to bana do
INSERT INTO `project_schedule` (`project_id`, `parent_id`, `type`, `task_name`, `resource_id`, `pm_id`, `planned_start`, `planned_end`, `priority`, `status`)
SELECT 1, NULL, 'project', 'Design Login Screen', @user_id, @pm_id, '2026-08-21', '2026-08-27', 'High', 'in_progress'
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule` WHERE `project_id` = 1 AND `task_name` = 'Design Login Screen');
INSERT INTO `project_schedule` (`project_id`, `parent_id`, `type`, `task_name`, `resource_id`, `pm_id`, `planned_start`, `planned_end`, `priority`, `status`)
SELECT 1, NULL, 'project', 'Fix API Integration', @user_id, @pm_id, '2026-08-18', '2026-08-25', 'Medium', 'to_do'
WHERE NOT EXISTS (SELECT 1 FROM `project_schedule` WHERE `project_id` = 1 AND `task_name` = 'Fix API Integration');

-- ── 5. Board cards -> naye USER / PM, aur status keys theek karo ────────────
UPDATE `boards`
   SET `resource_id` = @user_id,
       `pm_id`       = @pm_id,
       `status` = CASE LOWER(`status`)
                    WHEN 'to do'        THEN 'to_do'
                    WHEN 'in progress'  THEN 'in_progress'
                    WHEN 'in work'      THEN 'in_work'
                    WHEN 'in discussion' THEN 'in_discussion'
                    WHEN 'completed'    THEN 'completed'
                    ELSE `status`
                  END
 WHERE `project_id` = 1;

-- ── 6. Notifications -> naye USER ke liye ──────────────────────────────────
UPDATE `notifications` SET `user_id` = @user_id WHERE `user_id` IS NOT NULL;

INSERT INTO `notifications` (`user_id`, `type`, `title`, `message`, `project_id`, `project_name`, `is_read`)
SELECT @user_id, 'TASK_ASSIGNED', 'Task assigned to you',
       'Rahul Sharma assigned you "Design Login Screen".', '1', 'ERP System Updated', 0
WHERE NOT EXISTS (SELECT 1 FROM `notifications` WHERE `user_id` = @user_id AND `title` = 'Task assigned to you');

-- ── 7. Risks -> naye USER ke liye ─────────────────────────────────────────
UPDATE `risks` SET `resource_id` = @user_id WHERE `project_id` = 1;

INSERT INTO `risks` (`project_id`, `resource_id`, `task_name`, `due_date`, `state`, `impact`, `probability`)
SELECT 1, @user_id, 'Fix API Integration', '25-Aug-26 / Tuesday', 'Analyzed', 'Severe', 'Likely'
WHERE NOT EXISTS (SELECT 1 FROM `risks` WHERE `project_id` = 1 AND `task_name` = 'Fix API Integration');

-- ── 8. Discussion thread -> naye USER ke liye ─────────────────────────────
UPDATE `project_discussions` SET `resource_id` = @user_id WHERE `project_id` = 1;

INSERT INTO `project_discussions` (`project_id`, `project_name`, `project_scope`, `resource_id`, `type`, `sender_name`, `start_date`)
SELECT 1, 'ERP System Updated',
       'Kickoff done.\nBRD sign-off pending.\nNext sync Monday 10 AM.',
       @user_id, 'Tester', 'Rahul Sharma', NOW()
WHERE NOT EXISTS (SELECT 1 FROM `project_discussions` WHERE `project_id` = 1 AND `resource_id` = @user_id);

-- ── show result ──────────────────────────────────────────────────────────
SELECT id, name, email, password, role, status FROM users
WHERE email IN ('pmo@xmp.test', 'pm@xmp.test', 'user@xmp.test');
