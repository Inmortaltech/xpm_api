// =============================================================================
//  TIMESHEET CONTROLLER   —  Celoxis "Time" pillar
//
//  POST /api/users/log_time                 { resource_id, project_id, task_id?, task_name?, work_date, hours, billable?, note? }
//  POST /api/users/get_my_timesheet         { resource_id, from?, to? }
//  POST /api/users/submit_timesheet         { resource_id, week_start }   (submits all draft rows in that week)
//  POST /api/users/delete_time              { id, resource_id }
//  POST /api/projectManager/timesheet_approvals   { pm_id }              (submitted rows on the PM's projects)
//  POST /api/projectManager/approve_timesheet     { id, note? }
//  POST /api/projectManager/reject_timesheet      { id, note }
// =============================================================================

const sequelize = require("../config/db");
const { logActivity } = require("./_activity");

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const toNum = (v) => {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};
const fmtDate = (d) => {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().split("T")[0];
};
// YYYY-MM-DD from the *local* parts of a Date (a MySQL DATE has no tz — using
// toISOString here would shift the day on any server not on UTC)
const ymd = (d) => {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};
const weekStart = (d) => {
  const dt = new Date(d);
  const day = (dt.getDay() + 6) % 7; // Mon=0
  dt.setDate(dt.getDate() - day);
  return dt.toISOString().split("T")[0];
};

let ready = false;
const ensure = async () => {
  if (ready) return;
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS timesheets (
      id INT NOT NULL AUTO_INCREMENT,
      resource_id INT NOT NULL,
      project_id INT DEFAULT NULL,
      task_id INT DEFAULT NULL,
      task_name VARCHAR(255) DEFAULT NULL,
      work_date DATE NOT NULL,
      hours DECIMAL(5,2) NOT NULL DEFAULT 0,
      billable TINYINT(1) NOT NULL DEFAULT 1,
      note VARCHAR(500) DEFAULT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'draft',
      week_start DATE DEFAULT NULL,
      approver_id INT DEFAULT NULL,
      decided_at DATETIME DEFAULT NULL,
      decision_note VARCHAR(500) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ts_resource (resource_id, work_date),
      KEY idx_ts_project (project_id, status),
      KEY idx_ts_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  ready = true;
};

// ── log / edit a time entry ────────────────────────────────────────────────
exports.logTime = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const resourceId = toInt(b.resource_id);
    const workDate = fmtDate(b.work_date);
    if (!resourceId || !workDate) {
      return res.status(400).json({ success: false, message: "resource_id and work_date are required" });
    }
    const hours = toNum(b.hours);
    if (hours <= 0 || hours > 24) {
      return res.status(400).json({ success: false, message: "hours must be between 0 and 24" });
    }

    // update existing draft for the same task+date, else insert
    const existing = b.id
      ? await sequelize.query(`SELECT id, status FROM timesheets WHERE id = :id LIMIT 1`, {
          replacements: { id: toInt(b.id) },
          type: sequelize.QueryTypes.SELECT,
        })
      : [];

    if (existing.length) {
      if (["submitted", "approved"].includes(existing[0].status)) {
        return res.status(409).json({ success: false, message: "Entry is locked (submitted/approved)" });
      }
      await sequelize.query(
        `UPDATE timesheets SET project_id=:pid, task_id=:tid, task_name=:tname, work_date=:wd,
                               hours=:hours, billable=:billable, note=:note, week_start=:ws,
                               status = CASE WHEN status = 'rejected' THEN 'draft' ELSE status END,
                               decision_note = CASE WHEN status = 'rejected' THEN NULL ELSE decision_note END
         WHERE id = :id`,
        {
          replacements: {
            id: toInt(b.id),
            pid: toInt(b.project_id),
            tid: toInt(b.task_id),
            tname: b.task_name || null,
            wd: workDate,
            hours,
            billable: b.billable === false || b.billable === 0 || b.billable === "0" ? 0 : 1,
            note: b.note || null,
            ws: weekStart(workDate),
          },
        }
      );
      return res.status(200).json({ success: true, message: "Time entry updated", data: { id: toInt(b.id) } });
    }

    const [id] = await sequelize.query(
      `INSERT INTO timesheets (resource_id, project_id, task_id, task_name, work_date, hours, billable, note, status, week_start)
       VALUES (:rid, :pid, :tid, :tname, :wd, :hours, :billable, :note, 'draft', :ws)`,
      {
        replacements: {
          rid: resourceId,
          pid: toInt(b.project_id),
          tid: toInt(b.task_id),
          tname: b.task_name || null,
          wd: workDate,
          hours,
          billable: b.billable === false || b.billable === 0 || b.billable === "0" ? 0 : 1,
          note: b.note || null,
          ws: weekStart(workDate),
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );
    return res.status(201).json({ success: true, message: "Time logged", data: { id } });
  } catch (error) {
    console.error("logTime error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteTime = async (req, res) => {
  try {
    await ensure();
    const id = toInt((req.body || {}).id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    const rows = await sequelize.query(`SELECT status FROM timesheets WHERE id = :id LIMIT 1`, {
      replacements: { id },
      type: sequelize.QueryTypes.SELECT,
    });
    if (rows.length && ["submitted", "approved"].includes(rows[0].status)) {
      return res.status(409).json({ success: false, message: "Locked entry cannot be deleted" });
    }
    await sequelize.query(`DELETE FROM timesheets WHERE id = :id`, { replacements: { id } });
    return res.status(200).json({ success: true, message: "Entry deleted" });
  } catch (error) {
    console.error("deleteTime error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── my timesheet (grid data) ───────────────────────────────────────────────
exports.getMyTimesheet = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const resourceId = toInt(b.resource_id ?? b.resource ?? req.query.resource_id);
    if (!resourceId) return res.status(400).json({ success: false, message: "resource_id is required" });
    const from = fmtDate(b.from) || weekStart(new Date());
    const to = fmtDate(b.to) || new Date().toISOString().split("T")[0];

    const rows = await sequelize.query(
      `SELECT t.*, p.project_name
       FROM timesheets t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.resource_id = :rid AND t.work_date BETWEEN :from AND :to
       ORDER BY t.work_date DESC, t.id DESC`,
      { replacements: { rid: resourceId, from, to }, type: sequelize.QueryTypes.SELECT }
    );

    const totals = rows.reduce(
      (a, r) => {
        a.hours += Number(r.hours) || 0;
        if (r.billable) a.billable += Number(r.hours) || 0;
        a.by_status[r.status] = (a.by_status[r.status] || 0) + (Number(r.hours) || 0);
        const dk = ymd(r.work_date);
        if (dk) a.by_day[dk] = (a.by_day[dk] || 0) + (Number(r.hours) || 0);
        return a;
      },
      { hours: 0, billable: 0, by_status: {}, by_day: {} }
    );

    // one overall status for the week (drives the frontend banner)
    const statuses = new Set(rows.map((r) => r.status));
    let weekStatus = "empty";
    if (rows.length) {
      if (statuses.size === 1 && statuses.has("approved")) weekStatus = "approved";
      else if (statuses.has("rejected")) weekStatus = "rejected";
      else if (statuses.has("submitted")) weekStatus = "submitted";
      else weekStatus = "draft";
    }
    const rejected = rows.find((r) => r.status === "rejected" && r.decision_note);

    return res.status(200).json({
      success: true,
      window: { from, to },
      week: {
        status: weekStatus,
        rejection_note: rejected ? rejected.decision_note : null,
        locked: weekStatus === "submitted" || weekStatus === "approved",
      },
      totals,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    console.error("getMyTimesheet error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── submit a week ──────────────────────────────────────────────────────────
exports.submitTimesheet = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const resourceId = toInt(b.resource_id);
    const ws = fmtDate(b.week_start) || weekStart(new Date());
    if (!resourceId) return res.status(400).json({ success: false, message: "resource_id is required" });

    const [r] = await sequelize.query(
      `UPDATE timesheets SET status='submitted', decision_note = NULL
       WHERE resource_id = :rid AND week_start = :ws AND status IN ('draft','rejected')`,
      { replacements: { rid: resourceId, ws } }
    );
    await logActivity({
      entity_type: "timesheet",
      entity_id: `${resourceId}:${ws}`,
      actor_id: resourceId,
      action: "submitted",
      detail: `Submitted timesheet for week of ${ws}`,
    });
    return res.status(200).json({ success: true, message: "Timesheet submitted", data: { week_start: ws } });
  } catch (error) {
    console.error("submitTimesheet error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── PM approval queue ──────────────────────────────────────────────────────
exports.timesheetApprovals = async (req, res) => {
  try {
    await ensure();
    const pmId = toInt((req.body || {}).pm_id);
    const where = ["t.status = 'submitted'"];
    const repl = {};
    if (pmId) {
      where.push("(p.project_manager_id = :pmId OR t.approver_id = :pmId)");
      repl.pmId = pmId;
    }
    const rows = await sequelize.query(
      `SELECT t.*, p.project_name, u.name AS resource_name
       FROM timesheets t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.resource_id
       WHERE ${where.join(" AND ")}
       ORDER BY t.week_start DESC, t.resource_id`,
      { replacements: repl, type: sequelize.QueryTypes.SELECT }
    );

    // group by resource + week
    const groups = {};
    rows.forEach((r) => {
      const k = `${r.resource_id}|${r.week_start}`;
      groups[k] = groups[k] || {
        resource_id: r.resource_id,
        resource_name: r.resource_name,
        week_start: r.week_start,
        total_hours: 0,
        entries: [],
      };
      groups[k].total_hours += Number(r.hours) || 0;
      groups[k].entries.push(r);
    });

    return res.status(200).json({ success: true, count: rows.length, data: rows, groups: Object.values(groups) });
  } catch (error) {
    console.error("timesheetApprovals error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const decide = async (req, res, newStatus) => {
  await ensure();
  const b = req.body || {};
  const id = toInt(b.id);
  const resourceId = toInt(b.resource_id);
  const weekStartIn = fmtDate(b.week_start);
  const approverId = toInt(b.pm_id ?? b.approver_id);
  const note = b.note || null;

  let where, repl;
  if (id) {
    where = "id = :id";
    repl = { id };
  } else if (resourceId && weekStartIn) {
    where = "resource_id = :rid AND week_start = :ws AND status = 'submitted'";
    repl = { rid: resourceId, ws: weekStartIn };
  } else {
    return res.status(400).json({ success: false, message: "id, or resource_id + week_start, required" });
  }

  await sequelize.query(
    `UPDATE timesheets SET status = :st, approver_id = :approver, decided_at = NOW(), decision_note = :note WHERE ${where}`,
    { replacements: { ...repl, st: newStatus, approver: approverId, note } }
  );
  await logActivity({
    entity_type: "timesheet",
    entity_id: id ? String(id) : `${resourceId}:${weekStartIn}`,
    actor_id: approverId,
    action: newStatus,
    detail: newStatus === "approved" ? "Timesheet approved" : `Timesheet rejected: ${note || "no reason"}`,
  });
  return res.status(200).json({ success: true, message: `Timesheet ${newStatus}` });
};

exports.approveTimesheet = (req, res) => decide(req, res, "approved").catch((e) => {
  console.error("approveTimesheet error:", e);
  res.status(500).json({ success: false, message: e.message });
});
exports.rejectTimesheet = (req, res) => decide(req, res, "rejected").catch((e) => {
  console.error("rejectTimesheet error:", e);
  res.status(500).json({ success: false, message: e.message });
});
