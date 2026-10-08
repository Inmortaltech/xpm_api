// =============================================================================
//  CLIENT PORTAL  (Celoxis stakeholder access — scoped, read-only, sanitised)
//
//  POST /api/client/my_projects        { user_id }
//  POST /api/client/project_view       { user_id, project_id }
//  POST /api/client/grant_access       { user_id, project_id, can_view_financials? }   (PMO)
//  POST /api/client/revoke_access      { user_id, project_id }                         (PMO)
//
//  A client only ever sees projects in client_access. Financials are hidden
//  unless can_view_financials = 1. No task-level internal data, no costs.
// =============================================================================

const sequelize = require("../config/db");
const S = (q, r) => sequelize.query(q, { replacements: r || {}, type: sequelize.QueryTypes.SELECT });
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

let ready = false;
const ensure = async () => {
  if (ready) return;
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS client_access (
      id INT NOT NULL AUTO_INCREMENT, user_id INT NOT NULL, project_id INT NOT NULL,
      can_view_financials TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_client_project (user_id, project_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  ready = true;
};

const assertClient = async (userId) => {
  const u = await S(`SELECT id, role FROM users WHERE id = :id LIMIT 1`, { id: userId });
  if (!u.length) return { ok: false, code: 404, msg: "User not found" };
  if (String(u[0].role || "").toLowerCase() !== "client") {
    return { ok: false, code: 403, msg: "Not a client account" };
  }
  return { ok: true };
};

exports.myProjects = async (req, res) => {
  try {
    await ensure();
    const userId = toInt((req.body || {}).user_id ?? req.query.user_id);
    if (!userId) return res.status(400).json({ success: false, message: "user_id is required" });
    const chk = await assertClient(userId);
    if (!chk.ok) return res.status(chk.code).json({ success: false, message: chk.msg });

    const { _enrichProject } = require("./analytics.controller");
    const rows = await S(
      `SELECT p.*, ca.can_view_financials
       FROM client_access ca JOIN projects p ON p.id = ca.project_id
       WHERE ca.user_id = :uid`,
      { uid: userId }
    );
    const data = [];
    for (const p of rows) {
      let e;
      try { e = await _enrichProject(p); } catch { e = p; }
      data.push({
        id: e.id,
        project_code: e.project_code,
        project_name: e.project_name,
        status: e.status,
        health: e.health,
        progress: e.progress,
        start_date: e.start_date,
        end_date: e.end_date,
        project_manager: e.project_manager,
        // financials only if granted
        budget: p.can_view_financials ? e.budget : undefined,
      });
    }
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("client.myProjects error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.projectView = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const userId = toInt(b.user_id);
    const projectId = toInt(b.project_id);
    if (!userId || !projectId) return res.status(400).json({ success: false, message: "user_id and project_id are required" });
    const chk = await assertClient(userId);
    if (!chk.ok) return res.status(chk.code).json({ success: false, message: chk.msg });

    const [access] = await S(`SELECT can_view_financials FROM client_access WHERE user_id = :uid AND project_id = :pid`, { uid: userId, pid: projectId });
    if (!access) return res.status(403).json({ success: false, message: "No access to this project" });

    const [p] = await S(`SELECT * FROM projects WHERE id = :id`, { id: projectId });
    if (!p) return res.status(404).json({ success: false, message: "Project not found" });

    const { _enrichProject } = require("./analytics.controller");
    let e;
    try { e = await _enrichProject(p); } catch { e = p; }

    // milestone-level status only (safe for a client to see)
    let milestones = [];
    try { milestones = JSON.parse(p.milestones || "[]"); } catch { milestones = []; }
    const today = new Date();
    milestones = (Array.isArray(milestones) ? milestones : []).map((m) => ({
      name: m.milestone || m.name,
      date: m.milestone_date || m.date,
      percentage: m.percentage ?? m.pct,
      status: m.milestone_date && new Date(m.milestone_date) <= today ? "done" : "upcoming",
    }));

    // recent client-safe activity (no internal cost/timesheet detail)
    const activity = await S(
      `SELECT action, detail, created_at FROM activity_log
       WHERE project_id = :pid AND entity_type IN ('project','sprint','milestone')
       ORDER BY id DESC LIMIT 10`,
      { pid: projectId }
    ).catch(() => []);

    const out = {
      project: {
        code: e.project_code,
        name: e.project_name,
        status: e.status,
        health: e.health,
        progress: e.progress,
        start_date: e.start_date,
        end_date: e.end_date,
        project_manager: e.project_manager,
        scope: p.project_scope || null,
      },
      milestones,
      activity,
    };
    if (access.can_view_financials) {
      out.financials = {
        budget: Number(e.budget) || 0,
        billed: Number(p.billed_amount) || 0,
      };
      // AR outstanding for this project
      const [ar] = await S(
        `SELECT COALESCE(SUM(total - paid_amount),0) AS out FROM invoices WHERE project_id = :pid AND status IN ('sent','overdue')`,
        { pid: projectId }
      ).catch(() => [{ out: 0 }]);
      out.financials.outstanding = Number(ar?.out) || 0;
    }
    return res.status(200).json({ success: true, data: out });
  } catch (error) {
    console.error("client.projectView error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.grantAccess = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const userId = toInt(b.user_id);
    const projectId = toInt(b.project_id);
    if (!userId || !projectId) return res.status(400).json({ success: false, message: "user_id and project_id are required" });
    await sequelize.query(
      `INSERT INTO client_access (user_id, project_id, can_view_financials)
       VALUES (:uid, :pid, :fin)
       ON DUPLICATE KEY UPDATE can_view_financials = VALUES(can_view_financials)`,
      { replacements: { uid: userId, pid: projectId, fin: b.can_view_financials ? 1 : 0 } }
    );
    return res.status(200).json({ success: true, message: "Client access granted" });
  } catch (error) {
    console.error("client.grantAccess error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /access_list  — PMO admin view: every Client user + their project grants
exports.accessList = async (req, res) => {
  try {
    await ensure();
    const clients = await S(
      `SELECT id, name, email FROM users WHERE LOWER(role) = 'client' ORDER BY name`
    );
    const grants = await S(
      `SELECT ca.user_id, ca.project_id, ca.can_view_financials, p.project_name, p.project_code
       FROM client_access ca LEFT JOIN projects p ON p.id = ca.project_id`
    );
    const byUser = {};
    grants.forEach((g) => {
      (byUser[g.user_id] = byUser[g.user_id] || []).push({
        project_id: g.project_id,
        project_name: g.project_name,
        project_code: g.project_code,
        can_view_financials: !!g.can_view_financials,
      });
    });
    const allProjects = await S(
      `SELECT id, project_code, project_name FROM projects ORDER BY id DESC`
    );
    return res.status(200).json({
      success: true,
      data: {
        clients: clients.map((c) => ({ ...c, projects: byUser[c.id] || [] })),
        all_projects: allProjects,
      },
    });
  } catch (error) {
    console.error("client.accessList error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.revokeAccess = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    await sequelize.query(`DELETE FROM client_access WHERE user_id = :uid AND project_id = :pid`, {
      replacements: { uid: toInt(b.user_id), pid: toInt(b.project_id) },
    });
    return res.status(200).json({ success: true, message: "Client access revoked" });
  } catch (error) {
    console.error("client.revokeAccess error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
