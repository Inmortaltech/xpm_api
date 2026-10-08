// =============================================================================
//  ANALYTICS CONTROLLER   —  Celoxis-style dashboards, health & rollups
//
//  POST /api/admin/getPortfolioSummary      {}                  -> PMO dashboard KPIs
//  POST /api/admin/getProjectDashboard      { project_id }      -> PM single-project rollup
//  POST /api/admin/getResourceUtilization   {}                  -> resource load heatmap
//  GET  /api/admin/activity                 ?project_id&limit   -> activity feed
// =============================================================================

const sequelize = require("../config/db");

const S = (q, r) => sequelize.query(q, { replacements: r || {}, type: sequelize.QueryTypes.SELECT });
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
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

// ─── health (RAG) — Celoxis-ish rule ────────────────────────────────────────
//  RED   : past deadline & not done, OR a critical risk open, OR >30% behind
//  AMBER : deadline within 7d & <80% done, OR 10-30% behind, OR high risk open
//  GREEN : otherwise
function computeHealth({ end_date, progress, open_critical_risks, open_high_risks, overdue_tasks }) {
  const now = new Date();
  const end = end_date ? new Date(end_date) : null;
  const prog = Number(progress) || 0;

  let expected = null;
  // schedule expectation not available here without start_date; caller can pass overdue_tasks
  if (end && !Number.isNaN(end.getTime())) {
    const daysLeft = (end - now) / 86400000;
    if (daysLeft < 0 && prog < 100) {
      return { health: "red", note: "Past deadline, work still open" };
    }
    if (daysLeft <= 7 && prog < 80) {
      return { health: "amber", note: "Deadline near, progress under 80%" };
    }
  }
  if (open_critical_risks > 0) return { health: "red", note: `${open_critical_risks} critical risk(s) open` };
  if (overdue_tasks >= 3) return { health: "red", note: `${overdue_tasks} overdue tasks` };
  if (open_high_risks > 0 || overdue_tasks > 0) {
    return { health: "amber", note: open_high_risks ? `${open_high_risks} high risk(s) open` : `${overdue_tasks} overdue task(s)` };
  }
  return { health: "green", note: "On track" };
}

// milestone-based % complete (same convention the client used)
function progressFromMilestones(milestones) {
  const ms = Array.isArray(milestones) ? milestones : [];
  if (ms.length === 0) return 0;
  const today = new Date();
  const done = ms.filter((m) => {
    const d = new Date(m.milestone_date || m.date);
    return !Number.isNaN(d.getTime()) && d <= today;
  });
  if (done.length === 0) return 0;
  const last = done.reduce((a, b) => {
    const pa = Number(a.percentage ?? a.pct ?? 0);
    const pb = Number(b.percentage ?? b.pct ?? 0);
    return pb >= pa ? b : a;
  });
  return Math.round(Number(last.percentage ?? last.pct ?? 0));
}

// schedule-based % complete (avg of task.progress) — preferred when tasks exist
async function scheduleProgress(projectId) {
  const rows = await S(
    `SELECT AVG(COALESCE(progress,0)) AS avg_prog,
            SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS done,
            COUNT(*) AS total,
            SUM(CASE WHEN planned_end IS NOT NULL AND planned_end < CURDATE()
                      AND COALESCE(status,'') <> 'completed' THEN 1 ELSE 0 END) AS overdue
     FROM project_schedule WHERE project_id = :pid AND is_active = 1`,
    { pid: projectId }
  );
  const r = rows[0] || {};
  const total = Number(r.total) || 0;
  return {
    hasTasks: total > 0,
    progress: total ? Math.round(Number(r.avg_prog) || 0) : 0,
    overdue: Number(r.overdue) || 0,
    done: Number(r.done) || 0,
    total,
  };
}

async function riskCounts(projectId) {
  const rows = await S(
    `SELECT
        SUM(CASE WHEN severity='critical' AND state NOT IN ('Avoided','Mitigated') THEN 1 ELSE 0 END) AS crit,
        SUM(CASE WHEN severity='high'     AND state NOT IN ('Avoided','Mitigated') THEN 1 ELSE 0 END) AS high,
        COUNT(*) AS total
     FROM risks WHERE project_id = :pid AND is_active = 1`,
    { pid: projectId }
  );
  const r = rows[0] || {};
  return { critical: Number(r.crit) || 0, high: Number(r.high) || 0, total: Number(r.total) || 0 };
}

// shared: enrich a project row with health + progress (used by dashboards and,
// via analytics.enrichProject, by the PM/PMO list endpoints)
async function enrichProject(p) {
  const projectId = p.id;
  const sched = await scheduleProgress(projectId);
  const risks = await riskCounts(projectId);
  const progress = sched.hasTasks
    ? sched.progress
    : progressFromMilestones(parseJSON(p.milestones, []));
  const { health, note } = computeHealth({
    end_date: p.end_date,
    progress,
    open_critical_risks: risks.critical,
    open_high_risks: risks.high,
    overdue_tasks: sched.overdue,
  });
  // Persist the computed values back onto the row so the report builder,
  // saved reports and any plain SELECT see fresh health / progress.
  try {
    await sequelize.query(
      `UPDATE projects SET health = :h, health_note = :n, progress_pct = :pr WHERE id = :id`,
      { replacements: { h: health, n: note, pr: progress, id: projectId } }
    );
  } catch {
    /* health/progress columns may not exist yet — non-fatal */
  }

  return {
    ...p,
    progress_pct: progress,
    progress,
    health,
    health_note: note,
    open_risks: risks.total,
    critical_risks: risks.critical,
    overdue_tasks: sched.overdue,
    tasks_total: sched.total,
    tasks_done: sched.done,
  };
}

// Explicit "recompute everything" — safe to call on a schedule or after a
// bulk import so plain SELECTs stay accurate even without a dashboard load.
exports.refreshAllProjectHealth = async (req, res) => {
  try {
    const rows = await S(`SELECT * FROM projects`);
    for (const p of rows) {
      try { await enrichProject(p); } catch { /* skip */ }
    }
    return res.status(200).json({ success: true, message: `Refreshed ${rows.length} projects` });
  } catch (error) {
    console.error("refreshAllProjectHealth error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /getPortfolioSummary   {}
// =============================================================================
exports.getPortfolioSummary = async (req, res) => {
  try {
    const projects = await S(`SELECT * FROM projects`);
    const enriched = [];
    for (const p of projects) enriched.push(await enrichProject(p));

    const byStatus = {};
    const byHealth = { green: 0, amber: 0, red: 0 };
    let totalBudget = 0;
    let totalActual = 0;
    let totalBilled = 0;
    let overdueProjects = 0;

    enriched.forEach((p) => {
      const st = p.status || "Unknown";
      byStatus[st] = (byStatus[st] || 0) + 1;
      if (byHealth[p.health] != null) byHealth[p.health] += 1;
      totalBudget += Number(p.budget) || 0;
      totalActual += Number(p.actual_cost) || 0;
      totalBilled += Number(p.billed_amount) || 0;
      if (p.end_date && new Date(p.end_date) < new Date() && (p.progress || 0) < 100) overdueProjects += 1;
    });

    const [resAgg] = await S(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) AS active FROM resources`
    );
    const [pendingRes] = await S(
      `SELECT COUNT(*) AS n FROM resource_change_requests WHERE status IN ('Pending PMO Review','Clarification Requested')`
    ).catch(() => [{ n: 0 }]);
    const [pendingSched] = await S(
      `SELECT COUNT(*) AS n FROM project_status WHERE pm_status='frozen' AND pmo_status='pending'`
    ).catch(() => [{ n: 0 }]);
    const [pendingTs] = await S(
      `SELECT COUNT(*) AS n FROM timesheets WHERE status='submitted'`
    ).catch(() => [{ n: 0 }]);
    const [pendingExp] = await S(
      `SELECT COUNT(*) AS n FROM expenses WHERE status='submitted'`
    ).catch(() => [{ n: 0 }]);

    return res.status(200).json({
      success: true,
      data: {
        projects: {
          total: enriched.length,
          by_status: byStatus,
          by_health: byHealth,
          overdue: overdueProjects,
        },
        financials: {
          budget: totalBudget,
          actual_cost: totalActual,
          billed: totalBilled,
          margin: totalBilled - totalActual,
        },
        resources: {
          total: Number(resAgg?.total) || 0,
          active: Number(resAgg?.active) || 0,
        },
        approvals_pending: {
          resource_change: Number(pendingRes?.n) || 0,
          schedule_review: Number(pendingSched?.n) || 0,
          timesheets: Number(pendingTs?.n) || 0,
          expenses: Number(pendingExp?.n) || 0,
        },
        watchlist: enriched
          .filter((p) => p.health !== "green")
          .map((p) => ({
            id: p.id,
            project_code: p.project_code,
            project_name: p.project_name,
            health: p.health,
            health_note: p.health_note,
            progress: p.progress,
            end_date: p.end_date,
            project_manager: p.project_manager,
          })),
      },
    });
  } catch (error) {
    console.error("getPortfolioSummary error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /getProjectDashboard   { project_id }
// =============================================================================
exports.getProjectDashboard = async (req, res) => {
  try {
    const projectId = toInt((req.body || {}).project_id ?? req.query.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });

    const rows = await S(`SELECT * FROM projects WHERE id = :id LIMIT 1`, { id: projectId });
    if (!rows.length) return res.status(404).json({ success: false, message: "Project not found" });
    const project = await enrichProject(rows[0]);

    const [tsAgg] = await S(
      `SELECT COALESCE(SUM(hours),0) AS logged,
              COALESCE(SUM(CASE WHEN billable=1 THEN hours ELSE 0 END),0) AS billable_hours
       FROM timesheets WHERE project_id = :pid AND status IN ('approved','submitted')`,
      { pid: projectId }
    );
    // actual cost from approved time * resource cost_rate
    const [costAgg] = await S(
      `SELECT COALESCE(SUM(t.hours * COALESCE(r.cost_rate,0)),0) AS actual_cost,
              COALESCE(SUM(CASE WHEN t.billable=1 THEN t.hours * COALESCE(r.bill_rate,0) ELSE 0 END),0) AS earned_revenue
       FROM timesheets t
       LEFT JOIN resources r ON r.user_id = t.resource_id OR r.id = t.resource_id
       WHERE t.project_id = :pid AND t.status = 'approved'`,
      { pid: projectId }
    );
    const [expAgg] = await S(
      `SELECT COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) AS approved_expense,
              COALESCE(SUM(CASE WHEN status='submitted' THEN amount ELSE 0 END),0) AS pending_expense
       FROM expenses WHERE project_id = :pid`,
      { pid: projectId }
    );

    const team = await S(
      `SELECT DISTINCT u.id, u.name, u.role,
              (SELECT COALESCE(SUM(hours),0) FROM timesheets WHERE resource_id = u.id AND project_id = :pid AND status='approved') AS hours_logged
       FROM project_schedule s JOIN users u ON u.id = s.resource_id
       WHERE s.project_id = :pid AND s.is_active = 1`,
      { pid: projectId }
    );

    const milestones = parseJSON(rows[0].milestones, []);
    const risks = await S(
      `SELECT id, task_name, state, severity, severity_score, probability, impact, mitigation
       FROM risks WHERE project_id = :pid AND is_active = 1 ORDER BY severity_score DESC`,
      { pid: projectId }
    );
    const sprintRows = await S(
      `SELECT id, name, state, start_date, end_date,
              (SELECT COUNT(*) FROM boards b WHERE b.sprint_id = sp.id AND b.is_active=1) AS issues,
              (SELECT COUNT(*) FROM boards b WHERE b.sprint_id = sp.id AND b.is_active=1 AND b.status='completed') AS done
       FROM sprints sp WHERE sp.project_id = :pid ORDER BY sp.sort_order, sp.id`,
      { pid: projectId }
    );
    const activity = await S(
      `SELECT entity_type, action, detail, actor_name, created_at
       FROM activity_log WHERE project_id = :pid ORDER BY id DESC LIMIT 15`,
      { pid: projectId }
    ).catch(() => []);

    const budget = Number(project.budget) || 0;
    const actualCost = Number(costAgg?.actual_cost || 0) + Number(expAgg?.approved_expense || 0);

    return res.status(200).json({
      success: true,
      data: {
        project,
        health: { rag: project.health, note: project.health_note },
        progress: project.progress,
        schedule: {
          tasks_total: project.tasks_total,
          tasks_done: project.tasks_done,
          overdue_tasks: project.overdue_tasks,
          start_date: rows[0].start_date,
          end_date: rows[0].end_date,
        },
        financials: {
          budget,
          actual_cost: Math.round(actualCost),
          committed_expense: Number(expAgg?.pending_expense || 0),
          earned_revenue: Math.round(Number(costAgg?.earned_revenue || 0)),
          burn_pct: budget ? Math.round((actualCost / budget) * 100) : 0,
          hours_logged: Number(tsAgg?.logged || 0),
          billable_hours: Number(tsAgg?.billable_hours || 0),
        },
        team,
        milestones,
        risks,
        sprints: sprintRows,
        activity,
      },
    });
  } catch (error) {
    console.error("getProjectDashboard error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /getResourceUtilization   {}   (optional { from, to })
// =============================================================================
exports.getResourceUtilization = async (req, res) => {
  try {
    const b = req.body || {};
    const from = b.from || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const to = b.to || new Date().toISOString().split("T")[0];

    const resources = await S(
      `SELECT id, user_id, name, role, capacity_hours, cost_rate, bill_rate, is_active FROM resources WHERE is_active = 1`
    );

    const data = [];
    for (const r of resources) {
      const [logged] = await S(
        `SELECT COALESCE(SUM(hours),0) AS h,
                COUNT(DISTINCT project_id) AS projects
         FROM timesheets
         WHERE resource_id IN (:rid, :uid) AND work_date BETWEEN :from AND :to
           AND status IN ('approved','submitted')`,
        { rid: r.id, uid: r.user_id || r.id, from, to }
      );
      // working-day capacity in the window
      const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000));
      const workingDays = Math.round(days * (5 / 7));
      const capacity = workingDays * (Number(r.capacity_hours) || 8);
      const loggedH = Number(logged?.h) || 0;
      data.push({
        id: r.id,
        name: r.name,
        role: r.role,
        capacity_hours: capacity,
        logged_hours: loggedH,
        utilization_pct: capacity ? Math.round((loggedH / capacity) * 100) : 0,
        projects: Number(logged?.projects) || 0,
        cost_rate: r.cost_rate,
        bill_rate: r.bill_rate,
        state:
          !capacity ? "unknown" :
          loggedH / capacity > 1 ? "over" :
          loggedH / capacity >= 0.75 ? "full" :
          loggedH / capacity >= 0.35 ? "partial" : "under",
      });
    }

    return res.status(200).json({ success: true, window: { from, to }, count: data.length, data });
  } catch (error) {
    console.error("getResourceUtilization error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  GET /activity   ?project_id&entity_type&limit
// =============================================================================
exports.getActivity = async (req, res) => {
  try {
    const projectId = toInt(req.query.project_id);
    const entityType = req.query.entity_type ? String(req.query.entity_type) : null;
    const limit = Math.min(200, toInt(req.query.limit) || 50);

    const where = ["1=1"];
    const repl = { limit };
    if (projectId) {
      where.push("project_id = :projectId");
      repl.projectId = projectId;
    }
    if (entityType) {
      where.push("entity_type = :entityType");
      repl.entityType = entityType;
    }

    const rows = await sequelize.query(
      `SELECT id, entity_type, entity_id, project_id, actor_id, actor_name, action, detail, created_at
       FROM activity_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT :limit`,
      { replacements: repl, type: sequelize.QueryTypes.SELECT }
    );

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("getActivity error:", error);
    return res.status(500).json({ success: false, message: error.message, data: [] });
  }
};

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// =============================================================================
//  POST /getPmDashboard   { pm_id }        -> PM "My Delivery" overview
// =============================================================================
exports.getPmDashboard = async (req, res) => {
  try {
    const pmId = toInt((req.body || {}).pm_id ?? req.query.pm_id ?? (req.user && req.user.id));
    if (!pmId) return res.status(400).json({ success: false, message: "pm_id is required" });

    const rawProjects = await S(`SELECT * FROM projects WHERE project_manager_id = :pmId`, { pmId });
    const projects = [];
    for (const p of rawProjects) projects.push(await enrichProject(p));
    const ids = projects.map((p) => p.id);
    const idList = ids.length ? ids : [0];

    const byHealth = { green: 0, amber: 0, red: 0 };
    const byStatus = {};
    let budget = 0, actual = 0, billed = 0;
    projects.forEach((p) => {
      if (byHealth[p.health] != null) byHealth[p.health] += 1;
      byStatus[p.status || "Unknown"] = (byStatus[p.status || "Unknown"] || 0) + 1;
      budget += Number(p.budget) || 0;
      actual += Number(p.actual_cost) || 0;
      billed += Number(p.billed_amount) || 0;
    });

    const [appr] = await S(
      `SELECT COUNT(*) AS n FROM approvals a
        JOIN approval_steps s ON s.approval_id = a.id AND s.step_no = a.current_step AND s.status='pending'
       WHERE a.status='pending' AND (s.approver_id = :pmId OR s.approver_role IN ('PM','PMO'))`,
      { pmId }
    ).catch(() => [{ n: 0 }]);
    const [tsPending] = await S(
      `SELECT COUNT(DISTINCT CONCAT(resource_id,'|',week_start)) AS n
       FROM timesheets WHERE status='submitted' AND project_id IN (:ids)`,
      { ids: idList }
    ).catch(() => [{ n: 0 }]);
    const [expPending] = await S(
      `SELECT COUNT(*) AS n FROM expenses WHERE status='submitted' AND project_id IN (:ids)`,
      { ids: idList }
    ).catch(() => [{ n: 0 }]);

    const risks = await S(
      `SELECT r.id, r.task_name, r.severity, r.severity_score, r.state, p.project_name
       FROM risks r JOIN projects p ON p.id = r.project_id
       WHERE r.project_id IN (:ids) AND r.is_active = 1 AND (r.state IS NULL OR r.state <> 'Closed')
       ORDER BY r.severity_score DESC LIMIT 8`,
      { ids: idList }
    ).catch(() => []);

    const overdueTasks = await S(
      `SELECT s.id, s.task_name, s.planned_end, p.project_name
       FROM project_schedule s JOIN projects p ON p.id = s.project_id
       WHERE s.project_id IN (:ids) AND s.is_active = 1
         AND (s.status IS NULL OR s.status <> 'completed')
         AND s.planned_end IS NOT NULL AND s.planned_end < CURDATE()
       ORDER BY s.planned_end ASC LIMIT 10`,
      { ids: idList }
    ).catch(() => []);

    const activity = await S(
      `SELECT entity_type, action, detail, actor_name, project_id, created_at
       FROM activity_log WHERE project_id IN (:ids) ORDER BY id DESC LIMIT 15`,
      { ids: idList }
    ).catch(() => []);

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          projects: projects.length,
          by_health: byHealth,
          by_status: byStatus,
          at_risk: byHealth.red + byHealth.amber,
          budget, actual_cost: actual, billed, margin: billed - actual,
          approvals_pending: Number(appr?.n) || 0,
          timesheets_pending: Number(tsPending?.n) || 0,
          expenses_pending: Number(expPending?.n) || 0,
          open_risks: risks.length,
          overdue_tasks: overdueTasks.length,
        },
        projects: projects.map((p) => ({
          id: p.id, project_code: p.project_code, project_name: p.project_name,
          health: p.health, health_note: p.health_note, progress: p.progress,
          status: p.status, end_date: p.end_date, budget: p.budget, actual_cost: p.actual_cost,
        })).sort((a, b) => ({ red: 0, amber: 1, green: 2 }[a.health] ?? 3) - ({ red: 0, amber: 1, green: 2 }[b.health] ?? 3)),
        risks,
        overdue_tasks: overdueTasks,
        activity,
      },
    });
  } catch (error) {
    console.error("getPmDashboard error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /getResourceDashboard   { resource_id }   -> team-member "My Work"
// =============================================================================
exports.getResourceDashboard = async (req, res) => {
  try {
    const userId = toInt((req.body || {}).resource_id ?? req.query.resource_id ?? (req.user && req.user.id));
    if (!userId) return res.status(400).json({ success: false, message: "resource_id is required" });

    // resource row id (boards / schedule may key on either users.id or resources.id)
    const rr = await S(`SELECT id FROM resources WHERE user_id = :uid LIMIT 1`, { uid: userId }).catch(() => []);
    const rid = rr[0]?.id ?? -1;
    const ids = [userId, rid];

    const boardRows = await S(
      `SELECT b.status, COUNT(*) AS n
       FROM boards b WHERE b.is_active = 1 AND b.resource_id IN (:ids)
       GROUP BY b.status`,
      { ids }
    ).catch(() => []);
    const byStatus = { in_discussion: 0, to_do: 0, in_work: 0, in_progress: 0, completed: 0 };
    boardRows.forEach((r) => { if (byStatus[r.status] != null) byStatus[r.status] = Number(r.n); });
    const openIssues = byStatus.in_discussion + byStatus.to_do + byStatus.in_work + byStatus.in_progress;

    const weekEnd = iso(addDays(new Date(), 7));
    const dueSoon = await S(
      `SELECT s.id, s.task_name, s.planned_end, p.project_name
       FROM project_schedule s JOIN projects p ON p.id = s.project_id
       WHERE s.is_active = 1 AND s.resource_id IN (:ids)
         AND (s.status IS NULL OR s.status <> 'completed')
         AND s.planned_end IS NOT NULL AND s.planned_end BETWEEN CURDATE() AND :weekEnd
       ORDER BY s.planned_end ASC LIMIT 12`,
      { ids, weekEnd }
    ).catch(() => []);
    const overdue = await S(
      `SELECT s.id, s.task_name, s.planned_end, p.project_name
       FROM project_schedule s JOIN projects p ON p.id = s.project_id
       WHERE s.is_active = 1 AND s.resource_id IN (:ids)
         AND (s.status IS NULL OR s.status <> 'completed')
         AND s.planned_end IS NOT NULL AND s.planned_end < CURDATE()
       ORDER BY s.planned_end ASC LIMIT 12`,
      { ids }
    ).catch(() => []);

    const risks = await S(
      `SELECT r.id, r.task_name, r.severity, r.severity_score, r.state, p.project_name
       FROM risks r LEFT JOIN projects p ON p.id = r.project_id
       WHERE (r.resource_id IN (:ids) OR r.owner_id IN (:ids)) AND r.is_active = 1
         AND (r.state IS NULL OR r.state <> 'Closed')
       ORDER BY r.severity_score DESC LIMIT 6`,
      { ids }
    ).catch(() => []);

    // this week's timesheet (Mon-anchored)
    const now = new Date();
    const monday = iso(addDays(now, -(((now.getDay() + 6) % 7))));
    const [tsWeek] = await S(
      `SELECT COALESCE(SUM(hours),0) AS hours,
              SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) AS submitted,
              SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
              COUNT(*) AS entries
       FROM timesheets WHERE resource_id IN (:ids) AND week_start = :monday`,
      { ids, monday }
    ).catch(() => [{ hours: 0, entries: 0 }]);

    const projects = await S(
      `SELECT DISTINCT p.id, p.project_name, p.project_code, p.status, p.health
       FROM project_schedule s JOIN projects p ON p.id = s.project_id
       WHERE s.is_active = 1 AND s.resource_id IN (:ids)`,
      { ids }
    ).catch(() => []);

    const activity = await S(
      `SELECT entity_type, action, detail, actor_name, project_id, created_at
       FROM activity_log WHERE actor_id IN (:ids) OR project_id IN (
         SELECT DISTINCT project_id FROM project_schedule WHERE resource_id IN (:ids) AND is_active = 1
       ) ORDER BY id DESC LIMIT 15`,
      { ids }
    ).catch(() => []);

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          open_issues: openIssues,
          by_status: byStatus,
          due_this_week: dueSoon.length,
          overdue: overdue.length,
          open_risks: risks.length,
          projects: projects.length,
          week_start: monday,
          timesheet_hours: Number(tsWeek?.hours) || 0,
          timesheet_entries: Number(tsWeek?.entries) || 0,
          timesheet_submitted: Number(tsWeek?.submitted) || 0,
          timesheet_approved: Number(tsWeek?.approved) || 0,
          timesheet_rejected: Number(tsWeek?.rejected) || 0,
        },
        due_this_week: dueSoon,
        overdue,
        risks,
        projects,
        activity,
      },
    });
  } catch (error) {
    console.error("getResourceDashboard error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// export the enrich helper for reuse by PM/PMO list endpoints
exports._enrichProject = enrichProject;
