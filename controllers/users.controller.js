// =============================================================================
//  USERS CONTROLLER  —  "user" / resource section (djwork_v2 client)
//  Base route: /api/users
//
//  Pages: MyTasksPage, MyTaskProjectDetailPage, RiskPage,
//         NotificationPanel, ProjectBoardSection, ProjectDiscussionSection
//
//  Endpoints:
//    POST   /get_userProjectList          { resource }
//    POST   /create_board                 { project_id, task_id, status, resource_id, pm_id }
//    POST   /editBoard                    { id, ... }            (JSON or multipart)
//    POST   /deleteBoard                  { id }
//    POST   /get_userDiscussion           (FormData) resource_id, type
//    POST   /create_discussion            (FormData) project_id, project_scope, ...
//    GET    /get_notifications            ?user_id
//    POST   /mark_notification_read       { id }
//    POST   /mark_all_notifications_read  { user_id? }
//    DELETE /clear_all_notifications      { user_id? }
//    POST   /delete_notification          { id }
//    GET    /get_risks                    ?project_id&resource_id
//    POST   /create_risk                  { project_id, task_name, due_date, state, impact, probability, resource_id }
//    POST   /update_risk                  { id, ... }
//    POST   /delete_risk                  { id } | { ids: [] }
// =============================================================================

const sequelize = require("../config/db");

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const fmtDate = (d) => {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().split("T")[0];
};

// ─── Runtime schema guard (ek baar per process) ──────────────────────────────
let ready = false;
const ensureSchema = async () => {
  if (ready) return;

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS project_schedule (
      id INT NOT NULL AUTO_INCREMENT,
      project_id INT NOT NULL,
      parent_id INT DEFAULT NULL,
      type VARCHAR(20) NOT NULL DEFAULT 'project',
      task_name VARCHAR(255) NOT NULL,
      sub_project_name VARCHAR(255) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      resource_id INT DEFAULT NULL,
      pm_id INT DEFAULT NULL,
      predecessor VARCHAR(100) DEFAULT NULL,
      planned_start DATE DEFAULT NULL,
      planned_end DATE DEFAULT NULL,
      duration INT DEFAULT NULL,
      progress DECIMAL(5,2) DEFAULT 0,
      priority VARCHAR(20) DEFAULT NULL,
      status VARCHAR(50) DEFAULT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sched_project (project_id),
      KEY idx_sched_resource (resource_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS boards (
      id INT NOT NULL AUTO_INCREMENT,
      project_id INT DEFAULT NULL,
      task_id INT DEFAULT NULL,
      sub_project_id INT DEFAULT NULL,
      pm_id INT DEFAULT NULL,
      resource_id INT DEFAULT NULL,
      title VARCHAR(255) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      priority VARCHAR(20) DEFAULT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'to_do',
      due_date DATE DEFAULT NULL,
      attachments VARCHAR(255) DEFAULT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_boards_project (project_id),
      KEY idx_boards_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  for (const [c, ddl] of [
    ["task_id", "INT DEFAULT NULL"],
    ["attachments", "VARCHAR(255) DEFAULT NULL"],
    ["due_date", "DATE DEFAULT NULL"],
    ["title", "VARCHAR(255) DEFAULT NULL"],
    ["priority", "VARCHAR(20) DEFAULT NULL"],
  ]) {
    try { await sequelize.query(`ALTER TABLE boards ADD COLUMN ${c} ${ddl}`); } catch (e) { /* exists */ }
  }

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT DEFAULT NULL,
      type VARCHAR(50) NOT NULL DEFAULT 'SYSTEM_MAINTENANCE',
      title VARCHAR(255) NOT NULL,
      message TEXT DEFAULT NULL,
      project_id VARCHAR(50) DEFAULT NULL,
      project_name VARCHAR(255) DEFAULT NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      is_cleared TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_notif_user (user_id, is_cleared, is_read)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS risks (
      id INT NOT NULL AUTO_INCREMENT,
      project_id INT DEFAULT NULL,
      resource_id INT DEFAULT NULL,
      task_name VARCHAR(255) NOT NULL,
      due_date VARCHAR(100) DEFAULT NULL,
      state VARCHAR(50) NOT NULL DEFAULT 'Identified',
      impact VARCHAR(50) NOT NULL DEFAULT 'Medium',
      probability VARCHAR(50) NOT NULL DEFAULT 'Likely',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_risks_project (project_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS project_discussions (
      discussion_id INT NOT NULL AUTO_INCREMENT,
      project_id INT DEFAULT NULL,
      project_name VARCHAR(255) DEFAULT NULL,
      project_scope TEXT DEFAULT NULL,
      resource_id INT DEFAULT NULL,
      type VARCHAR(50) DEFAULT NULL,
      created_by INT DEFAULT NULL,
      sender_name VARCHAR(150) DEFAULT NULL,
      upload_personal_document VARCHAR(255) DEFAULT NULL,
      start_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (discussion_id),
      KEY idx_disc_project (project_id),
      KEY idx_disc_resource (resource_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  ready = true;
};

// =============================================================================
//  POST /get_userProjectList   body: { resource }
//  Logged-in resource ke saare tasks (+ subtasks) har project me — flat rows.
// =============================================================================
exports.getUserProjectList = async (req, res) => {
  try {
    await ensureSchema();

    const resourceId = toInt(req.body.resource ?? req.body.resource_id);
    if (!resourceId) {
      return res.status(400).json({ success: false, message: "resource is required" });
    }

    const rows = await sequelize.query(
      `
      SELECT
        s.id,
        s.project_id,
        p.project_name,
        s.type,
        s.task_name,
        s.sub_project_name,
        s.predecessor,
        s.planned_start,
        s.planned_end,
        s.priority,
        s.status,
        s.resource_id,
        s.pm_id,
        u.name  AS resource_name,
        s.created_at,
        p.company_name AS client_name,
        p.project_manager,
        p.project_manager_id,
        pmu.name AS pm_name
      FROM project_schedule s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN users    u ON u.id = s.resource_id
      LEFT JOIN users  pmu ON pmu.id = COALESCE(s.pm_id, p.project_manager_id)
      WHERE s.resource_id = :resourceId AND s.is_active = 1
      ORDER BY s.project_id DESC, s.parent_id IS NOT NULL, s.sort_order, s.id
      `,
      { replacements: { resourceId }, type: sequelize.QueryTypes.SELECT }
    );

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("getUserProjectList error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /get_userProjectDetail   { resource_id, project_id }
//  Rich payload for MyTaskProjectDetailPage — the resource's tasks for ONE
//  project with full fields (item_key, status, dates, reporter, comments),
//  the project header (manager, client, dates, health, progress, milestones)
//  and server-computed stats. Everything on that page comes from here.
// =============================================================================
exports.getUserProjectDetail = async (req, res) => {
  try {
    await ensureSchema();
    // This query reads boards.id/updated_at/etc. — make sure that table's own
    // migrations (owned by backlog.controller.js) have run, regardless of
    // whether a board/backlog route has already fired earlier in this process.
    try { await require("./backlog.controller").ensureBoardsSchema(); } catch { /* boards table not reachable — tasks query below will surface it */ }
    const b = req.body || {};
    const resourceId = toInt(b.resource_id ?? b.resource ?? (req.user && req.user.id));
    const projectId = toInt(b.project_id);
    if (!resourceId || !projectId) {
      return res.status(400).json({ success: false, message: "resource_id and project_id are required" });
    }

    // resource row id (schedule/boards may key on users.id OR resources.id)
    const rr = await sequelize.query(
      `SELECT id, COALESCE(capacity_hours, 8) AS capacity_hours FROM resources WHERE user_id = :uid LIMIT 1`,
      { replacements: { uid: resourceId }, type: sequelize.QueryTypes.SELECT }
    ).catch(() => []);
    const rid = rr[0]?.id ?? -1;
    // Own configured working hours/day — never hardcode 8h (see workload.controller.js).
    const capacityHoursPerDay = Number(rr[0]?.capacity_hours) || 8;

    // ── project header (health via analytics enrich) ──────────────────────
    const projRows = await sequelize.query(`SELECT * FROM projects WHERE id = :id LIMIT 1`, {
      replacements: { id: projectId }, type: sequelize.QueryTypes.SELECT,
    });
    if (!projRows.length) return res.status(404).json({ success: false, message: "Project not found" });
    let enriched = projRows[0];
    try {
      const analytics = require("./analytics.controller");
      enriched = await analytics._enrichProject(projRows[0]);
    } catch { /* health cols may be missing — fall back to raw row */ }

    const [pmu] = await sequelize.query(
      `SELECT name FROM users WHERE id = :id LIMIT 1`,
      { replacements: { id: enriched.project_manager_id || -1 }, type: sequelize.QueryTypes.SELECT }
    ).catch(() => [{}]);

    const clean = (v) => (v == null || v === "null" || v === "undefined" || v === "" ? null : v);
    const milestones = (() => {
      try { return typeof enriched.milestones === "string" ? JSON.parse(enriched.milestones || "[]") : (enriched.milestones || []); }
      catch { return []; }
    })();

    const project = {
      id: enriched.id,
      project_name: enriched.project_name,
      project_code: enriched.project_code,
      // Board / schedule endpoints are keyed by the project's PM — expose it so
      // the resource-side Board tab can load without a PM login.
      project_manager_id: enriched.project_manager_id || null,
      client_name: clean(enriched.company_name),
      manager: (pmu && pmu.name) || clean(enriched.project_manager) || null,
      status: enriched.status || "Active",
      priority: clean(enriched.priority) || "Medium",
      start_date: enriched.start_date,
      end_date: enriched.end_date,
      health: enriched.health || null,
      health_note: enriched.health_note || null,
      progress_pct: Number(enriched.progress_pct ?? enriched.progress ?? 0),
      milestones,
    };

    // ── the resource's tasks for this project (schedule + board overlay) ──
    const tasks = await sequelize.query(
      `
      SELECT
        s.id, s.type, s.task_name, s.sub_project_name,
        s.planned_start, s.planned_end, s.priority,
        s.status              AS schedule_status,
        COALESCE(s.allocation_pct, 100) AS allocation_pct,
        s.created_at, s.updated_at,
        b.id                  AS board_id, b.item_key,
        b.status              AS board_status,
        b.updated_at          AS board_updated_at,
        b.due_date            AS board_due_date,
        ru.name               AS assignee_name,
        rep.name              AS reporter_name
      FROM project_schedule s
      LEFT JOIN boards b ON b.project_id = s.project_id AND b.task_id = s.id AND b.is_active = 1
      LEFT JOIN users  ru ON ru.id = s.resource_id
      LEFT JOIN users  rep ON rep.id = b.reporter_id
      WHERE s.project_id = :pid AND s.is_active = 1
        AND (s.resource_id = :uid OR s.resource_id = :rid)
      ORDER BY s.parent_id IS NOT NULL, s.sort_order, s.id
      `,
      { replacements: { pid: projectId, uid: resourceId, rid }, type: sequelize.QueryTypes.SELECT }
    );

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const within7 = (d) => { if (!d) return false; const x = new Date(d); return !Number.isNaN(x) && (today - x) / 86400000 <= 7 && x <= today; };

    let completed = 0, inProgress = 0, upcoming = 0, overdue = 0, created7 = 0, updated7 = 0, dueSoon = 0;
    const shaped = tasks.map((t) => {
      const status = t.board_status || t.schedule_status || "to_do";
      const due = t.board_due_date || t.planned_end || null;
      const updated = t.board_updated_at || t.updated_at || null;

      const isDone = status === "completed";
      const isOverdue = !isDone && due && new Date(due) < today;
      const isDueSoon = !isDone && due && new Date(due) >= today && (new Date(due) - today) / 86400000 <= 7;

      if (isDone) completed += 1;
      else if (status === "in_progress" || status === "in_work") inProgress += 1;
      else upcoming += 1;
      if (isOverdue) overdue += 1;
      if (isDueSoon) dueSoon += 1;
      if (within7(t.created_at)) created7 += 1;
      if (within7(updated)) updated7 += 1;

      return {
        id: t.id,
        board_id: t.board_id,
        item_key: t.item_key || null,
        type: t.type || "task",
        title: t.task_name || t.sub_project_name,
        status,
        priority: clean(t.priority) || "Medium",
        assignee: t.assignee_name || null,
        reporter: t.reporter_name || project.manager || null,
        created_at: t.created_at || null,
        updated_at: updated,
        due_date: due,
        is_overdue: !!isOverdue,
        // absolute % of THIS resource's own capacity_hours (never re-multiplied
        // by a project-level %) — see workload.controller.js taskDailyHours.
        allocation_pct: Number(t.allocation_pct) || 100,
        effective_hours_per_day: Math.round(capacityHoursPerDay * ((Number(t.allocation_pct) || 100) / 100) * 100) / 100,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        project,
        resource: { capacity_hours_per_day: capacityHoursPerDay },
        tasks: shaped,
        stats: {
          total: shaped.length,
          completed, in_progress: inProgress, upcoming, overdue,
          due_soon: dueSoon, created_7d: created7, updated_7d: updated7,
        },
      },
    });
  } catch (error) {
    console.error("getUserProjectDetail error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  BOARD  —  create / edit / delete
// =============================================================================
exports.createBoard = async (req, res) => {
  try {
    await ensureSchema();

    const projectId = toInt(req.body.project_id);
    const taskId = toInt(req.body.task_id);
    const status = String(req.body.status || "to_do");

    if (!projectId) {
      return res.status(400).json({ success: false, message: "project_id is required" });
    }

    // schedule task ka naam title me copy kar lo (agar mila)
    let title = req.body.title || null;
    if (!title && taskId) {
      const t = await sequelize.query(
        `SELECT task_name FROM project_schedule WHERE id = :id LIMIT 1`,
        { replacements: { id: taskId }, type: sequelize.QueryTypes.SELECT }
      );
      title = t[0]?.task_name || null;
    }

    await sequelize.query(
      `
      INSERT INTO boards (project_id, task_id, pm_id, resource_id, title, priority, status, due_date, description)
      VALUES (:project_id, :task_id, :pm_id, :resource_id, :title, :priority, :status, :due_date, :description)
      `,
      {
        replacements: {
          project_id: projectId,
          task_id: taskId,
          pm_id: toInt(req.body.pm_id),
          resource_id: toInt(req.body.resource_id),
          title,
          priority: req.body.priority || null,
          status,
          due_date: fmtDate(req.body.due_date),
          description: req.body.description || null,
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );

    return res.status(201).json({ success: true, message: "Board card created successfully" });
  } catch (error) {
    console.error("createBoard error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.editBoard = async (req, res) => {
  try {
    await ensureSchema();

    const boardId = toInt(req.body.id ?? req.body.board_id);
    if (!boardId) {
      return res.status(400).json({ success: false, message: "id is required" });
    }

    const cols = {
      project_id: (v) => toInt(v),
      task_id: (v) => toInt(v),
      resource_id: (v) => toInt(v),
      pm_id: (v) => toInt(v),
      status: (v) => String(v),
      title: (v) => (v == null ? null : String(v)),
      priority: (v) => (v == null ? null : String(v)),
      description: (v) => (v == null ? null : String(v)),
      due_date: (v) => fmtDate(v),
    };

    const sets = [];
    const repl = { id: boardId };
    for (const [k, cast] of Object.entries(cols)) {
      if (Object.prototype.hasOwnProperty.call(req.body, k) && req.body[k] !== "") {
        sets.push(`${k} = :${k}`);
        repl[k] = cast(req.body[k]);
      }
    }
    if (req.file) {
      sets.push(`attachments = :attachments`);
      repl.attachments = req.file.filename;
    }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, message: "No updatable field provided" });
    }

    await sequelize.query(
      `UPDATE boards SET ${sets.join(", ")} WHERE id = :id`,
      { replacements: repl, type: sequelize.QueryTypes.UPDATE }
    );

    return res.status(200).json({ success: true, message: "Board card updated successfully" });
  } catch (error) {
    console.error("editBoard error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteBoard = async (req, res) => {
  try {
    await ensureSchema();
    const boardId = toInt(req.body.id ?? req.body.board_id);
    if (!boardId) {
      return res.status(400).json({ success: false, message: "id is required" });
    }
    await sequelize.query(
      `UPDATE boards SET is_active = 0 WHERE id = :id`,
      { replacements: { id: boardId }, type: sequelize.QueryTypes.UPDATE }
    );
    return res.status(200).json({ success: true, message: "Board card deleted successfully" });
  } catch (error) {
    console.error("deleteBoard error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /get_userDiscussion   (FormData) resource_id, type
// =============================================================================
exports.getUserDiscussion = async (req, res) => {
  try {
    await ensureSchema();

    const resourceId = toInt(req.body.resource_id);
    const projectId = toInt(req.body.project_id ?? req.body.selectedProjectId);

    const where = ["d.is_active = 1"];
    const repl = {};
    if (projectId) {
      where.push("d.project_id = :projectId");
      repl.projectId = projectId;
    } else if (resourceId) {
      where.push("(d.resource_id = :resourceId OR d.resource_id IS NULL)");
      repl.resourceId = resourceId;
    }

    const rows = await sequelize.query(
      `
      SELECT d.discussion_id, d.project_id, d.project_name, d.project_scope,
             d.sender_name, d.upload_personal_document, d.start_date, d.created_at
      FROM project_discussions d
      WHERE ${where.join(" AND ")}
      ORDER BY d.start_date DESC
      `,
      { replacements: repl, type: sequelize.QueryTypes.SELECT }
    );

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("getUserDiscussion error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createDiscussion = async (req, res) => {
  try {
    await ensureSchema();
    const [result] = await sequelize.query(
      `
      INSERT INTO project_discussions
        (project_id, project_name, project_scope, resource_id, type, created_by, sender_name, upload_personal_document, start_date)
      VALUES (:project_id, :project_name, :project_scope, :resource_id, :type, :created_by, :sender_name, :doc, NOW())
      `,
      {
        replacements: {
          project_id: toInt(req.body.project_id),
          project_name: req.body.project_name || null,
          project_scope: req.body.project_scope || req.body.message || null,
          resource_id: toInt(req.body.resource_id),
          type: req.body.type || null,
          created_by: toInt(req.body.created_by) || toInt(req.body.resource_id),
          sender_name: req.body.sender_name || null,
          doc: req.file ? req.file.filename : null,
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );
    return res.status(201).json({ success: true, message: "Discussion posted", data: { discussion_id: result } });
  } catch (error) {
    console.error("createDiscussion error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  NOTIFICATIONS
// =============================================================================
const relativeTime = (d) => {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

exports.getNotifications = async (req, res) => {
  try {
    await ensureSchema();
    const userId = toInt(req.query.user_id ?? req.query.resource_id);

    const rows = await sequelize.query(
      `
      SELECT id, type, title, message, project_id, project_name, is_read, created_at
      FROM notifications
      WHERE is_cleared = 0
        AND (user_id IS NULL ${userId ? "OR user_id = :userId" : ""})
      ORDER BY created_at DESC
      LIMIT 200
      `,
      { replacements: userId ? { userId } : {}, type: sequelize.QueryTypes.SELECT }
    );

    const notifications = rows.map((n) => ({
      id: String(n.id),
      type: n.type,
      title: n.title,
      message: n.message,
      projectName: n.project_name,
      projectId: n.project_id,
      time: relativeTime(n.created_at),
      read: !!n.is_read,
    }));

    return res.status(200).json({ success: true, notifications });
  } catch (error) {
    console.error("getNotifications error:", error);
    return res.status(500).json({ success: false, message: error.message, notifications: [] });
  }
};

exports.markNotificationRead = async (req, res) => {
  try {
    await ensureSchema();
    const id = toInt(req.body.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    await sequelize.query(`UPDATE notifications SET is_read = 1 WHERE id = :id`, {
      replacements: { id }, type: sequelize.QueryTypes.UPDATE,
    });
    return res.status(200).json({ success: true, message: "Marked as read" });
  } catch (error) {
    console.error("markNotificationRead error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.markAllNotificationsRead = async (req, res) => {
  try {
    await ensureSchema();
    const userId = toInt((req.body && req.body.user_id) ?? req.query.user_id);
    await sequelize.query(
      `UPDATE notifications SET is_read = 1 WHERE is_cleared = 0 AND (user_id IS NULL ${userId ? "OR user_id = :userId" : ""})`,
      { replacements: userId ? { userId } : {}, type: sequelize.QueryTypes.UPDATE }
    );
    return res.status(200).json({ success: true, message: "All marked as read" });
  } catch (error) {
    console.error("markAllNotificationsRead error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.clearAllNotifications = async (req, res) => {
  try {
    await ensureSchema();
    const userId = toInt((req.body && req.body.user_id) ?? req.query.user_id);
    await sequelize.query(
      `UPDATE notifications SET is_cleared = 1 WHERE is_cleared = 0 AND (user_id IS NULL ${userId ? "OR user_id = :userId" : ""})`,
      { replacements: userId ? { userId } : {}, type: sequelize.QueryTypes.UPDATE }
    );
    return res.status(200).json({ success: true, message: "All notifications cleared" });
  } catch (error) {
    console.error("clearAllNotifications error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    await ensureSchema();
    const id = toInt(req.body.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    await sequelize.query(`UPDATE notifications SET is_cleared = 1 WHERE id = :id`, {
      replacements: { id }, type: sequelize.QueryTypes.UPDATE,
    });
    return res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    console.error("deleteNotification error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  RISKS
// =============================================================================
exports.getRisks = async (req, res) => {
  try {
    await ensureSchema();
    const projectId = toInt(req.query.project_id);
    const resourceId = toInt(req.query.resource_id);

    const where = ["r.is_active = 1"];
    const repl = {};
    if (projectId) { where.push("r.project_id = :projectId"); repl.projectId = projectId; }
    if (resourceId) { where.push("(r.resource_id = :resourceId OR r.resource_id IS NULL)"); repl.resourceId = resourceId; }

    // severity columns are added by db_bkp/xmp_db_celoxis_polish.sql — tolerate absence
    let rows;
    try {
      rows = await sequelize.query(
        `SELECT r.id, r.project_id, r.task_name, r.due_date, r.state, r.impact, r.probability,
                r.probability_score, r.impact_score, r.severity_score, r.severity, r.mitigation,
                r.owner_id, r.target_date, r.created_at
         FROM risks r WHERE ${where.join(" AND ")} ORDER BY r.id DESC`,
        { replacements: repl, type: sequelize.QueryTypes.SELECT }
      );
    } catch {
      rows = await sequelize.query(
        `SELECT r.id, r.project_id, r.task_name, r.due_date, r.state, r.impact, r.probability, r.created_at
         FROM risks r WHERE ${where.join(" AND ")} ORDER BY r.id DESC`,
        { replacements: repl, type: sequelize.QueryTypes.SELECT }
      );
    }

    const PSCORE = { rare: 1, unlikely: 2, possible: 3, likely: 4, certain: 5 };
    const ISCORE = { minor: 1, medium: 2, major: 4, severe: 5 };
    const data = rows.map((r) => {
      const ps = r.probability_score ?? PSCORE[String(r.probability || "").toLowerCase()] ?? 3;
      const is = r.impact_score ?? ISCORE[String(r.impact || "").toLowerCase()] ?? 3;
      const sc = r.severity_score ?? ps * is;
      const sev = r.severity ?? (sc >= 15 ? "critical" : sc >= 8 ? "high" : sc >= 4 ? "medium" : "low");
      return {
        id: r.id,
        projectId: String(r.project_id ?? ""),
        taskName: r.task_name,
        dueDate: r.due_date,
        state: r.state,
        impact: r.impact,
        probability: r.probability,
        probabilityScore: ps,
        impactScore: is,
        severityScore: sc,
        severity: sev,
        mitigation: r.mitigation ?? "",
        ownerId: r.owner_id ?? null,
        targetDate: r.target_date ?? null,
      };
    });

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("getRisks error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// probability x impact -> 1..25 severity score + band (Celoxis risk matrix)
const PSCORE = { rare: 1, unlikely: 2, possible: 3, likely: 4, certain: 5 };
const ISCORE = { minor: 1, medium: 2, major: 4, severe: 5 };
const scoreRisk = (probability, impact, pOverride, iOverride) => {
  const ps = Number(pOverride) || PSCORE[String(probability || "").toLowerCase()] || 3;
  const is = Number(iOverride) || ISCORE[String(impact || "").toLowerCase()] || 3;
  const sc = ps * is;
  const sev = sc >= 15 ? "critical" : sc >= 8 ? "high" : sc >= 4 ? "medium" : "low";
  return { ps, is, sc, sev };
};

exports.createRisk = async (req, res) => {
  try {
    await ensureSchema();
    const taskName = String(req.body.task_name ?? req.body.taskName ?? "").trim();
    if (!taskName) {
      return res.status(400).json({ success: false, message: "task_name is required" });
    }
    const impact = req.body.impact || "Medium";
    const probability = req.body.probability || "Likely";
    const { ps, is, sc, sev } = scoreRisk(
      probability, impact, req.body.probability_score ?? req.body.probabilityScore,
      req.body.impact_score ?? req.body.impactScore
    );

    let id;
    try {
      [id] = await sequelize.query(
        `INSERT INTO risks (project_id, resource_id, task_name, due_date, state, impact, probability,
                            probability_score, impact_score, severity_score, severity, mitigation, owner_id, target_date)
         VALUES (:project_id, :resource_id, :task_name, :due_date, :state, :impact, :probability,
                 :ps, :is, :sc, :sev, :mitigation, :owner_id, :target_date)`,
        {
          replacements: {
            project_id: toInt(req.body.project_id ?? req.body.projectId),
            resource_id: toInt(req.body.resource_id ?? req.body.resourceId),
            task_name: taskName,
            due_date: req.body.due_date ?? req.body.dueDate ?? null,
            state: req.body.state || "Identified",
            impact, probability, ps, is, sc, sev,
            mitigation: req.body.mitigation ?? null,
            owner_id: toInt(req.body.owner_id ?? req.body.ownerId),
            target_date: req.body.target_date ?? req.body.targetDate ?? null,
          },
          type: sequelize.QueryTypes.INSERT,
        }
      );
    } catch {
      [id] = await sequelize.query(
        `INSERT INTO risks (project_id, resource_id, task_name, due_date, state, impact, probability)
         VALUES (:project_id, :resource_id, :task_name, :due_date, :state, :impact, :probability)`,
        {
          replacements: {
            project_id: toInt(req.body.project_id ?? req.body.projectId),
            resource_id: toInt(req.body.resource_id ?? req.body.resourceId),
            task_name: taskName,
            due_date: req.body.due_date ?? req.body.dueDate ?? null,
            state: req.body.state || "Identified",
            impact, probability,
          },
          type: sequelize.QueryTypes.INSERT,
        }
      );
    }
    return res.status(201).json({ success: true, message: "Risk added successfully", id, severity: sev, severityScore: sc });
  } catch (error) {
    console.error("createRisk error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateRisk = async (req, res) => {
  try {
    await ensureSchema();
    const id = toInt(req.body.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });

    const map = {
      project_id: () => toInt(req.body.project_id ?? req.body.projectId),
      task_name: () => String(req.body.task_name ?? req.body.taskName),
      due_date: () => req.body.due_date ?? req.body.dueDate,
      state: () => String(req.body.state),
      impact: () => String(req.body.impact),
      probability: () => String(req.body.probability),
      mitigation: () => req.body.mitigation ?? null,
      owner_id: () => toInt(req.body.owner_id ?? req.body.ownerId),
      target_date: () => req.body.target_date ?? req.body.targetDate ?? null,
    };
    const aliases = {
      project_id: ["project_id", "projectId"], task_name: ["task_name", "taskName"],
      due_date: ["due_date", "dueDate"], state: ["state"], impact: ["impact"],
      probability: ["probability"], mitigation: ["mitigation"],
      owner_id: ["owner_id", "ownerId"], target_date: ["target_date", "targetDate"],
    };
    const optionalCols = new Set(["mitigation", "owner_id", "target_date"]);

    const sets = [];
    const repl = { id };
    for (const [col, keys] of Object.entries(aliases)) {
      if (keys.some((k) => Object.prototype.hasOwnProperty.call(req.body, k))) {
        sets.push(`${col} = :${col}`);
        repl[col] = map[col]();
      }
    }

    // recompute severity if impact / probability changed
    if (repl.impact !== undefined || repl.probability !== undefined) {
      const cur = await sequelize.query(`SELECT impact, probability FROM risks WHERE id = :id LIMIT 1`, {
        replacements: { id }, type: sequelize.QueryTypes.SELECT,
      });
      const { ps, is, sc, sev } = scoreRisk(
        repl.probability ?? cur[0]?.probability, repl.impact ?? cur[0]?.impact
      );
      for (const [c, v] of [["probability_score", ps], ["impact_score", is], ["severity_score", sc], ["severity", sev]]) {
        sets.push(`${c} = :${c}`);
        repl[c] = v;
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, message: "No updatable field provided" });
    }
    try {
      await sequelize.query(`UPDATE risks SET ${sets.join(", ")} WHERE id = :id`, {
        replacements: repl, type: sequelize.QueryTypes.UPDATE,
      });
    } catch {
      // severity columns missing — retry with only the base fields
      const baseSets = sets.filter((s) => !/(severity|_score|mitigation|owner_id|target_date)/.test(s));
      await sequelize.query(`UPDATE risks SET ${baseSets.join(", ")} WHERE id = :id`, {
        replacements: repl, type: sequelize.QueryTypes.UPDATE,
      });
    }
    return res.status(200).json({ success: true, message: "Risk updated successfully" });
  } catch (error) {
    console.error("updateRisk error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteRisk = async (req, res) => {
  try {
    await ensureSchema();
    let ids = req.body.ids;
    if (!Array.isArray(ids)) ids = req.body.id != null ? [req.body.id] : [];
    ids = ids.map(toInt).filter(Boolean);
    if (ids.length === 0) {
      return res.status(400).json({ success: false, message: "id or ids is required" });
    }
    await sequelize.query(
      `UPDATE risks SET is_active = 0 WHERE id IN (:ids)`,
      { replacements: { ids }, type: sequelize.QueryTypes.UPDATE }
    );
    return res.status(200).json({ success: true, message: "Risk(s) deleted successfully" });
  } catch (error) {
    console.error("deleteRisk error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
