// =============================================================================
//  PROJECT MANAGER CONTROLLER
//  Frontend: NewAssignedProjectPage.jsx, MyProjectsPage.jsx, ProjectBacklogsSection.jsx
//  Base route: /api/projectManager
//
//  Endpoints:
//    POST /get_projectsByPm        -> PM ke assigned projects (full detail)
//    POST /project_approvalBYPM    -> PM accept / decline
//    POST /create_requiredResource -> PM additional resource request
//    POST /get_pmBacklog           -> PM ke saare board tasks (grouped by resource on FE)
//    POST /assign_project          -> PMO se PM assign (bhi re-allocate ke liye use ho sakta)
//    POST /update_project_milestone-> milestones JSON update
//    GET  /denied_pm_history       -> "Denied PM History" modal
// =============================================================================

const sequelize = require("../config/db");
const { logActivity } = require("./_activity");

// ─── Runtime schema guard (ek baar per process) ──────────────────────────────
let schemaReady = false;

const ensurePmSchema = async () => {
  if (schemaReady) return;

  // projects table ke naye columns
  const projectCols = [
    ["methodology", "VARCHAR(50) DEFAULT NULL"],
    ["technical_lead", "VARCHAR(255) DEFAULT NULL"],
    ["technology", "VARCHAR(255) DEFAULT NULL"],
    ["project_manager_id", "INT DEFAULT NULL"],
    ["technical_lead_id", "INT DEFAULT NULL"],
    ["request_status", "VARCHAR(30) DEFAULT NULL"],
    ["decline_reason", "TEXT DEFAULT NULL"],
    ["pm_responded_at", "DATETIME DEFAULT NULL"],
    ["assigned_at", "DATETIME DEFAULT NULL"],
    ["resource_allocations", "LONGTEXT DEFAULT NULL"],
  ];
  for (const [name, ddl] of projectCols) {
    try {
      await sequelize.query(`ALTER TABLE projects ADD COLUMN ${name} ${ddl}`);
    } catch (e) {
      /* column already exists */
    }
  }

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS sub_projects (
      id INT NOT NULL AUTO_INCREMENT,
      project_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT DEFAULT NULL,
      planned_start DATE DEFAULT NULL,
      planned_end DATE DEFAULT NULL,
      status VARCHAR(50) DEFAULT 'To Do',
      sort_order INT DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sub_projects_project (project_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS required_resources (
      id INT NOT NULL AUTO_INCREMENT,
      project_id INT NOT NULL,
      pm_id INT DEFAULT NULL,
      resources_id INT DEFAULT NULL,
      role VARCHAR(150) NOT NULL,
      required_resource INT NOT NULL DEFAULT 0,
      current_resource INT NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      remark VARCHAR(255) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_reqres_project (project_id),
      KEY idx_reqres_pm (pm_id),
      KEY idx_reqres_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS boards (
      id INT NOT NULL AUTO_INCREMENT,
      project_id INT DEFAULT NULL,
      sub_project_id INT DEFAULT NULL,
      pm_id INT DEFAULT NULL,
      resource_id INT DEFAULT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT DEFAULT NULL,
      priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
      status VARCHAR(50) NOT NULL DEFAULT 'To Do',
      due_date DATE DEFAULT NULL,
      planned_start DATE DEFAULT NULL,
      planned_end DATE DEFAULT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_boards_project (project_id),
      KEY idx_boards_resource (resource_id),
      KEY idx_boards_pm (pm_id),
      KEY idx_boards_status (status)
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

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS project_pm_history (
      id INT NOT NULL AUTO_INCREMENT,
      project_id INT NOT NULL,
      project_name VARCHAR(255) DEFAULT NULL,
      action VARCHAR(30) NOT NULL,
      pm_id INT DEFAULT NULL,
      pm_name VARCHAR(150) DEFAULT NULL,
      previous_pm_id INT DEFAULT NULL,
      previous_pm_name VARCHAR(150) DEFAULT NULL,
      reassigned_to_id INT DEFAULT NULL,
      reassigned_to_name VARCHAR(150) DEFAULT NULL,
      reason TEXT DEFAULT NULL,
      performed_by INT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_pmhist_project (project_id),
      KEY idx_pmhist_action (action)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  schemaReady = true;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const parseJSON = (val, fallback = []) => {
  if (val == null || val === "") return fallback;
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
};

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

// A PM's own project list/decision endpoints key off a `pm_id` the CLIENT
// puts in the body, with no check that it's the caller's own id — any PM
// could pass another PM's id and see (or accept/decline!) their projects.
// PMO/admin legitimately look up any PM's data, so they're exempt.
const PMO_ROLES = new Set(["pmo", "admin"]);
const forbidOtherPm = (req, res, requestedPmId) => {
  const role = String(req.user?.role || "").toLowerCase();
  if (PMO_ROLES.has(role)) return false;
  const callerId = toInt(req.user?.id);
  if (requestedPmId && callerId && requestedPmId !== callerId) {
    res.status(403).json({ success: false, message: "You can only view or act on your own projects." });
    return true;
  }
  return false;
};

const getUserName = async (id) => {
  if (!id) return null;
  try {
    const rows = await sequelize.query(
      `SELECT name FROM users WHERE id = :id LIMIT 1`,
      { replacements: { id }, type: sequelize.QueryTypes.SELECT }
    );
    return rows[0]?.name || null;
  } catch {
    return null;
  }
};

// =============================================================================
//  POST /get_projectsByPm    body: { pm_id }
// =============================================================================
exports.getProjectsByPm = async (req, res) => {
  try {
    await ensurePmSchema();

    const pmId = toInt(req.body.pm_id ?? req.body.pmId);
    if (!pmId) {
      return res.status(400).json({ success: false, message: "pm_id is required" });
    }
    if (forbidOtherPm(req, res, pmId)) return;

    const pmName = await getUserName(pmId);

    const rows = await sequelize.query(
      `
      SELECT *
      FROM projects
      WHERE project_manager_id = :pmId
         OR (:pmName IS NOT NULL AND project_manager = :pmName)
      ORDER BY id DESC
      `,
      {
        replacements: { pmId, pmName },
        type: sequelize.QueryTypes.SELECT,
      }
    );

    // Celoxis-style: enrich each project with computed health (RAG) + progress
    const { _enrichProject } = require("./analytics.controller");
    const data = [];
    for (const p of rows) {
      const base = {
        ...p,
        contacts: parseJSON(p.contacts, []),
        milestones: parseJSON(p.milestones, []),
        resource_allocations: parseJSON(p.resource_allocations, []),
        request_status: p.request_status || "Pending",
      };
      try {
        data.push(await _enrichProject(base));
      } catch {
        data.push(base);
      }
    }

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("getProjectsByPm error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /project_approvalBYPM
//  body: { pm_id, project_id, request_status: 'Accept'|'Declined', reason }
// =============================================================================
exports.projectApprovalByPm = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    await ensurePmSchema();

    const pmId = toInt(req.body.pm_id);
    const projectId = toInt(req.body.project_id);
    const rawStatus = String(req.body.request_status || "").trim();
    const reason = req.body.reason || null;

    if (!projectId || !rawStatus) {
      await t.rollback();
      return res
        .status(400)
        .json({ success: false, message: "project_id and request_status are required" });
    }
    if (forbidOtherPm(req, res, pmId)) { await t.rollback(); return; }

    const normalized = rawStatus.toLowerCase();
    let requestStatus;
    let projectStatus;

    if (normalized.includes("accept")) {
      requestStatus = "Accept";
      projectStatus = "Accepted";
    } else if (normalized.includes("declin") || normalized.includes("deny")) {
      requestStatus = "Declined";
      projectStatus = "Deny";
    } else {
      requestStatus = rawStatus;
      projectStatus = null;
    }

    const existing = await sequelize.query(
      `SELECT id, project_name, project_manager, project_manager_id FROM projects WHERE id = :id LIMIT 1`,
      { replacements: { id: projectId }, type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    if (existing.length === 0) {
      await t.rollback();
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    const project = existing[0];

    await sequelize.query(
      `
      UPDATE projects SET
        request_status = :requestStatus,
        decline_reason = :reason,
        pm_responded_at = NOW()
        ${projectStatus ? ", status = :projectStatus" : ""}
        ${pmId ? ", project_manager_id = COALESCE(project_manager_id, :pmId)" : ""}
      WHERE id = :id
      `,
      {
        replacements: {
          id: projectId,
          requestStatus,
          reason: requestStatus === "Declined" ? reason : null,
          projectStatus,
          pmId,
        },
        transaction: t,
      }
    );

    const pmName = (await getUserName(pmId)) || project.project_manager;

    await sequelize.query(
      `
      INSERT INTO project_pm_history
        (project_id, project_name, action, pm_id, pm_name, reason, performed_by)
      VALUES
        (:project_id, :project_name, :action, :pm_id, :pm_name, :reason, :performed_by)
      `,
      {
        replacements: {
          project_id: projectId,
          project_name: project.project_name,
          action: requestStatus === "Accept" ? "accepted" : "declined",
          pm_id: pmId,
          pm_name: pmName,
          reason: requestStatus === "Declined" ? reason : null,
          performed_by: pmId,
        },
        transaction: t,
      }
    );

    await t.commit();
    logActivity({
      entity_type: "project",
      entity_id: String(projectId),
      project_id: projectId,
      actor_id: pmId,
      actor_name: pmName,
      action: requestStatus === "Accept" ? "accepted" : "declined",
      detail:
        requestStatus === "Accept"
          ? "PM accepted the project"
          : `PM declined the project${reason ? `: ${reason}` : ""}`,
    });
    return res.status(200).json({
      success: true,
      message:
        requestStatus === "Accept"
          ? "Project accepted successfully"
          : "Project response submitted as declined",
      data: { project_id: projectId, request_status: requestStatus, status: projectStatus },
    });
  } catch (error) {
    await t.rollback();
    console.error("projectApprovalByPm error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /create_requiredResource
//  body: { pm_id, project_id, resources_id, role, required_resource, status }
// =============================================================================
exports.createRequiredResource = async (req, res) => {
  try {
    await ensurePmSchema();

    const projectId = toInt(req.body.project_id);
    const role = String(req.body.role || "").trim();
    const requiredResource = toInt(req.body.required_resource) || 0;

    if (!projectId || !role) {
      return res
        .status(400)
        .json({ success: false, message: "project_id and role are required" });
    }

    const [result] = await sequelize.query(
      `
      INSERT INTO required_resources
        (project_id, pm_id, resources_id, role, required_resource, status)
      VALUES
        (:project_id, :pm_id, :resources_id, :role, :required_resource, :status)
      `,
      {
        replacements: {
          project_id: projectId,
          pm_id: toInt(req.body.pm_id),
          resources_id: toInt(req.body.resources_id),
          role,
          required_resource: requiredResource,
          status: req.body.status || "pending",
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );

    return res.status(201).json({
      success: true,
      message: "Required resource added successfully",
      id: result,
    });
  } catch (error) {
    console.error("createRequiredResource error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /get_pmBacklog    body: { pm_id }
//  Returns board rows in the shape ProjectBacklogsSection expects.
// =============================================================================
exports.getPmBacklog = async (req, res) => {
  try {
    await ensurePmSchema();

    const pmId = toInt(req.body.pm_id);
    if (!pmId) {
      return res.status(400).json({ success: false, message: "pm_id is required" });
    }

    const rows = await sequelize.query(
      `
      SELECT
        b.id               AS board_id,
        b.title            AS sub_project_name,
        b.priority,
        b.status,
        b.due_date,
        b.planned_end,
        b.project_id,
        b.resource_id,
        p.project_name,
        u.name             AS resource_name,
        u.role             AS resource_role
      FROM boards b
      LEFT JOIN projects p ON p.id = b.project_id
      LEFT JOIN users    u ON u.id = b.resource_id
      WHERE b.pm_id = :pmId AND b.is_active = 1
      ORDER BY b.resource_id, b.id DESC
      `,
      { replacements: { pmId }, type: sequelize.QueryTypes.SELECT }
    );

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("getPmBacklog error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /assign_project
//  body: { project_id, pm_id, project_manager }
//  PMO se PM assign — request_status = 'Pending'
// =============================================================================
exports.assignProject = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    await ensurePmSchema();

    const projectId = toInt(req.body.project_id ?? req.body.id);
    const pmId = toInt(req.body.pm_id);
    let pmName = req.body.project_manager || null;

    if (!projectId || (!pmId && !pmName)) {
      await t.rollback();
      return res
        .status(400)
        .json({ success: false, message: "project_id and pm_id / project_manager required" });
    }
    if (!pmName && pmId) pmName = await getUserName(pmId);

    const existing = await sequelize.query(
      `SELECT id, project_name, project_manager, project_manager_id FROM projects WHERE id = :id LIMIT 1`,
      { replacements: { id: projectId }, type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    if (existing.length === 0) {
      await t.rollback();
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    const prev = existing[0];

    await sequelize.query(
      `
      UPDATE projects SET
        project_manager    = :pmName,
        project_manager_id = :pmId,
        status             = 'Allocated',
        request_status     = 'Pending',
        decline_reason     = NULL,
        pm_responded_at    = NULL,
        assigned_at        = NOW()
      WHERE id = :id
      `,
      { replacements: { id: projectId, pmName, pmId }, transaction: t }
    );

    await sequelize.query(
      `
      INSERT INTO project_pm_history
        (project_id, project_name, action, pm_id, pm_name, previous_pm_id, previous_pm_name, performed_by)
      VALUES
        (:project_id, :project_name, 'assigned', :pm_id, :pm_name, :prev_id, :prev_name, :performed_by)
      `,
      {
        replacements: {
          project_id: projectId,
          project_name: prev.project_name,
          pm_id: pmId,
          pm_name: pmName,
          prev_id: prev.project_manager_id,
          prev_name: prev.project_manager,
          performed_by: pmId,
        },
        transaction: t,
      }
    );

    await t.commit();
    logActivity({
      entity_type: "project",
      entity_id: String(projectId),
      project_id: projectId,
      actor_id: pmId,
      actor_name: pmName,
      action: "assigned",
      detail: `Assigned ${pmName || "a PM"} as Project Manager`,
    });
    return res.status(200).json({ success: true, message: "Project assigned to PM successfully" });
  } catch (error) {
    await t.rollback();
    console.error("assignProject error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /update_project_milestone
//  body: { project_id, milestones: [ { milestone, milestone_date, percentage } ] }
// =============================================================================
exports.updateProjectMilestone = async (req, res) => {
  try {
    await ensurePmSchema();

    const projectId = toInt(req.body.project_id ?? req.body.id);
    if (!projectId) {
      return res.status(400).json({ success: false, message: "project_id is required" });
    }

    const milestones = parseJSON(req.body.milestones, []);

    await sequelize.query(
      `UPDATE projects SET milestones = :milestones WHERE id = :id`,
      {
        replacements: { id: projectId, milestones: JSON.stringify(milestones) },
        type: sequelize.QueryTypes.UPDATE,
      }
    );

    return res.status(200).json({ success: true, message: "Milestones updated successfully" });
  } catch (error) {
    console.error("updateProjectMilestone error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  GET /denied_pm_history        (optional ?search=)
//  "Denied PM History" modal (CreateProjectPage.jsx)
// =============================================================================
exports.deniedPmHistory = async (req, res) => {
  try {
    await ensurePmSchema();

    const search = String(req.query.search || "").trim();
    const rows = await sequelize.query(
      `
      SELECT
        h.id,
        h.project_id,
        h.project_name           AS project,
        h.pm_name                AS deniedBy,
        DATE_FORMAT(h.created_at, '%d/%m/%Y, %h:%i%p') AS denialDate,
        h.reason                 AS denialReason,
        h.reassigned_to_name     AS reassignedTo,
        DATE_FORMAT(reassign.created_at, '%d/%m/%Y, %h:%i%p') AS reassignmentDate
      FROM project_pm_history h
      LEFT JOIN project_pm_history reassign
        ON reassign.project_id = h.project_id
       AND reassign.action IN ('assigned', 're-allocated')
       AND reassign.created_at > h.created_at
      WHERE h.action = 'declined'
        ${search ? "AND (h.project_name LIKE :s OR h.pm_name LIKE :s OR h.reason LIKE :s)" : ""}
      GROUP BY h.id
      ORDER BY h.created_at DESC
      `,
      {
        replacements: search ? { s: `%${search}%` } : {},
        type: sequelize.QueryTypes.SELECT,
      }
    );

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("deniedPmHistory error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  BOARD (djwork_v2 client)  —  read side + custom columns
// =============================================================================
const BOARD_STATUS_KEYS = ["in_discussion", "to_do", "in_work", "in_progress", "completed"];

const ensureBoardTables = async () => {
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
    CREATE TABLE IF NOT EXISTS board_status (
      id INT NOT NULL AUTO_INCREMENT,
      project_id INT NOT NULL,
      pm_id INT DEFAULT NULL,
      status_name VARCHAR(100) NOT NULL,
      status_key VARCHAR(100) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      wip_limit INT DEFAULT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_board_status (project_id, status_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};

// POST /getBoard   { pm_id, project_id }
exports.getBoard = async (req, res) => {
  try {
    await ensurePmSchema();
    await ensureBoardTables();

    const projectId = toInt(req.body.project_id);
    if (!projectId) {
      return res.status(400).json({ success: false, message: "project_id is required" });
    }

    const rows = await sequelize.query(
      `
      SELECT id, project_id, task_id, resource_id, pm_id,
             title, priority, due_date, description, status, created_at
      FROM boards
      WHERE project_id = :projectId AND is_active = 1
      ORDER BY sort_order ASC, id ASC
      `,
      { replacements: { projectId }, type: sequelize.QueryTypes.SELECT }
    );

    const data = {};
    BOARD_STATUS_KEYS.forEach((k) => (data[k] = []));
    rows.forEach((r) => {
      const key = BOARD_STATUS_KEYS.includes(r.status) ? r.status : "to_do";
      (data[key] = data[key] || []).push(r);
    });

    return res
      .status(200)
      .json({ success: true, message: "Board data fetched successfully", data });
  } catch (error) {
    console.error("getBoard error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /get_project_schedule   { project_id, pm_id }
exports.getProjectSchedule = async (req, res) => {
  try {
    await ensureBoardTables();

    const projectId = toInt(req.body.project_id);
    if (!projectId) {
      return res.status(400).json({ success: false, message: "project_id is required" });
    }

    const rows = await sequelize.query(
      `
      SELECT id, project_id, parent_id, type, task_name, sub_project_name,
             resource_id, pm_id, predecessor, predecessor_id, predecessor_type,
             lag_days, planned_start, planned_end, duration, progress, priority,
             status, planned_hours, actual_hours, allocation_pct, is_milestone,
             baseline_start, baseline_end, sort_order
      FROM project_schedule
      WHERE project_id = :projectId AND is_active = 1
      ORDER BY parent_id IS NOT NULL, sort_order, id
      `,
      { replacements: { projectId }, type: sequelize.QueryTypes.SELECT }
    );

    let autoSchedule = false;
    try {
      const [p] = await sequelize.query(
        `SELECT COALESCE(auto_schedule, 0) AS auto_schedule FROM projects WHERE id = :projectId`,
        { replacements: { projectId }, type: sequelize.QueryTypes.SELECT }
      );
      autoSchedule = !!(p && Number(p.auto_schedule) === 1);
    } catch (_) { /* column not migrated yet */ }

    return res.status(200).json({ success: true, count: rows.length, auto_schedule: autoSchedule, data: rows });
  } catch (error) {
    console.error("getProjectSchedule error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const slugify = (s) =>
  String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// POST /getBoardStatus   { project_id }
exports.getBoardStatus = async (req, res) => {
  try {
    await ensureBoardTables();
    const projectId = toInt((req.body && req.body.project_id) ?? req.query.project_id);

    const rows = await sequelize.query(
      `
      SELECT id, project_id, status_name, status_key, sort_order, wip_limit, is_default
      FROM board_status
      ${projectId ? "WHERE project_id = :projectId" : ""}
      ORDER BY sort_order ASC, id ASC
      `,
      { replacements: projectId ? { projectId } : {}, type: sequelize.QueryTypes.SELECT }
    );

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("getBoardStatus error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /saveBoardStatus  { project_id, pm_id, status_name } | { ..., statuses:[{name,wip_limit}] }
exports.saveBoardStatus = async (req, res) => {
  try {
    await ensureBoardTables();
    const projectId = toInt(req.body.project_id);
    const pmId = toInt(req.body.pm_id);
    if (!projectId) {
      return res.status(400).json({ success: false, message: "project_id is required" });
    }

    let list = req.body.statuses;
    if (!Array.isArray(list)) {
      list = [{ name: req.body.status_name || req.body.name, wip_limit: req.body.wip_limit }];
    }
    list = list.filter((s) => s && (s.name || s.status_name));

    let order = 0;
    for (const s of list) {
      const name = s.name || s.status_name;
      const key = s.status_key || slugify(name);
      order += 1;
      await sequelize.query(
        `
        INSERT INTO board_status (project_id, pm_id, status_name, status_key, sort_order, wip_limit)
        VALUES (:project_id, :pm_id, :status_name, :status_key, :sort_order, :wip_limit)
        ON DUPLICATE KEY UPDATE status_name = VALUES(status_name),
                                sort_order  = VALUES(sort_order),
                                wip_limit   = VALUES(wip_limit)
        `,
        {
          replacements: {
            project_id: projectId,
            pm_id: pmId,
            status_name: name,
            status_key: key,
            sort_order: s.sort_order != null ? toInt(s.sort_order) : order,
            wip_limit: s.wip_limit != null && s.wip_limit !== "" ? toInt(s.wip_limit) : null,
          },
        }
      );
    }

    return res.status(200).json({ success: true, message: "Board columns saved" });
  } catch (error) {
    console.error("saveBoardStatus error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /editBoardStatus  { id, status_name, wip_limit?, sort_order? }
exports.editBoardStatus = async (req, res) => {
  try {
    await ensureBoardTables();
    const id = toInt(req.body.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });

    const name = req.body.status_name ?? req.body.name;
    const sets = [];
    const repl = { id };
    if (name != null) {
      sets.push("status_name = :status_name", "status_key = :status_key");
      repl.status_name = String(name);
      repl.status_key = slugify(name);
    }
    if (req.body.wip_limit !== undefined) {
      sets.push("wip_limit = :wip_limit");
      repl.wip_limit =
        req.body.wip_limit === "" || req.body.wip_limit == null ? null : toInt(req.body.wip_limit);
    }
    if (req.body.sort_order !== undefined) {
      sets.push("sort_order = :sort_order");
      repl.sort_order = toInt(req.body.sort_order);
    }
    if (sets.length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update" });
    }

    await sequelize.query(`UPDATE board_status SET ${sets.join(", ")} WHERE id = :id`, {
      replacements: repl,
      type: sequelize.QueryTypes.UPDATE,
    });
    return res.status(200).json({ success: true, message: "Board column updated" });
  } catch (error) {
    console.error("editBoardStatus error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /deleteBoardStatus  { id }
exports.deleteBoardStatus = async (req, res) => {
  try {
    await ensureBoardTables();
    const id = toInt(req.body.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    await sequelize.query(`DELETE FROM board_status WHERE id = :id AND is_default = 0`, {
      replacements: { id },
      type: sequelize.QueryTypes.DELETE,
    });
    return res.status(200).json({ success: true, message: "Board column deleted" });
  } catch (error) {
    console.error("deleteBoardStatus error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  SCHEDULE TASK CRUD  (Celoxis "Plan" — WBS + dependencies)
//  POST /api/projectManager/create_schedule_task
//  POST /api/projectManager/update_schedule_task
//  POST /api/projectManager/delete_schedule_task
// =============================================================================
const { logActivity: _logAct } = require("./_activity");

const _fmtD = (d) => {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().split("T")[0];
};

// ── Allocation cap: SUM(task allocation_pct for this resource on this
//    project) must stay <= the PMO's project-level allocation % for that
//    resource (projects.resource_allocations, set when the project was
//    created/updated). If the PMO never recorded one for this resource, the
//    cap is 100% — a resource still can't be scheduled past their own full
//    capacity on a single project even without an explicit PMO number.
//    allocation_pct itself is an ABSOLUTE % of the resource's own
//    capacity_hours (see workload.controller.js taskDailyHours) — it is never
//    multiplied again by the PMO %, only capped by it.
const pmoAllocationCapFor = async (projectId, resourceId) => {
  const [proj] = await sequelize.query(
    `SELECT resource_allocations FROM projects WHERE id = :id LIMIT 1`,
    { replacements: { id: projectId }, type: sequelize.QueryTypes.SELECT }
  );
  const groups = parseJSON(proj?.resource_allocations, []);
  const rows = groups.flatMap((g) => Array.isArray(g?.rows) ? g.rows : []);
  const match = rows.find((r) => String(r?.resource_id ?? r?.id ?? "") === String(resourceId));
  if (!match) return 100;
  const pct = parseFloat(String(match.allocation ?? "").replace("%", "").trim());
  return Number.isFinite(pct) && pct > 0 ? pct : 100;
};

// Throws a 409-shaped error the caller turns into a JSON response — never
// silently clamps a PM's requested % ("obviously wrong" would be picking a
// number for them; the right move is to tell them what fits).
class AllocationConflictError extends Error {
  constructor(message, detail) {
    super(message);
    this.status = 409;
    this.detail = detail;
  }
}

const assertAllocationWithinCap = async ({ projectId, resourceId, taskId, allocationPct }) => {
  if (!projectId || !resourceId || allocationPct == null) return;
  const incoming = Number(allocationPct);
  if (!Number.isFinite(incoming) || incoming <= 0) return;

  const cap = await pmoAllocationCapFor(projectId, resourceId);
  const others = await sequelize.query(
    `SELECT COALESCE(SUM(allocation_pct), 0) AS total
       FROM project_schedule
      WHERE project_id = :pid AND resource_id = :rid AND is_active = 1
        AND (status IS NULL OR status <> 'completed')
        ${taskId ? "AND id <> :tid" : ""}`,
    { replacements: { pid: projectId, rid: resourceId, tid: taskId }, type: sequelize.QueryTypes.SELECT }
  );
  const existing = Number(others[0]?.total) || 0;
  const total = existing + incoming;
  if (total > cap) {
    throw new AllocationConflictError(
      `Over-allocation: this resource is already at ${existing}% on this project (PMO cap ${cap}%). ` +
        `Adding ${incoming}% would put them at ${total}%.`,
      { cap, existing, incoming, total }
    );
  }
};

exports.createScheduleTask = async (req, res) => {
  try {
    await ensureBoardTables();
    const b = req.body || {};
    const projectId = toInt(b.project_id);
    const taskName = String(b.task_name || b.name || "").trim();
    if (!projectId || !taskName) {
      return res.status(400).json({ success: false, message: "project_id and task_name are required" });
    }
    const parentId = toInt(b.parent_id);
    const resourceId = toInt(b.resource_id);
    const allocationPct = b.allocation_pct != null ? Number(b.allocation_pct) : 100;
    if (resourceId) {
      await assertAllocationWithinCap({ projectId, resourceId, taskId: null, allocationPct });
    }
    const [ord] = await sequelize.query(
      `SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM project_schedule WHERE project_id = :pid`,
      { replacements: { pid: projectId }, type: sequelize.QueryTypes.SELECT }
    );
    const [id] = await sequelize.query(
      `INSERT INTO project_schedule
        (project_id, parent_id, type, task_name, sub_project_name, description, resource_id, pm_id,
         predecessor, predecessor_id, predecessor_type, lag_days, planned_start, planned_end, duration,
         progress, priority, status, planned_hours, allocation_pct, is_milestone, sort_order)
       VALUES
        (:pid, :parent, :type, :tname, :sname, :desc, :rid, :pmid,
         :pred, :predid, :predtype, :lag, :ps, :pe, :dur,
         :prog, :prio, :status, :ph, :alloc, :ms, :ord)`,
      {
        replacements: {
          pid: projectId,
          parent: parentId,
          type: parentId ? "subproject" : "project",
          tname: taskName,
          sname: parentId ? taskName : null,
          desc: b.description || null,
          rid: resourceId,
          pmid: toInt(b.pm_id),
          pred: b.predecessor || null,
          predid: toInt(b.predecessor_id),
          predtype: b.predecessor_type || "FS",
          lag: toInt(b.lag_days) || 0,
          ps: _fmtD(b.planned_start),
          pe: _fmtD(b.planned_end),
          dur: toInt(b.duration),
          prog: Number(b.progress) || 0,
          prio: b.priority || null,
          status: b.status || "to_do",
          ph: b.planned_hours != null ? Number(b.planned_hours) : null,
          alloc: allocationPct,
          ms: b.is_milestone ? 1 : 0,
          ord: Number(ord?.n) || 1,
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );
    await _logAct({
      entity_type: "schedule_task",
      entity_id: String(id),
      project_id: projectId,
      actor_id: toInt(b.pm_id),
      action: "created",
      detail: `Added task "${taskName}"`,
    });
    return res.status(201).json({ success: true, message: "Task added", data: { id } });
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ success: false, message: error.message, ...error.detail });
    console.error("createScheduleTask error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateScheduleTask = async (req, res) => {
  try {
    await ensureBoardTables();
    const b = req.body || {};
    const id = toInt(b.id ?? b.task_id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });

    const map = {
      task_name: "task_name",
      description: "description",
      resource_id: "resource_id",
      predecessor: "predecessor",
      predecessor_id: "predecessor_id",
      predecessor_type: "predecessor_type",
      lag_days: "lag_days",
      planned_start: "planned_start",
      planned_end: "planned_end",
      duration: "duration",
      progress: "progress",
      priority: "priority",
      status: "status",
      planned_hours: "planned_hours",
      actual_hours: "actual_hours",
      allocation_pct: "allocation_pct",
      is_milestone: "is_milestone",
      baseline_start: "baseline_start",
      baseline_end: "baseline_end",
    };
    const dateCols = new Set(["planned_start", "planned_end", "baseline_start", "baseline_end"]);
    const intCols = new Set(["resource_id", "predecessor_id", "lag_days", "duration", "is_milestone"]);

    const sets = [];
    const repl = { id };
    for (const [k, col] of Object.entries(map)) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
      sets.push(`${col} = :${col}`);
      let v = b[k];
      if (dateCols.has(col)) v = _fmtD(v);
      else if (intCols.has(col)) v = toInt(v);
      else if (["progress", "planned_hours", "actual_hours", "allocation_pct"].includes(col))
        v = v === "" || v == null ? null : Number(v);
      repl[col] = v;
    }
    if (sets.length === 0) return res.status(400).json({ success: false, message: "No field to update" });

    // Only re-check the cap when this write actually touches resource_id or
    // allocation_pct — merge with the task's current row for whichever of the
    // two isn't in this partial update.
    if (Object.prototype.hasOwnProperty.call(b, "resource_id") || Object.prototype.hasOwnProperty.call(b, "allocation_pct")) {
      const [current] = await sequelize.query(
        `SELECT project_id, resource_id, allocation_pct FROM project_schedule WHERE id = :id LIMIT 1`,
        { replacements: { id }, type: sequelize.QueryTypes.SELECT }
      );
      if (current) {
        const effResourceId = Object.prototype.hasOwnProperty.call(b, "resource_id") ? repl.resource_id : current.resource_id;
        const effAlloc = Object.prototype.hasOwnProperty.call(b, "allocation_pct") ? repl.allocation_pct : current.allocation_pct;
        if (effResourceId) {
          await assertAllocationWithinCap({ projectId: current.project_id, resourceId: effResourceId, taskId: id, allocationPct: effAlloc });
        }
      }
    }

    await sequelize.query(`UPDATE project_schedule SET ${sets.join(", ")} WHERE id = :id`, {
      replacements: repl,
      type: sequelize.QueryTypes.UPDATE,
    });

    // ── Gantt auto-shift: if this project has auto_schedule ON and a date/
    //    dependency field changed, cascade the shift to successors ──────────
    let shifted = 0;
    let shifts = [];
    const touchedSchedule = ["planned_start", "planned_end", "duration", "predecessor_id", "predecessor_type", "lag_days"]
      .some((k) => Object.prototype.hasOwnProperty.call(b, k));
    if (touchedSchedule) {
      try {
        const [row] = await sequelize.query(
          `SELECT s.project_id, COALESCE(p.auto_schedule, 0) AS auto_schedule
             FROM project_schedule s JOIN projects p ON p.id = s.project_id WHERE s.id = :id`,
          { replacements: { id }, type: sequelize.QueryTypes.SELECT }
        );
        if (row && Number(row.auto_schedule) === 1) {
          const { cascadeSchedule } = require("./schedule.controller");
          const out = await cascadeSchedule(row.project_id, { persist: true, actorId: toInt(b.pm_id) });
          shifted = out.count;
          shifts = out.shifts;
        }
      } catch (e) {
        console.warn("auto-shift skipped:", e.message);
      }
    }

    return res.status(200).json({ success: true, message: "Task updated", shifted, shifts });
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ success: false, message: error.message, ...error.detail });
    console.error("updateScheduleTask error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteScheduleTask = async (req, res) => {
  try {
    await ensureBoardTables();
    const id = toInt((req.body || {}).id ?? (req.body || {}).task_id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    await sequelize.query(
      `UPDATE project_schedule SET is_active = 0 WHERE id = :id OR parent_id = :id`,
      { replacements: { id }, type: sequelize.QueryTypes.UPDATE }
    );
    return res.status(200).json({ success: true, message: "Task deleted" });
  } catch (error) {
    console.error("deleteScheduleTask error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
