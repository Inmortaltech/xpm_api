// =============================================================================
//  BACKLOG + BOARD CONTROLLER   (Jira-style)
// -----------------------------------------------------------------------------
//  Model:
//    boards   = issues (item_key, type, priority, story_points, rank_order,
//               sprint_id, epic_id, parent_id, status, ...)
//    sprints  = future | active | closed
//    BACKLOG  = boards WHERE sprint_id IS NULL
//    BOARD    = boards WHERE sprint_id = <active sprint>  (grouped by status)
//
//  Endpoints
//    POST /api/projectManager/get_pmBacklog        { pm_id, project_id? }
//    POST /api/projectManager/getBoard             { pm_id, project_id }
//    POST /api/users/create_board                  create issue (backlog by default)
//    POST /api/users/editBoard                     patch any issue field
//    POST /api/users/deleteBoard                   soft delete
//    POST /api/projectManager/moveToSprint         { id, sprint_id|null, status? }
//    POST /api/projectManager/rankItem             { id, before_id?, after_id? }
//    POST /api/projectManager/getSprints           { project_id }
//    POST /api/projectManager/createSprint         { project_id, name?, goal? }
//    POST /api/projectManager/startSprint          { sprint_id, start_date?, end_date? }
//    POST /api/projectManager/completeSprint       { sprint_id, move_to: 'backlog'|<sprint_id> }
// =============================================================================

const sequelize = require("../config/db");
const { logActivity } = require("./_activity");

const STATUS_KEYS = ["in_discussion", "to_do", "in_work", "in_progress", "completed"];
const ISSUE_TYPES = ["story", "task", "bug", "epic", "subtask"];
const RANK_GAP = 1000;

// roles allowed to create / delete / fully edit board issues
const PM_ROLES = new Set(["pm", "project manager", "pmo", "admin"]);
const isManager = (req) => PM_ROLES.has(String(req.user?.role || "").toLowerCase());
// a resource/team-member may only move their card between statuses / sprints
const RESOURCE_EDITABLE = new Set(["id", "id", "status", "sprint_id", "rank_order", "resource"]);

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const toNum = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};
const fmtDate = (d) => {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().split("T")[0];
};
const parseJSON = (v, fb) => {
  if (v == null) return fb;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fb;
  }
};

// ─── schema guard (idempotent, once per process) ────────────────────────────
let ready = false;
const ensureSchema = async () => {
  if (ready) return;
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS boards (
      id INT NOT NULL AUTO_INCREMENT,
      item_key VARCHAR(24) DEFAULT NULL,
      type VARCHAR(16) NOT NULL DEFAULT 'task',
      project_id INT DEFAULT NULL,
      task_id INT DEFAULT NULL,
      sub_project_id INT DEFAULT NULL,
      sprint_id INT DEFAULT NULL,
      epic_id INT DEFAULT NULL,
      parent_id INT DEFAULT NULL,
      pm_id INT DEFAULT NULL,
      resource_id INT DEFAULT NULL,
      reporter_id INT DEFAULT NULL,
      title VARCHAR(255) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
      status VARCHAR(50) NOT NULL DEFAULT 'to_do',
      story_points DECIMAL(6,1) DEFAULT NULL,
      labels TEXT DEFAULT NULL,
      checklist LONGTEXT DEFAULT NULL,
      comments LONGTEXT DEFAULT NULL,
      due_date DATE DEFAULT NULL,
      attachments VARCHAR(255) DEFAULT NULL,
      rank_order BIGINT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      resolved_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_boards_project (project_id),
      KEY idx_boards_sprint (sprint_id, status, rank_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // add columns if boards pre-existed without them
  const cols = [
    ["item_key", "VARCHAR(24) DEFAULT NULL"],
    ["type", "VARCHAR(16) NOT NULL DEFAULT 'task'"],
    ["sprint_id", "INT DEFAULT NULL"],
    ["epic_id", "INT DEFAULT NULL"],
    ["parent_id", "INT DEFAULT NULL"],
    ["reporter_id", "INT DEFAULT NULL"],
    ["story_points", "DECIMAL(6,1) DEFAULT NULL"],
    ["labels", "TEXT DEFAULT NULL"],
    ["checklist", "LONGTEXT DEFAULT NULL"],
    ["comments", "LONGTEXT DEFAULT NULL"],
    ["rank_order", "BIGINT NOT NULL DEFAULT 0"],
    ["resolved_at", "DATETIME DEFAULT NULL"],
    ["task_id", "INT DEFAULT NULL"],
    ["due_date", "DATE DEFAULT NULL"],
    ["title", "VARCHAR(255) DEFAULT NULL"],
    ["updated_at", "DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"],
  ];
  for (const [c, ddl] of cols) {
    try {
      await sequelize.query(`ALTER TABLE boards ADD COLUMN ${c} ${ddl}`);
    } catch (e) {
      /* exists */
    }
  }
  try {
    await sequelize.query(`UPDATE boards SET priority = 'Medium' WHERE priority IS NULL OR priority = ''`);
    await sequelize.query(`ALTER TABLE boards MODIFY COLUMN priority VARCHAR(20) NOT NULL DEFAULT 'Medium'`);
  } catch (e) {
    /* ignore */
  }
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS sprints (
      id INT NOT NULL AUTO_INCREMENT,
      project_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      goal VARCHAR(500) DEFAULT NULL,
      state VARCHAR(12) NOT NULL DEFAULT 'future',
      start_date DATE DEFAULT NULL,
      end_date DATE DEFAULT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_sprint_project (project_id, state)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  ready = true;
};
// Exposed so other controllers that read `boards` (e.g. users.controller's
// getUserProjectDetail) don't depend on a backlog/board route having already
// run first in this process to pick up column migrations (idempotent).
exports.ensureBoardsSchema = ensureSchema;

// ─── helpers ───────────────────────────────────────────────────────────────
const getProjectPrefix = async (projectId) => {
  const rows = await sequelize.query(
    `SELECT project_code, project_name FROM projects WHERE id = :id LIMIT 1`,
    { replacements: { id: projectId }, type: sequelize.QueryTypes.SELECT }
  );
  const src = rows[0]?.project_name || rows[0]?.project_code || `P${projectId}`;
  const letters = String(src).replace(/[^A-Za-z]/g, "").toUpperCase();
  return (letters.slice(0, 3) || `P${projectId}`).padEnd(2, "X");
};

const nextItemKey = async (projectId) => {
  const prefix = await getProjectPrefix(projectId);
  const rows = await sequelize.query(
    `SELECT item_key FROM boards WHERE project_id = :pid AND item_key IS NOT NULL`,
    { replacements: { pid: projectId }, type: sequelize.QueryTypes.SELECT }
  );
  let max = 0;
  rows.forEach((r) => {
    const m = /(\d+)\s*$/.exec(r.item_key || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}-${max + 1}`;
};

const nextRank = async (projectId) => {
  const rows = await sequelize.query(
    `SELECT COALESCE(MAX(rank_order), 0) AS m FROM boards WHERE project_id = :pid`,
    { replacements: { pid: projectId }, type: sequelize.QueryTypes.SELECT }
  );
  return Number(rows[0]?.m || 0) + RANK_GAP;
};

const getActiveSprint = async (projectId) => {
  const rows = await sequelize.query(
    `SELECT * FROM sprints WHERE project_id = :pid AND state = 'active' ORDER BY id DESC LIMIT 1`,
    { replacements: { pid: projectId }, type: sequelize.QueryTypes.SELECT }
  );
  return rows[0] || null;
};

// issue row -> shape the frontend (board + backlog tables) expects
const shapeIssue = (r, extra = {}) => ({
  // Jira-ish — board_id kept alongside id for older frontend call sites
  // (ProjectBoardSection reads `.id` first and falls back to `.board_id`).
  id: r.id,
  board_id: r.id,
  item_key: r.item_key,
  type: r.type,
  title: r.title,
  summary: r.title,
  description: r.description,
  priority: r.priority || "Medium",
  status: r.status,
  story_points: r.story_points,
  sprint_id: r.sprint_id,
  epic_id: r.epic_id,
  parent_id: r.parent_id,
  labels: parseJSON(r.labels, []),
  checklist: parseJSON(r.checklist, []),
  comments: parseJSON(r.comments, []),
  rank_order: r.rank_order,
  resolved_at: r.resolved_at,
  is_completed: r.status === "completed",
  project_id: r.project_id,
  task_id: r.task_id,
  resource_id: r.resource_id,
  pm_id: r.pm_id,
  reporter_id: r.reporter_id,
  due_date: r.due_date,
  created_at: r.created_at,
  updated_at: r.updated_at,
  // legacy keys consumed by ProjectBacklogsSection / board backlog panel
  sub_project_name: r.title,
  project_name: r.project_name || extra.project_name,
  planned_end: r.due_date,
  resource_name: r.resource_name || null,
  resource_role: r.resource_role || null,
  assignee_avatar: r.assignee_avatar || null,
  epic_name: r.epic_name || null,
});

const SELECT_ISSUE = `
  SELECT b.*, p.project_name,
         u.name AS resource_name, u.role AS resource_role, u.image AS assignee_avatar,
         e.title AS epic_name
  FROM boards b
  LEFT JOIN projects p ON p.id = b.project_id
  LEFT JOIN users    u ON u.id = b.resource_id
  LEFT JOIN boards   e ON e.id = b.epic_id
`;

// =============================================================================
//  GET BACKLOG   POST { pm_id, project_id? }
// =============================================================================
exports.getBacklog = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const pmId = toInt(b.pm_id);
    const projectId = toInt(b.project_id);

    const where = ["b.is_active = 1"];
    const repl = {};
    if (projectId) {
      where.push("b.project_id = :projectId");
      repl.projectId = projectId;
    } else if (pmId) {
      where.push("b.pm_id = :pmId");
      repl.pmId = pmId;
    }

    const rows = await sequelize.query(
      `${SELECT_ISSUE} WHERE ${where.join(" AND ")} ORDER BY b.rank_order ASC, b.id ASC`,
      { replacements: repl, type: sequelize.QueryTypes.SELECT }
    );

    const backlog = [];
    const epics = [];
    const bySprint = {};
    rows.forEach((r) => {
      const shaped = shapeIssue(r);
      if (r.type === "epic") {
        epics.push(shaped);
        return;
      }
      if (r.sprint_id == null) backlog.push(shaped);
      else {
        (bySprint[r.sprint_id] = bySprint[r.sprint_id] || []).push(shaped);
      }
    });

    // sprints for this project (or the PM's projects)
    let sprintRows = [];
    if (projectId) {
      sprintRows = await sequelize.query(
        `SELECT * FROM sprints WHERE project_id = :pid ORDER BY sort_order, id`,
        { replacements: { pid: projectId }, type: sequelize.QueryTypes.SELECT }
      );
    } else if (pmId) {
      sprintRows = await sequelize.query(
        `SELECT s.* FROM sprints s
         JOIN projects p ON p.id = s.project_id
         WHERE p.project_manager_id = :pmId
         ORDER BY s.sort_order, s.id`,
        { replacements: { pmId }, type: sequelize.QueryTypes.SELECT }
      );
    }
    const sprints = sprintRows.map((s) => ({
      ...s,
      issues: bySprint[s.id] || [],
      total_points: (bySprint[s.id] || []).reduce((sum, i) => sum + (Number(i.story_points) || 0), 0),
    }));

    return res.status(200).json({
      success: true,
      count: backlog.length,
      data: backlog, // legacy: flat backlog list
      backlog,
      epics,
      sprints,
      active_sprint_id: sprints.find((s) => s.state === "active")?.id ?? null,
    });
  } catch (error) {
    console.error("getBacklog error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  GET BOARD   POST { pm_id, project_id }
//  active sprint ke issues, status columns me grouped
// =============================================================================
exports.getBoard = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const projectId = toInt(b.project_id);
    if (!projectId) {
      return res.status(400).json({ success: false, message: "project_id is required" });
    }

    const active = await getActiveSprint(projectId);

    const rows = active
      ? await sequelize.query(
          `${SELECT_ISSUE} WHERE b.is_active = 1 AND b.project_id = :pid AND b.sprint_id = :sid AND b.type <> 'epic'
           ORDER BY b.rank_order ASC, b.id ASC`,
          { replacements: { pid: projectId, sid: active.id }, type: sequelize.QueryTypes.SELECT }
        )
      : [];

    const data = {};
    STATUS_KEYS.forEach((k) => (data[k] = []));
    rows.forEach((r) => {
      const key = STATUS_KEYS.includes(r.status) ? r.status : "to_do";
      const shaped = shapeIssue(r);
      // board card legacy fields
      shaped.due_date = r.due_date;
      (data[key] = data[key] || []).push(shaped);
    });

    return res.status(200).json({
      success: true,
      message: "Board data fetched successfully",
      data,
      sprint: active
        ? {
            id: active.id,
            name: active.name,
            goal: active.goal,
            state: active.state,
            start_date: active.start_date,
            end_date: active.end_date,
          }
        : null,
    });
  } catch (error) {
    console.error("getBoard error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  CREATE ISSUE   POST /users/create_board
// =============================================================================
exports.createIssue = async (req, res) => {
  try {
    await ensureSchema();
    if (!isManager(req)) {
      return res.status(403).json({ success: false, message: "Only a project manager can create board issues." });
    }
    const b = req.body || {};
    const projectId = toInt(b.project_id);
    if (!projectId) {
      return res.status(400).json({ success: false, message: "project_id is required" });
    }

    const taskId = toInt(b.task_id);
    let title = b.title || b.summary || null;
    if (!title && taskId) {
      const t = await sequelize.query(
        `SELECT task_name FROM project_schedule WHERE id = :id LIMIT 1`,
        { replacements: { id: taskId }, type: sequelize.QueryTypes.SELECT }
      );
      title = t[0]?.task_name || null;
    }
    if (!title) title = "New issue";

    const type = ISSUE_TYPES.includes(String(b.type)) ? b.type : "task";
    const priority = b.priority || "Medium";
    const status = STATUS_KEYS.includes(String(b.status)) ? b.status : "to_do";
    const sprintId = b.sprint_id !== undefined ? toInt(b.sprint_id) : null;

    const [key, rank] = await Promise.all([nextItemKey(projectId), nextRank(projectId)]);
    const reporterId = toInt(b.reporter_id) || toInt(b.pm_id) || toInt(b.resource_id);

    const [boardId] = await sequelize.query(
      `
      INSERT INTO boards
        (item_key, type, project_id, task_id, sprint_id, epic_id, parent_id,
         pm_id, resource_id, reporter_id, title, description, priority, status,
         story_points, labels, due_date, rank_order)
      VALUES
        (:item_key, :type, :project_id, :task_id, :sprint_id, :epic_id, :parent_id,
         :pm_id, :resource_id, :reporter_id, :title, :description, :priority, :status,
         :story_points, :labels, :due_date, :rank_order)
      `,
      {
        replacements: {
          item_key: key,
          type,
          project_id: projectId,
          task_id: taskId,
          sprint_id: sprintId,
          epic_id: toInt(b.epic_id),
          parent_id: toInt(b.parent_id),
          pm_id: toInt(b.pm_id),
          resource_id: toInt(b.resource_id),
          reporter_id: reporterId,
          title,
          description: b.description || null,
          priority,
          status,
          story_points: toNum(b.story_points),
          labels: b.labels ? JSON.stringify(b.labels) : null,
          due_date: fmtDate(b.due_date),
          rank_order: rank,
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );

    const rows = await sequelize.query(`${SELECT_ISSUE} WHERE b.id = :id`, {
      replacements: { id: boardId },
      type: sequelize.QueryTypes.SELECT,
    });

    return res.status(201).json({
      success: true,
      message: "Issue created",
      data: rows[0] ? shapeIssue(rows[0]) : { id: boardId, item_key: key },
    });
  } catch (error) {
    console.error("createIssue error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  EDIT ISSUE   POST /users/editBoard    { id, ...fields }
// =============================================================================
exports.editIssue = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const id = toInt(b.id ?? b.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });

    // Non-managers can only change status / sprint / rank on the board — any
    // other field patch (title, assignee, priority, dates, labels, delete…) is
    // rejected so the "user section" board stays view + status-update only.
    if (!isManager(req)) {
      const touched = Object.keys(b).filter((k) => !RESOURCE_EDITABLE.has(k) && b[k] !== undefined && b[k] !== "");
      if (touched.length) {
        return res.status(403).json({
          success: false,
          message: "You can update the status of your tasks, but other changes are made by your project manager.",
        });
      }
    }

    const cols = {
      title: () => (b.title == null ? null : String(b.title)),
      summary: () => (b.summary == null ? null : String(b.summary)),
      description: () => (b.description == null ? null : String(b.description)),
      type: () => (ISSUE_TYPES.includes(String(b.type)) ? b.type : "task"),
      priority: () => b.priority || "Medium",
      status: () => String(b.status),
      resource_id: () => toInt(b.resource_id),
      assignee_id: () => toInt(b.assignee_id),
      pm_id: () => toInt(b.pm_id),
      project_id: () => toInt(b.project_id),
      task_id: () => toInt(b.task_id),
      sprint_id: () => (b.sprint_id === null || b.sprint_id === "null" ? null : toInt(b.sprint_id)),
      epic_id: () => toInt(b.epic_id),
      parent_id: () => toInt(b.parent_id),
      story_points: () => toNum(b.story_points),
      rank_order: () => toInt(b.rank_order),
      due_date: () => fmtDate(b.due_date),
      labels: () => (b.labels == null ? null : JSON.stringify(b.labels)),
      // checklist / comments arrive as a JSON string from the card modal;
      // store as-is if already a string, else stringify.
      checklist: () => (b.checklist == null ? null : (typeof b.checklist === "string" ? b.checklist : JSON.stringify(b.checklist))),
      comments: () => (b.comments == null ? null : (typeof b.comments === "string" ? b.comments : JSON.stringify(b.comments))),
    };
    // column aliases: which body key writes which db column
    const map = {
      title: "title",
      summary: "title",
      description: "description",
      type: "type",
      priority: "priority",
      status: "status",
      resource_id: "resource_id",
      assignee_id: "resource_id",
      pm_id: "pm_id",
      project_id: "project_id",
      task_id: "task_id",
      sprint_id: "sprint_id",
      epic_id: "epic_id",
      parent_id: "parent_id",
      story_points: "story_points",
      rank_order: "rank_order",
      due_date: "due_date",
      labels: "labels",
      checklist: "checklist",
      comments: "comments",
    };

    const sets = [];
    const repl = { id };
    const seen = new Set();
    for (const key of Object.keys(map)) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
      if (b[key] === "" && key !== "title" && key !== "summary") continue;
      const col = map[key];
      if (seen.has(col)) continue;
      seen.add(col);
      sets.push(`${col} = :${col}`);
      repl[col] = cols[key]();
    }
    if (req.file) {
      sets.push("attachments = :attachments");
      repl.attachments = req.file.filename;
    }
    // completed -> stamp resolved_at
    if (Object.prototype.hasOwnProperty.call(b, "status")) {
      sets.push("resolved_at = :resolved_at");
      repl.resolved_at = String(b.status) === "completed" ? new Date() : null;
    }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, message: "No updatable field provided" });
    }

    await sequelize.query(`UPDATE boards SET ${sets.join(", ")} WHERE id = :id`, {
      replacements: repl,
      type: sequelize.QueryTypes.UPDATE,
    });

    const rows = await sequelize.query(`${SELECT_ISSUE} WHERE b.id = :id`, {
      replacements: { id },
      type: sequelize.QueryTypes.SELECT,
    });

    return res
      .status(200)
      .json({ success: true, message: "Issue updated", data: rows[0] ? shapeIssue(rows[0]) : null });
  } catch (error) {
    console.error("editIssue error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  DELETE ISSUE   POST /users/deleteBoard   { id }
// =============================================================================
exports.deleteIssue = async (req, res) => {
  try {
    await ensureSchema();
    if (!isManager(req)) {
      return res.status(403).json({ success: false, message: "Only a project manager can delete board issues." });
    }
    const id = toInt((req.body || {}).id ?? (req.body || {}).id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    await sequelize.query(
      `UPDATE boards SET is_active = 0 WHERE id = :id OR parent_id = :id`,
      { replacements: { id }, type: sequelize.QueryTypes.UPDATE }
    );
    return res.status(200).json({ success: true, message: "Issue deleted" });
  } catch (error) {
    console.error("deleteIssue error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  MOVE TO SPRINT   POST { id, sprint_id | null, status? }
// =============================================================================
exports.moveToSprint = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const id = toInt(b.id ?? b.id ?? b.item_id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });

    const toBacklog = b.sprint_id === null || b.sprint_id === "null" || b.sprint_id === undefined;
    const sprintId = toBacklog ? null : toInt(b.sprint_id);
    const status = STATUS_KEYS.includes(String(b.status))
      ? b.status
      : toBacklog
      ? "to_do"
      : "to_do";

    await sequelize.query(
      `UPDATE boards SET sprint_id = :sprint_id, status = :status WHERE id = :id`,
      { replacements: { sprint_id: sprintId, status, id }, type: sequelize.QueryTypes.UPDATE }
    );

    return res.status(200).json({
      success: true,
      message: toBacklog ? "Moved to backlog" : "Moved to sprint",
      data: { id: id, sprint_id: sprintId, status },
    });
  } catch (error) {
    console.error("moveToSprint error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  RANK ITEM   POST { id, before_id?, after_id? }
//  before_id : is item ke UPAR rakho     after_id : is item ke NEECHE rakho
// =============================================================================
exports.rankItem = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const id = toInt(b.id ?? b.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });

    const rankOf = async (x) => {
      if (!x) return null;
      const r = await sequelize.query(`SELECT rank_order FROM boards WHERE id = :x LIMIT 1`, {
        replacements: { x: toInt(x) },
        type: sequelize.QueryTypes.SELECT,
      });
      return r[0] ? Number(r[0].rank_order) : null;
    };

    let target;
    const beforeRank = await rankOf(b.before_id); // place ABOVE this -> smaller rank
    const afterRank = await rankOf(b.after_id); // place BELOW this  -> larger rank

    if (beforeRank != null && afterRank != null) {
      target = (beforeRank + afterRank) / 2;
    } else if (beforeRank != null) {
      target = beforeRank - RANK_GAP / 2;
    } else if (afterRank != null) {
      target = afterRank + RANK_GAP / 2;
    } else {
      const mx = await sequelize.query(
        `SELECT COALESCE(MAX(b.rank_order),0) AS m FROM boards b
         JOIN boards me ON me.id = :id
         WHERE b.project_id = me.project_id`,
        { replacements: { id }, type: sequelize.QueryTypes.SELECT }
      );
      target = Number(mx[0]?.m || 0) + RANK_GAP;
    }

    await sequelize.query(`UPDATE boards SET rank_order = :r WHERE id = :id`, {
      replacements: { r: Math.round(target), id },
      type: sequelize.QueryTypes.UPDATE,
    });

    return res.status(200).json({ success: true, message: "Rank updated", data: { id: id, rank_order: Math.round(target) } });
  } catch (error) {
    console.error("rankItem error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  SPRINTS
// =============================================================================
exports.getSprints = async (req, res) => {
  try {
    await ensureSchema();
    const projectId = toInt((req.body || {}).project_id ?? req.query.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });

    const rows = await sequelize.query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM boards b WHERE b.sprint_id = s.id AND b.is_active = 1) AS issue_count,
              (SELECT COALESCE(SUM(b.story_points),0) FROM boards b WHERE b.sprint_id = s.id AND b.is_active = 1) AS total_points
       FROM sprints s WHERE s.project_id = :pid ORDER BY s.sort_order, s.id`,
      { replacements: { pid: projectId }, type: sequelize.QueryTypes.SELECT }
    );
    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("getSprints error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createSprint = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const projectId = toInt(b.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });

    const cnt = await sequelize.query(
      `SELECT COUNT(*) AS n FROM sprints WHERE project_id = :pid`,
      { replacements: { pid: projectId }, type: sequelize.QueryTypes.SELECT }
    );
    const n = Number(cnt[0]?.n || 0) + 1;
    const name = b.name || `Sprint ${n}`;

    const [id] = await sequelize.query(
      `INSERT INTO sprints (project_id, name, goal, state, sort_order) VALUES (:pid, :name, :goal, 'future', :ord)`,
      { replacements: { pid: projectId, name, goal: b.goal || null, ord: n }, type: sequelize.QueryTypes.INSERT }
    );
    return res.status(201).json({ success: true, message: "Sprint created", data: { id, name } });
  } catch (error) {
    console.error("createSprint error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.startSprint = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const sprintId = toInt(b.sprint_id ?? b.id);
    if (!sprintId) return res.status(400).json({ success: false, message: "sprint_id is required" });

    const s = await sequelize.query(`SELECT * FROM sprints WHERE id = :id LIMIT 1`, {
      replacements: { id: sprintId },
      type: sequelize.QueryTypes.SELECT,
    });
    if (!s.length) return res.status(404).json({ success: false, message: "Sprint not found" });
    if (s[0].state === "active") {
      return res.status(200).json({ success: true, message: "Sprint already active" });
    }

    // Jira: ek board par ek hi active sprint — pehle active wala complete karo
    const others = await sequelize.query(
      `SELECT id, name FROM sprints WHERE project_id = :pid AND state = 'active' AND id <> :id LIMIT 1`,
      { replacements: { pid: s[0].project_id, id: sprintId }, type: sequelize.QueryTypes.SELECT }
    );
    if (others.length) {
      return res.status(409).json({
        success: false,
        message: `"${others[0].name}" is already active. Complete it before starting another sprint.`,
      });
    }

    const today = new Date().toISOString().split("T")[0];
    const end = new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0];
    await sequelize.query(
      `UPDATE sprints SET state = 'active', start_date = :sd, end_date = :ed WHERE id = :id`,
      { replacements: { id: sprintId, sd: fmtDate(b.start_date) || today, ed: fmtDate(b.end_date) || end } }
    );
    logActivity({ entity_type: "sprint", entity_id: String(sprintId), project_id: s[0].project_id, action: "started", detail: `Started "${s[0].name}"` });
    return res.status(200).json({ success: true, message: "Sprint started" });
  } catch (error) {
    console.error("startSprint error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.completeSprint = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const sprintId = toInt(b.sprint_id ?? b.id);
    if (!sprintId) return res.status(400).json({ success: false, message: "sprint_id is required" });

    // incomplete issues kahan jayenge
    const moveTo = b.move_to === "backlog" || b.move_to == null ? null : toInt(b.move_to);
    await sequelize.query(
      `UPDATE boards SET sprint_id = :moveTo
       WHERE sprint_id = :sid AND is_active = 1 AND status <> 'completed'`,
      { replacements: { moveTo, sid: sprintId } }
    );
    await sequelize.query(
      `UPDATE sprints SET state = 'closed', completed_at = NOW() WHERE id = :id`,
      { replacements: { id: sprintId } }
    );
    logActivity({ entity_type: "sprint", entity_id: String(sprintId), action: "completed", detail: "Sprint completed; incomplete work carried over" });
    return res.status(200).json({ success: true, message: "Sprint completed" });
  } catch (error) {
    console.error("completeSprint error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  SYNC SCHEDULE -> BACKLOG
//  POST /api/projectManager/sync_schedule_backlog   { project_id, pm_id? }
//  For every active, non-completed project_schedule task that has no matching
//  board card (by task_id), create a backlog issue (sprint_id NULL). Lets an
//  approved Gantt plan seed the Kanban backlog. Idempotent — re-run only adds
//  the tasks that don't have a card yet.
// =============================================================================
exports.syncScheduleToBacklog = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const projectId = toInt(b.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });
    const pmId = toInt(b.pm_id);

    const tasks = await sequelize.query(
      `SELECT s.id, s.task_name, s.status, s.priority, s.resource_id, s.planned_end, s.is_milestone
         FROM project_schedule s
        WHERE s.project_id = :pid AND s.is_active = 1
          AND (s.status IS NULL OR s.status <> 'completed')
          AND NOT EXISTS (
            SELECT 1 FROM boards bd
             WHERE bd.project_id = :pid AND bd.task_id = s.id AND bd.is_active = 1
          )
        ORDER BY s.sort_order, s.id`,
      { replacements: { pid: projectId }, type: sequelize.QueryTypes.SELECT }
    );

    if (tasks.length === 0) {
      return res.status(200).json({ success: true, created: 0, data: [], message: "Backlog is already in sync with the schedule" });
    }

    const prefix = await getProjectPrefix(projectId);
    const keyRows = await sequelize.query(
      `SELECT item_key FROM boards WHERE project_id = :pid AND item_key IS NOT NULL`,
      { replacements: { pid: projectId }, type: sequelize.QueryTypes.SELECT }
    );
    let maxN = 0;
    keyRows.forEach((r) => {
      const m = /(\d+)\s*$/.exec(r.item_key || "");
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    });
    let rank = await nextRank(projectId);

    const created = [];
    for (const t of tasks) {
      maxN += 1;
      const key = `${prefix}-${maxN}`;
      const status = STATUS_KEYS.includes(String(t.status)) ? t.status : "to_do";
      const [boardId] = await sequelize.query(
        `INSERT INTO boards
           (item_key, type, project_id, task_id, sprint_id, pm_id, resource_id, reporter_id,
            title, priority, status, due_date, rank_order)
         VALUES
           (:key, :type, :pid, :task_id, NULL, :pm, :rid, :pm, :title, :prio, :status, :due, :rank)`,
        {
          replacements: {
            key,
            type: t.is_milestone ? "story" : "task",
            pid: projectId,
            task_id: t.id,
            pm: pmId,
            rid: toInt(t.resource_id),
            title: t.task_name || "Untitled task",
            prio: t.priority || "Medium",
            status,
            due: fmtDate(t.planned_end),
            rank,
          },
          type: sequelize.QueryTypes.INSERT,
        }
      );
      rank += RANK_GAP;
      created.push({ id: boardId, item_key: key, title: t.task_name });
    }

    logActivity({
      entity_type: "board", project_id: projectId, actor_id: pmId, action: "synced",
      detail: `${created.length} schedule task(s) pulled into the backlog`,
    });
    return res.status(200).json({
      success: true,
      created: created.length,
      data: created,
      message: `${created.length} task(s) added to the backlog`,
    });
  } catch (error) {
    console.error("syncScheduleToBacklog error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
