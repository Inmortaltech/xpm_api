// =============================================================================
//  APPROVAL ENGINE  (Celoxis configurable multi-step approvals)
//
//  POST /api/admin/create_approval     { entity_type, entity_id?, project_id?, title,
//                                        summary?, amount?, requested_by?,
//                                        steps:[{ approver_id?, approver_role? }] }
//  POST /api/admin/approval_decide     { approval_id, approver_id, decision: approve|reject|delegate,
//                                        note?, delegate_to? }
//  POST /api/admin/my_approvals        { approver_id }          -> engine items pending on me
//  GET  /api/admin/approval_detail     ?id
//  GET  /api/admin/approvals_inbox     ?approver_id&role        -> UNIFIED inbox: engine items
//                                        + the 4 legacy queues (resource change,
//                                        schedule freeze, timesheet, expense)
// =============================================================================

const sequelize = require("../config/db");
const { logActivity } = require("./_activity");

const S = (q, r) => sequelize.query(q, { replacements: r || {}, type: sequelize.QueryTypes.SELECT });
const X = (q, r) => sequelize.query(q, r && r.replacements ? r : { replacements: r || {} });
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

let ready = false;
const ensure = async () => {
  if (ready) return;
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS approvals (
      id INT NOT NULL AUTO_INCREMENT, entity_type VARCHAR(40) NOT NULL, entity_id VARCHAR(40) DEFAULT NULL,
      project_id INT DEFAULT NULL, title VARCHAR(255) NOT NULL, summary VARCHAR(500) DEFAULT NULL,
      requested_by INT DEFAULT NULL, requested_by_name VARCHAR(150) DEFAULT NULL, amount DECIMAL(15,2) DEFAULT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending', current_step INT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id), KEY idx_appr_status (status), KEY idx_appr_entity (entity_type, entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS approval_steps (
      id INT NOT NULL AUTO_INCREMENT, approval_id INT NOT NULL, step_no INT NOT NULL DEFAULT 1,
      approver_id INT DEFAULT NULL, approver_role VARCHAR(60) DEFAULT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending',
      decided_at DATETIME DEFAULT NULL, delegated_to INT DEFAULT NULL, note VARCHAR(500) DEFAULT NULL,
      PRIMARY KEY (id), KEY idx_astep_appr (approval_id, step_no), KEY idx_astep_approver (approver_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Part B — SLA / escalation columns (guarded, run-once)
  for (const ddl of [
    `ALTER TABLE approvals ADD COLUMN sla_hours INT NOT NULL DEFAULT 48`,
    `ALTER TABLE approval_steps ADD COLUMN assigned_at DATETIME DEFAULT NULL`,
    `ALTER TABLE approval_steps ADD COLUMN due_at DATETIME DEFAULT NULL`,
    `ALTER TABLE approval_steps ADD COLUMN escalated TINYINT(1) NOT NULL DEFAULT 0`,
    `ALTER TABLE approval_steps ADD COLUMN escalated_at DATETIME DEFAULT NULL`,
    `ALTER TABLE approval_steps ADD COLUMN reminded_at DATETIME DEFAULT NULL`,
  ]) {
    try { await sequelize.query(ddl); } catch (_) { /* column exists */ }
  }
  ready = true;
};

// how long before a step's due_at we send a "due soon" reminder
const REMINDER_LEAD_HOURS = Number(process.env.APPROVAL_REMINDER_LEAD_HOURS || 12);

// classify a pending step against its SLA clock
function slaState(step) {
  if (!step || !step.due_at) return "ok";
  if (step.escalated) return "escalated";
  const now = Date.now();
  const due = new Date(step.due_at).getTime();
  if (now > due) return "overdue";
  if (due - now <= REMINDER_LEAD_HOURS * 3600_000) return "due_soon";
  return "ok";
}

exports.createApproval = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    if (!b.title || !b.entity_type) {
      return res.status(400).json({ success: false, message: "entity_type and title are required" });
    }
    let steps = Array.isArray(b.steps) && b.steps.length ? b.steps : [{ approver_role: "PMO" }];
    const slaHours = Math.max(1, toInt(b.sla_hours) || 48);

    let name = null;
    if (b.requested_by) {
      const u = await S(`SELECT name FROM users WHERE id = :id`, { id: toInt(b.requested_by) });
      name = u[0]?.name || null;
    }

    const [id] = await sequelize.query(
      `INSERT INTO approvals (entity_type, entity_id, project_id, title, summary, requested_by, requested_by_name, amount, sla_hours)
       VALUES (:et, :eid, :pid, :title, :summary, :by, :byname, :amt, :sla)`,
      {
        replacements: {
          et: b.entity_type, eid: b.entity_id != null ? String(b.entity_id) : null,
          pid: toInt(b.project_id), title: b.title, summary: b.summary || null,
          by: toInt(b.requested_by), byname: name, amt: b.amount != null ? Number(b.amount) : null,
          sla: slaHours,
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );
    let n = 0;
    for (const s of steps) {
      n += 1;
      // step 1 starts its SLA clock immediately; later steps get theirs when reached
      await X(
        `INSERT INTO approval_steps
           (approval_id, step_no, approver_id, approver_role, status, assigned_at, due_at)
         VALUES (:aid, :n, :approver, :role, 'pending',
                 ${n === 1 ? "NOW()" : "NULL"},
                 ${n === 1 ? "NOW() + INTERVAL :sla HOUR" : "NULL"})`,
        { aid: id, n, approver: toInt(s.approver_id), role: s.approver_role || null, sla: slaHours }
      );
    }
    await logActivity({ entity_type: "approval", entity_id: String(id), project_id: toInt(b.project_id), actor_id: toInt(b.requested_by), action: "requested", detail: b.title });
    return res.status(201).json({ success: true, message: "Approval requested", data: { id, steps: n } });
  } catch (error) {
    console.error("createApproval error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.approvalDecide = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const id = toInt(b.approval_id ?? b.id);
    const approverId = toInt(b.approver_id);
    const decision = String(b.decision || "").toLowerCase();
    if (!id || !["approve", "reject", "delegate"].includes(decision)) {
      return res.status(400).json({ success: false, message: "approval_id and decision (approve|reject|delegate) required" });
    }

    const [appr] = await S(`SELECT * FROM approvals WHERE id = :id`, { id });
    if (!appr) return res.status(404).json({ success: false, message: "Approval not found" });
    if (appr.status !== "pending") {
      return res.status(409).json({ success: false, message: `Already ${appr.status}` });
    }
    const [step] = await S(
      `SELECT * FROM approval_steps WHERE approval_id = :id AND step_no = :n LIMIT 1`,
      { id, n: appr.current_step }
    );
    if (!step) return res.status(400).json({ success: false, message: "No current step" });

    if (decision === "delegate") {
      const to = toInt(b.delegate_to);
      if (!to) return res.status(400).json({ success: false, message: "delegate_to is required" });
      await X(`UPDATE approval_steps SET status='delegated', delegated_to=:to, decided_at=NOW(), note=:note WHERE id=:sid`, { replacements: { to, note: b.note || null, sid: step.id } });
      await X(
        `INSERT INTO approval_steps (approval_id, step_no, approver_id, approver_role, status)
         VALUES (:aid, :n, :to, NULL, 'pending')`,
        { replacements: { aid: id, n: appr.current_step, to } }
      );
      // keep current_step the same (new pending row at same step_no)
      return res.status(200).json({ success: true, message: "Delegated" });
    }

    await X(`UPDATE approval_steps SET status=:st, decided_at=NOW(), note=:note WHERE id=:sid`, {
      replacements: { st: decision === "approve" ? "approved" : "rejected", note: b.note || null, sid: step.id },
    });

    if (decision === "reject") {
      await X(`UPDATE approvals SET status='rejected', closed_at=NOW() WHERE id=:id`, { replacements: { id } });
      await logActivity({ entity_type: "approval", entity_id: String(id), project_id: appr.project_id, actor_id: approverId, action: "rejected", detail: `${appr.title}: ${b.note || "no reason"}` });
      return res.status(200).json({ success: true, message: "Rejected", data: { status: "rejected" } });
    }

    // approve -> advance
    const [more] = await S(
      `SELECT COUNT(*) AS n FROM approval_steps WHERE approval_id = :id AND step_no > :n`,
      { id, n: appr.current_step }
    );
    if (Number(more.n) > 0) {
      await X(`UPDATE approvals SET current_step = current_step + 1 WHERE id = :id`, { replacements: { id } });
      // start the SLA clock on the step we just moved to
      await X(
        `UPDATE approval_steps
            SET assigned_at = NOW(), due_at = NOW() + INTERVAL :sla HOUR, escalated = 0, reminded_at = NULL
          WHERE approval_id = :id AND step_no = :n AND status = 'pending'`,
        { replacements: { id, n: appr.current_step + 1, sla: Number(appr.sla_hours) || 48 } }
      );
      return res.status(200).json({ success: true, message: "Approved — advanced to next step", data: { status: "pending", next_step: appr.current_step + 1 } });
    }
    await X(`UPDATE approvals SET status='approved', closed_at=NOW() WHERE id=:id`, { replacements: { id } });
    await logActivity({ entity_type: "approval", entity_id: String(id), project_id: appr.project_id, actor_id: approverId, action: "approved", detail: appr.title });
    return res.status(200).json({ success: true, message: "Approved", data: { status: "approved" } });
  } catch (error) {
    console.error("approvalDecide error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.myApprovals = async (req, res) => {
  try {
    await ensure();
    const approverId = toInt((req.body || {}).approver_id ?? req.query.approver_id);
    const role = (req.body || {}).role || req.query.role || null;
    const rows = await S(
      `SELECT a.*, s.id AS step_id, s.step_no, s.approver_role
       FROM approvals a
       JOIN approval_steps s ON s.approval_id = a.id AND s.step_no = a.current_step AND s.status = 'pending'
       WHERE a.status = 'pending'
         AND ( (:approverId IS NOT NULL AND s.approver_id = :approverId)
            OR (:role IS NOT NULL AND s.approver_role = :role) )
       ORDER BY a.created_at ASC`,
      { approverId, role }
    );
    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("myApprovals error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.approvalDetail = async (req, res) => {
  try {
    await ensure();
    const id = toInt(req.query.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    const [a] = await S(`SELECT * FROM approvals WHERE id = :id`, { id });
    if (!a) return res.status(404).json({ success: false, message: "Not found" });
    const steps = await S(`SELECT * FROM approval_steps WHERE approval_id = :id ORDER BY step_no, id`, { id });
    return res.status(200).json({ success: true, data: { ...a, steps } });
  } catch (error) {
    console.error("approvalDetail error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  B2.  SLA SWEEP  —  overdue steps escalate, "due soon" steps get a reminder.
//  Best-effort, never throws. Writes notifications + activity_log rows.
//  Trigger: in-process interval (server.js), manual POST /run_approval_sla,
//  or opportunistically on every approvals_inbox read (throttled).
// =============================================================================
async function notify(userId, title, message, projectId) {
  try {
    await sequelize.query(
      `INSERT INTO notifications (user_id, type, title, message, project_id)
       VALUES (:uid, 'APPROVAL_SLA', :title, :msg, :pid)`,
      { replacements: { uid: userId || null, title, msg: message || null, pid: projectId != null ? String(projectId) : null } }
    );
  } catch (_) { /* notifications table absent — skip */ }
}

let _lastSweep = 0;
async function runApprovalSla({ force = false } = {}) {
  await ensure();
  const now = Date.now();
  if (!force && now - _lastSweep < 60_000) return { skipped: true };
  _lastSweep = now;

  const escalated = [];
  const reminded = [];

  // current pending step of every pending approval, with its clock
  const steps = await S(
    `SELECT s.id, s.approval_id, s.step_no, s.approver_id, s.approver_role,
            s.due_at, s.escalated, s.reminded_at,
            a.title, a.project_id, a.requested_by
       FROM approval_steps s
       JOIN approvals a ON a.id = s.approval_id AND a.status = 'pending' AND a.current_step = s.step_no
      WHERE s.status = 'pending' AND s.due_at IS NOT NULL`
  ).catch(() => []);

  // PMO recipients for escalation fan-out
  const pmo = await S(`SELECT id FROM users WHERE LOWER(role) IN ('pmo','admin') AND (status IS NULL OR status <> 'disable')`).catch(() => []);

  for (const st of steps) {
    const due = new Date(st.due_at).getTime();
    if (now > due && !st.escalated) {
      await X(`UPDATE approval_steps SET escalated = 1, escalated_at = NOW() WHERE id = :sid`, { replacements: { sid: st.id } });
      await logActivity({
        entity_type: "approval", entity_id: String(st.approval_id), project_id: st.project_id,
        action: "escalated", detail: `SLA breached on step ${st.step_no} — "${st.title}"`,
      });
      const targets = new Set();
      if (st.approver_id) targets.add(st.approver_id);
      pmo.forEach((p) => targets.add(p.id));
      for (const uid of targets) {
        await notify(uid, "Approval overdue", `"${st.title}" (step ${st.step_no}) has passed its SLA and needs a decision.`, st.project_id);
      }
      escalated.push({ approval_id: st.approval_id, step_no: st.step_no, title: st.title });
    } else if (now <= due && due - now <= REMINDER_LEAD_HOURS * 3600_000 && !st.reminded_at) {
      await X(`UPDATE approval_steps SET reminded_at = NOW() WHERE id = :sid`, { replacements: { sid: st.id } });
      if (st.approver_id) {
        await notify(st.approver_id, "Approval due soon", `"${st.title}" (step ${st.step_no}) is due within ${REMINDER_LEAD_HOURS}h.`, st.project_id);
      }
      reminded.push({ approval_id: st.approval_id, step_no: st.step_no, title: st.title });
    }
  }
  return { skipped: false, escalated, reminded, checked: steps.length };
}
exports.runApprovalSla = runApprovalSla;

// POST /api/admin/run_approval_sla
exports.runApprovalSlaHandler = async (_req, res) => {
  try {
    const out = await runApprovalSla({ force: true });
    return res.status(200).json({ success: true, ...out });
  } catch (error) {
    console.error("runApprovalSla error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── UNIFIED INBOX — engine items + the 4 hard-wired queues in one shape ────
exports.approvalsInbox = async (req, res) => {
  try {
    await ensure();
    runApprovalSla().catch(() => {}); // opportunistic, throttled, fire-and-forget
    const approverId = toInt(req.query.approver_id ?? (req.body || {}).approver_id);
    const items = [];

    // 1. generic engine
    const eng = await S(
      `SELECT a.id, a.entity_type, a.title, a.summary, a.amount, a.project_id, a.created_at,
              s.due_at, s.escalated, s.reminded_at, s.step_no, a.current_step, a.sla_hours
       FROM approvals a
       JOIN approval_steps s ON s.approval_id = a.id AND s.step_no = a.current_step AND s.status='pending'
       WHERE a.status='pending' ${approverId ? "AND (s.approver_id = :aid OR s.approver_id IS NULL)" : ""}`,
      approverId ? { aid: approverId } : {}
    ).catch(() => []);
    eng.forEach((r) => items.push({
      source: "engine", kind: r.entity_type, ref: `APR-${r.id}`, title: r.title, summary: r.summary,
      amount: r.amount, project_id: r.project_id, created_at: r.created_at,
      due_at: r.due_at, sla_state: slaState(r), step_no: r.step_no,
      action_endpoint: "/api/admin/approval_decide",
    }));

    // 2. resource change requests
    const rcr = await S(`SELECT request_code, project_name, priority, created_at FROM resource_change_requests WHERE status IN ('Pending PMO Review','Clarification Requested')`).catch(() => []);
    rcr.forEach((r) => items.push({ source: "resource_change", kind: "resource_change", ref: r.request_code, title: `Resource change — ${r.project_name || ""}`, summary: `Priority ${r.priority}`, created_at: r.created_at, action_endpoint: "/api/admin/approve_resource_change" }));

    // 3. schedule freeze
    const frz = await S(`SELECT ps.project_id, p.project_name, ps.pm_updated_at FROM project_status ps LEFT JOIN projects p ON p.id = ps.project_id WHERE ps.pm_status='frozen' AND ps.pmo_status='pending'`).catch(() => []);
    frz.forEach((r) => items.push({ source: "schedule_freeze", kind: "schedule_freeze", ref: `PRJ-${r.project_id}`, title: `Schedule review — ${r.project_name || ""}`, project_id: r.project_id, created_at: r.pm_updated_at, action_endpoint: "/api/projectManager/scheduleStatusByPm" }));

    // 4. timesheets
    const ts = await S(`SELECT resource_id, week_start, SUM(hours) AS hrs, MIN(created_at) AS created_at FROM timesheets WHERE status='submitted' GROUP BY resource_id, week_start`).catch(() => []);
    ts.forEach((r) => items.push({ source: "timesheet", kind: "timesheet", ref: `TS-${r.resource_id}-${r.week_start}`, title: `Timesheet — week of ${r.week_start}`, summary: `${Number(r.hrs)}h`, created_at: r.created_at, action_endpoint: "/api/projectManager/approve_timesheet" }));

    // 5. expenses
    const exp = await S(`SELECT expense_code, category, amount, project_id, created_at FROM expenses WHERE status='submitted'`).catch(() => []);
    exp.forEach((r) => items.push({ source: "expense", kind: "expense", ref: r.expense_code, title: `Expense — ${r.category}`, amount: r.amount, project_id: r.project_id, created_at: r.created_at, action_endpoint: "/api/admin/approve_expense" }));

    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const byKind = {};
    items.forEach((i) => (byKind[i.kind] = (byKind[i.kind] || 0) + 1));
    const sla = { overdue: 0, due_soon: 0, escalated: 0 };
    items.forEach((i) => { if (i.sla_state && sla[i.sla_state] != null) sla[i.sla_state] += 1; });

    return res.status(200).json({ success: true, count: items.length, by_kind: byKind, sla, data: items });
  } catch (error) {
    console.error("approvalsInbox error:", error);
    return res.status(500).json({ success: false, message: error.message, data: [] });
  }
};
