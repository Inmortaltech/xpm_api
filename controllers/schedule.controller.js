// =============================================================================
//  SCHEDULE / PLAN CONTROLLER  (Celoxis: baseline, critical path, capacity)
//
//  POST /api/projectManager/set_baseline          { project_id }
//  POST /api/projectManager/get_schedule_variance { project_id }
//  POST /api/projectManager/compute_critical_path { project_id }
//  POST /api/admin/getCapacityForecast            { weeks? }
// =============================================================================

const sequelize = require("../config/db");
const { logActivity } = require("./_activity");

const S = (q, r) => sequelize.query(q, { replacements: r || {}, type: sequelize.QueryTypes.SELECT });
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const D = (s) => (s ? new Date(s) : null);
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const dayDiff = (a, b) => Math.round((D(b) - D(a)) / 86400000);
const iso = (d) => (d ? new Date(d).toISOString().split("T")[0] : null);

// ─── Baseline ──────────────────────────────────────────────────────────────
exports.setBaseline = async (req, res) => {
  try {
    const projectId = toInt((req.body || {}).project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });

    await sequelize.query(
      `UPDATE project_schedule SET baseline_start = planned_start, baseline_end = planned_end
       WHERE project_id = :pid AND is_active = 1`,
      { replacements: { pid: projectId } }
    );
    await sequelize.query(`UPDATE projects SET baseline_set_at = NOW() WHERE id = :pid`, {
      replacements: { pid: projectId },
    });
    await logActivity({
      entity_type: "project",
      entity_id: String(projectId),
      project_id: projectId,
      actor_id: toInt((req.body || {}).pm_id),
      action: "baseline_set",
      detail: "Schedule baseline snapshot taken",
    });
    return res.status(200).json({ success: true, message: "Baseline saved" });
  } catch (error) {
    console.error("setBaseline error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Variance (planned vs baseline) ────────────────────────────────────────
exports.getScheduleVariance = async (req, res) => {
  try {
    const projectId = toInt((req.body || {}).project_id ?? req.query.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });

    const rows = await S(
      `SELECT id, task_name, planned_start, planned_end, baseline_start, baseline_end,
              progress, status, planned_hours, actual_hours
       FROM project_schedule WHERE project_id = :pid AND is_active = 1
       ORDER BY sort_order, id`,
      { pid: projectId }
    );

    let slipTasks = 0;
    const data = rows.map((r) => {
      const startVar = r.baseline_start && r.planned_start ? dayDiff(r.baseline_start, r.planned_start) : null;
      const endVar = r.baseline_end && r.planned_end ? dayDiff(r.baseline_end, r.planned_end) : null;
      const hoursVar =
        r.planned_hours != null ? Number(r.actual_hours || 0) - Number(r.planned_hours || 0) : null;
      if ((endVar || 0) > 0) slipTasks += 1;
      return {
        id: r.id,
        task_name: r.task_name,
        planned_start: r.planned_start,
        planned_end: r.planned_end,
        baseline_start: r.baseline_start,
        baseline_end: r.baseline_end,
        start_variance_days: startVar,
        end_variance_days: endVar,
        hours_variance: hoursVar,
        progress: Number(r.progress) || 0,
        status: r.status,
        state: (endVar || 0) > 0 ? "behind" : (endVar || 0) < 0 ? "ahead" : "on_baseline",
      };
    });

    const worst = data.reduce((m, t) => Math.max(m, t.end_variance_days || 0), 0);
    return res.status(200).json({
      success: true,
      summary: { tasks: data.length, slipping: slipTasks, worst_slip_days: worst },
      data,
    });
  } catch (error) {
    console.error("getScheduleVariance error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Critical Path Method ──────────────────────────────────────────────────
//  Forward pass  -> ES / EF     Backward pass -> LS / LF     slack = LS - ES
//  A task with slack 0 is on the critical path.
//  Supports FS / SS / FF / SF dependency links + lag_days.
exports.computeCriticalPath = async (req, res) => {
  try {
    const projectId = toInt((req.body || {}).project_id ?? req.query.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });

    const rows = await S(
      `SELECT id, task_name, planned_start, planned_end, duration,
              predecessor_id, predecessor_type, lag_days, is_milestone
       FROM project_schedule
       WHERE project_id = :pid AND is_active = 1 AND (type <> 'subproject' OR type IS NULL)
       ORDER BY sort_order, id`,
      { pid: projectId }
    );
    if (rows.length === 0) {
      return res.status(200).json({ success: true, data: [], project_finish: null, critical_ids: [] });
    }

    // duration in days: prefer explicit, else planned_end-planned_start, else 1
    const T = new Map();
    rows.forEach((r) => {
      let dur = Number(r.duration);
      if (!dur || dur <= 0) {
        dur =
          r.planned_start && r.planned_end
            ? Math.max(1, dayDiff(r.planned_start, r.planned_end))
            : r.is_milestone
            ? 0
            : 1;
      }
      T.set(r.id, {
        id: r.id,
        name: r.task_name,
        dur,
        predId: r.predecessor_id || null,
        predType: (r.predecessor_type || "FS").toUpperCase(),
        lag: Number(r.lag_days) || 0,
        es: 0, ef: 0, ls: 0, lf: 0, slack: 0,
        planned_start: r.planned_start,
      });
    });

    // anchor day 0 = earliest planned_start among roots
    const starts = rows.map((r) => (r.planned_start ? D(r.planned_start).getTime() : null)).filter(Boolean);
    const anchor = starts.length ? new Date(Math.min(...starts)) : new Date();

    // successors index
    const succ = new Map();
    for (const t of T.values()) {
      if (t.predId && T.has(t.predId)) {
        (succ.get(t.predId) || succ.set(t.predId, []).get(t.predId)).push(t.id);
      }
    }

    // topological-ish forward pass (iterate to fixpoint — chains are short)
    const order = [...T.values()];
    for (let pass = 0; pass < order.length + 1; pass++) {
      let changed = false;
      for (const t of order) {
        let es = 0;
        if (t.predId && T.has(t.predId)) {
          const p = T.get(t.predId);
          const lag = t.lag;
          if (t.predType === "SS") es = p.es + lag;
          else if (t.predType === "FF") es = p.ef - t.dur + lag;
          else if (t.predType === "SF") es = p.es - t.dur + lag;
          else es = p.ef + lag; // FS
        }
        es = Math.max(0, es);
        const ef = es + t.dur;
        if (es !== t.es || ef !== t.ef) {
          t.es = es;
          t.ef = ef;
          changed = true;
        }
      }
      if (!changed) break;
    }

    const projectFinish = Math.max(...[...T.values()].map((t) => t.ef));

    // backward pass
    for (let pass = 0; pass < order.length + 1; pass++) {
      let changed = false;
      for (const t of order) {
        const children = succ.get(t.id) || [];
        let lf = children.length ? Infinity : projectFinish;
        for (const cid of children) {
          const c = T.get(cid);
          let cand;
          if (c.predType === "SS") cand = c.ls - c.lag + t.dur; // approx
          else if (c.predType === "FF") cand = c.lf - c.lag;
          else if (c.predType === "SF") cand = c.ls - c.lag + t.dur;
          else cand = c.ls - c.lag; // FS
          lf = Math.min(lf, cand);
        }
        if (!Number.isFinite(lf)) lf = projectFinish;
        const ls = lf - t.dur;
        if (lf !== t.lf || ls !== t.ls) {
          t.lf = lf;
          t.ls = ls;
          changed = true;
        }
      }
      if (!changed) break;
    }

    const data = [...T.values()].map((t) => {
      t.slack = Math.round(t.ls - t.es);
      return {
        id: t.id,
        task_name: t.name,
        duration_days: t.dur,
        early_start: iso(addDays(anchor, t.es)),
        early_finish: iso(addDays(anchor, t.ef)),
        late_start: iso(addDays(anchor, t.ls)),
        late_finish: iso(addDays(anchor, t.lf)),
        slack_days: t.slack,
        is_critical: t.slack <= 0,
        predecessor_id: t.predId,
        predecessor_type: t.predType,
      };
    });

    return res.status(200).json({
      success: true,
      project_finish: iso(addDays(anchor, projectFinish)),
      duration_days: projectFinish,
      critical_ids: data.filter((d) => d.is_critical).map((d) => d.id),
      data,
    });
  } catch (error) {
    console.error("computeCriticalPath error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Forward capacity forecast ────────────────────────────────────────────
//  From project_schedule.allocation_pct across planned_start..planned_end,
//  project each resource's weekly demand vs working-day capacity for N weeks.
exports.getCapacityForecast = async (req, res) => {
  try {
    const weeks = Math.min(16, toInt((req.body || {}).weeks) || 8);
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));

    const resources = await S(
      `SELECT id, user_id, name, role, COALESCE(capacity_hours,8) AS cap FROM resources WHERE is_active = 1`
    );
    const tasks = await S(
      `SELECT s.resource_id, s.planned_start, s.planned_end, COALESCE(s.allocation_pct,100) AS alloc,
              p.project_name
       FROM project_schedule s
       JOIN projects p ON p.id = s.project_id
       WHERE s.is_active = 1 AND s.resource_id IS NOT NULL
         AND s.planned_start IS NOT NULL AND s.planned_end IS NOT NULL
         AND (s.status IS NULL OR s.status <> 'completed')`
    );

    const weekBuckets = [];
    for (let w = 0; w < weeks; w++) {
      const ws = new Date(monday);
      ws.setDate(monday.getDate() + w * 7);
      const we = new Date(ws);
      we.setDate(ws.getDate() + 6);
      weekBuckets.push({ start: ws, end: we, key: iso(ws) });
    }

    const data = resources.map((r) => {
      const rid = new Set([r.id, r.user_id].filter(Boolean));
      const capWeek = Number(r.cap) * 5; // 5 working days
      const series = weekBuckets.map((wk) => {
        let hours = 0;
        tasks
          .filter((t) => rid.has(t.resource_id))
          .forEach((t) => {
            const ts = D(t.planned_start);
            const te = D(t.planned_end);
            // overlap days between task and this week (Mon–Fri only, rough)
            const oStart = ts > wk.start ? ts : wk.start;
            const oEnd = te < wk.end ? te : wk.end;
            if (oEnd < oStart) return;
            const overlapDays = Math.min(5, Math.max(0, Math.round((oEnd - oStart) / 86400000) + 1));
            hours += overlapDays * Number(r.cap) * (Number(t.alloc) / 100);
          });
        return {
          week: wk.key,
          demand_hours: Math.round(hours),
          capacity_hours: capWeek,
          utilization_pct: capWeek ? Math.round((hours / capWeek) * 100) : 0,
          state: hours > capWeek ? "over" : hours >= capWeek * 0.75 ? "full" : hours > 0 ? "partial" : "free",
        };
      });
      return { id: r.id, name: r.name, role: r.role, weeks: series };
    });

    return res.status(200).json({
      success: true,
      from: iso(monday),
      weeks,
      data,
      overbooked: data
        .filter((d) => d.weeks.some((w) => w.state === "over"))
        .map((d) => ({ name: d.name, weeks: d.weeks.filter((w) => w.state === "over").map((w) => w.week) })),
    });
  } catch (error) {
    console.error("getCapacityForecast error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  B1.  GANTT AUTO-SHIFT  —  predecessor slip par successors ko forward push
// -----------------------------------------------------------------------------
//  cascadeSchedule() ek pure engine hai: dependency graph ko topological order
//  me walk karta hai, har task ka MINIMUM allowed start/end nikalta hai (FS/SS/
//  FF/SF + lag), aur agar current planned dates us minimum se pehle hai to poora
//  task aage khiskata hai (duration preserve karke). Sirf forward push — kabhi
//  pull-in nahi. Cycles skip. Returns { shifts:[{id,task_name,old_*,new_*,shift_days}] }.
// =============================================================================
async function cascadeSchedule(projectId, { persist = true, actorId = null } = {}) {
  const rows = await S(
    `SELECT id, task_name, planned_start, planned_end, duration, is_milestone,
            predecessor_id, predecessor_type, lag_days, sort_order
       FROM project_schedule
      WHERE project_id = :pid AND is_active = 1
        AND (type <> 'subproject' OR type IS NULL)
      ORDER BY sort_order, id`,
    { pid: projectId }
  );
  if (rows.length === 0) return { shifts: [], count: 0 };

  const T = new Map();
  rows.forEach((r) => {
    let dur = Number(r.duration);
    if (!dur || dur <= 0) {
      dur = r.planned_start && r.planned_end
        ? Math.max(1, dayDiff(r.planned_start, r.planned_end))
        : r.is_milestone ? 0 : 1;
    }
    T.set(r.id, {
      id: r.id,
      name: r.task_name,
      dur,
      predId: r.predecessor_id || null,
      predType: (r.predecessor_type || "FS").toUpperCase(),
      lag: Number(r.lag_days) || 0,
      start: r.planned_start ? D(r.planned_start) : null,
      end: r.planned_end ? D(r.planned_end) : null,
      origStart: r.planned_start,
      origEnd: r.planned_end,
    });
  });

  // Kahn topological order over pred -> task edges; leftover (cycle) appended as-is
  const indeg = new Map();
  const adj = new Map();
  for (const t of T.values()) {
    indeg.set(t.id, 0);
    adj.set(t.id, []);
  }
  for (const t of T.values()) {
    if (t.predId && T.has(t.predId)) {
      adj.get(t.predId).push(t.id);
      indeg.set(t.id, indeg.get(t.id) + 1);
    }
  }
  const queue = [...T.values()].filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const nx of adj.get(id)) {
      indeg.set(nx, indeg.get(nx) - 1);
      if (indeg.get(nx) === 0) queue.push(nx);
    }
  }
  for (const t of T.values()) if (!order.includes(t.id)) order.push(t.id); // cycle fallback

  const shifts = [];
  for (const id of order) {
    const t = T.get(id);
    if (!t.start || !t.end) continue; // undated task — nothing to push
    const p = t.predId ? T.get(t.predId) : null;
    if (!p || !p.start || !p.end) continue;

    // minimum allowed anchor from the dependency
    let minStart = null;
    let minEnd = null;
    if (t.predType === "SS") minStart = addDays(p.start, t.lag);
    else if (t.predType === "FF") minEnd = addDays(p.end, t.lag);
    else if (t.predType === "SF") minEnd = addDays(p.start, t.lag);
    else minStart = addDays(p.end, t.lag); // FS

    let newStart = t.start;
    let newEnd = t.end;
    if (minStart && t.start < minStart) {
      newStart = new Date(minStart);
      newEnd = addDays(newStart, t.dur);
    } else if (minEnd && t.end < minEnd) {
      newEnd = new Date(minEnd);
      newStart = addDays(newEnd, -t.dur);
    }

    if (iso(newStart) !== iso(t.start) || iso(newEnd) !== iso(t.end)) {
      const shiftDays = dayDiff(t.start, newStart);
      t.start = newStart;
      t.end = newEnd;
      shifts.push({
        id: t.id,
        task_name: t.name,
        old_start: t.origStart,
        old_end: t.origEnd,
        new_start: iso(newStart),
        new_end: iso(newEnd),
        shift_days: shiftDays,
      });
    }
  }

  if (persist && shifts.length) {
    for (const s of shifts) {
      await sequelize.query(
        `UPDATE project_schedule SET planned_start = :ps, planned_end = :pe WHERE id = :id`,
        { replacements: { ps: s.new_start, pe: s.new_end, id: s.id } }
      );
    }
    await sequelize.query(`UPDATE projects SET schedule_rebuilt_at = NOW() WHERE id = :pid`, {
      replacements: { pid: projectId },
    });
    await logActivity({
      entity_type: "project",
      entity_id: String(projectId),
      project_id: projectId,
      actor_id: actorId,
      action: "rescheduled",
      detail: `Auto-shift moved ${shifts.length} task(s)`,
    });
  }

  return { shifts, count: shifts.length };
}
exports.cascadeSchedule = cascadeSchedule;

// POST /api/projectManager/reschedule_project  { project_id, pm_id?, dry_run? }
exports.rescheduleProject = async (req, res) => {
  try {
    const b = req.body || {};
    const projectId = toInt(b.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });
    const dryRun = b.dry_run === true || b.dry_run === "true" || b.dry_run === 1 || b.dry_run === "1";
    const out = await cascadeSchedule(projectId, { persist: !dryRun, actorId: toInt(b.pm_id) });
    return res.status(200).json({
      success: true,
      dry_run: dryRun,
      shifted: out.count,
      message: out.count ? `${out.count} task(s) ${dryRun ? "would move" : "moved"}` : "Everything already consistent",
      data: out.shifts,
    });
  } catch (error) {
    console.error("rescheduleProject error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/projectManager/set_auto_schedule  { project_id, enabled }
exports.setAutoSchedule = async (req, res) => {
  try {
    const b = req.body || {};
    const projectId = toInt(b.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });
    const enabled = b.enabled === true || b.enabled === "true" || b.enabled === 1 || b.enabled === "1";
    try {
      await sequelize.query(`ALTER TABLE projects ADD COLUMN auto_schedule TINYINT(1) NOT NULL DEFAULT 0`);
    } catch (_) { /* exists */ }
    await sequelize.query(`UPDATE projects SET auto_schedule = :v WHERE id = :pid`, {
      replacements: { v: enabled ? 1 : 0, pid: projectId },
    });
    let result = { shifted: 0, data: [] };
    if (enabled) {
      const out = await cascadeSchedule(projectId, { persist: true, actorId: toInt(b.pm_id) });
      result = { shifted: out.count, data: out.shifts };
    }
    return res.status(200).json({ success: true, auto_schedule: enabled, ...result });
  } catch (error) {
    console.error("setAutoSchedule error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
