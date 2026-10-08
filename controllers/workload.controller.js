// =============================================================================
//  WORKLOAD / RESOURCE LOAD  (Celoxis "Resource Load Chart")
//
//  The single source of truth for "who is doing what, when" is project_schedule
//  (WBS tasks with resource_id + planned_start/end + allocation_pct/planned_hours)
//  — the same data the critical-path and capacity-forecast engines use.
//
//  POST /api/admin/get_workload
//     { view:'daily'|'weekly'|'monthly', periods?, start_date?, project_id?,
//       role?, only_allocated? }
//     -> resource × period grid: demand hours vs working-day capacity, RAG state,
//        per-project breakdown, plus a portfolio-level summary.
//
//  POST /api/admin/get_workload_tasks
//     { resource_id, view?, periods?, start_date? }
//     -> task-level rows for one resource (the row-expand drill-down).
// =============================================================================

const sequelize = require("../config/db");
const S = (q, r) => sequelize.query(q, { replacements: r || {}, type: sequelize.QueryTypes.SELECT });
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

// ── date helpers (calendar-day granularity, UTC-safe ISO keys) ──────────────
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const parseD = (s) => {
  const d = new Date(s);
  d.setHours(0, 0, 0, 0);
  return d;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const startOfWeekMon = (d) => {
  const x = parseD(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
};
const startOfMonth = (d) => {
  const x = parseD(d);
  x.setDate(1);
  return x;
};
const endOfMonth = (d) => {
  const x = startOfMonth(d);
  x.setMonth(x.getMonth() + 1);
  x.setDate(0);
  return x;
};
const clampDate = (d, lo, hi) => (d < lo ? new Date(lo) : d > hi ? new Date(hi) : new Date(d));

// count days in [start,end] (inclusive) whose weekday is in dowSet and whose
// ISO date is not an org holiday
function workingDayCount(start, end, dowSet, holidaySet) {
  if (end < start) return 0;
  let n = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    if (!dowSet.has(d.getDay())) continue;
    if (holidaySet.has(iso(d))) continue;
    n += 1;
  }
  return n;
}

const PALETTE = [
  "bg-fuchsia-100 text-fuchsia-700", "bg-blue-100 text-blue-700",
  "bg-orange-100 text-orange-700", "bg-violet-100 text-violet-700",
  "bg-rose-100 text-rose-700", "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-700", "bg-cyan-100 text-cyan-700",
  "bg-indigo-100 text-indigo-700", "bg-teal-100 text-teal-700",
];
const colorFor = (key) => {
  let h = 0;
  const s = String(key);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % PALETTE.length;
  return PALETTE[h];
};

const VIEW_DEFAULTS = { daily: 14, weekly: 8, monthly: 6 };
const VIEW_MAX = { daily: 60, weekly: 26, monthly: 12 };

// build the period buckets for a view
function buildBuckets(view, anchorISO, periods) {
  const buckets = [];
  let cursor;
  if (view === "daily") cursor = parseD(anchorISO);
  else if (view === "monthly") cursor = startOfMonth(anchorISO);
  else cursor = startOfWeekMon(anchorISO);

  for (let i = 0; i < periods; i++) {
    let start;
    let end;
    let label;
    if (view === "daily") {
      start = addDays(cursor, i);
      end = new Date(start);
      label = start.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    } else if (view === "monthly") {
      start = new Date(cursor);
      start.setMonth(cursor.getMonth() + i);
      end = endOfMonth(start);
      label = start.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
    } else {
      start = addDays(cursor, i * 7);
      end = addDays(start, 6);
      label = start.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    }
    buckets.push({ key: iso(start), label, start, end });
  }
  return buckets;
}

// "09:00" / "09:00:00" -> 9 ; null on bad input
function shiftHours(startT, endT) {
  const toH = (t) => {
    if (!t) return null;
    const [h, m] = String(t).split(":").map(Number);
    return Number.isNaN(h) ? null : h + (Number.isNaN(m) ? 0 : m / 60);
  };
  const a = toH(startT);
  const b = toH(endT);
  if (a === null || b === null) return null;
  return b - a > 0 ? b - a : null;
}

// resource's own working weekdays as a Set<0..6>; falls back to Mon–Fri
function resourceDowSet(r) {
  const map = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const set = new Set();
  for (const [k, dow] of Object.entries(map)) if (Number(r[k])) set.add(dow);
  if (set.size === 0) [1, 2, 3, 4, 5].forEach((d) => set.add(d));
  return set;
}

// ── shared loader ──────────────────────────────────────────────────────────
async function loadContext({ role, projectId }) {
  const holRows = await S(
    `SELECT holiday_date FROM holidays WHERE (is_active IS NULL OR is_active = 1)`
  ).catch(() => []);
  const holidaySet = new Set(
    holRows.map((h) => (h.holiday_date ? iso(h.holiday_date) : null)).filter(Boolean)
  );

  const resources = await S(
    `SELECT id, user_id, name, role, COALESCE(capacity_hours, 8) AS cap,
            start_time, end_time, monday, tuesday, wednesday, thursday, friday, saturday, sunday
       FROM resources
      WHERE (is_active IS NULL OR is_active = 1)
        ${role ? "AND LOWER(role) = LOWER(:role)" : ""}
      ORDER BY name`,
    role ? { role } : {}
  );

  const tasks = await S(
    `SELECT s.id, s.resource_id, s.project_id, p.project_name, s.task_name,
            s.planned_start, s.planned_end, COALESCE(s.allocation_pct, 100) AS alloc,
            s.planned_hours, s.duration, s.status
       FROM project_schedule s
       JOIN projects p ON p.id = s.project_id
      WHERE s.is_active = 1 AND s.resource_id IS NOT NULL
        AND s.planned_start IS NOT NULL AND s.planned_end IS NOT NULL
        AND (s.status IS NULL OR s.status <> 'completed')
        ${projectId ? "AND s.project_id = :pid" : ""}`,
    projectId ? { pid: projectId } : {}
  );

  return { holidaySet, resources, tasks };
}

// per-day hours a task consumes for a given resource
function taskDailyHours(task, perDayCap, dowSet, holidaySet) {
  const ts = parseD(task.planned_start);
  const te = parseD(task.planned_end);
  if (task.planned_hours != null && Number(task.planned_hours) > 0) {
    const spanDays = Math.max(1, workingDayCount(ts, te, dowSet, holidaySet));
    return Number(task.planned_hours) / spanDays;
  }
  return perDayCap * (Number(task.alloc) / 100);
}

exports.getWorkload = async (req, res) => {
  try {
    const b = req.body || {};
    const view = ["daily", "weekly", "monthly"].includes(b.view) ? b.view : "weekly";
    let periods = toInt(b.periods) || VIEW_DEFAULTS[view];
    periods = Math.max(1, Math.min(VIEW_MAX[view], periods));
    const anchorISO = b.start_date ? iso(parseD(b.start_date)) : iso(new Date());
    const projectId = toInt(b.project_id);
    const role = b.role ? String(b.role).trim() : null;
    const onlyAllocated = b.only_allocated === true || b.only_allocated === "true" || b.only_allocated === 1 || b.only_allocated === "1";

    const buckets = buildBuckets(view, anchorISO, periods);
    const rangeStart = buckets[0].start;
    const rangeEnd = buckets[buckets.length - 1].end;

    const { holidaySet, resources, tasks } = await loadContext({ role, projectId });

    // index tasks by resource_id. project_schedule.resource_id may hold either a
    // resources.id or a users.id — a task belongs to the resource row that
    // matches by id first; the user_id match is only a fallback for tasks that
    // match no resource row directly (avoids double-counting when one row's id
    // collides with another row's user_id).
    const resourceIdSet = new Set(resources.map((r) => String(r.id)));
    const tasksByKey = new Map();
    for (const t of tasks) {
      const k = String(t.resource_id);
      if (!tasksByKey.has(k)) tasksByKey.set(k, []);
      tasksByKey.get(k).push(t);
    }

    const outResources = resources.map((r) => {
      const perDayCap = Number(r.cap) > 0 ? Number(r.cap) : (shiftHours(r.start_time, r.end_time) || 8);
      const dowSet = resourceDowSet(r);
      const mine = [...(tasksByKey.get(String(r.id)) || [])];
      if (r.user_id != null && !resourceIdSet.has(String(r.user_id))) {
        mine.push(...(tasksByKey.get(String(r.user_id)) || []));
      }

      const projAgg = new Map(); // project_id -> { project_name, buckets:[], total }
      const series = buckets.map((bk, bi) => {
        const capDays = workingDayCount(bk.start, bk.end, dowSet, holidaySet);
        const capacity = Math.round(perDayCap * capDays * 100) / 100;
        let demand = 0;
        for (const t of mine) {
          const ts = parseD(t.planned_start);
          const te = parseD(t.planned_end);
          if (te < bk.start || ts > bk.end) continue;
          const oStart = clampDate(ts, bk.start, bk.end);
          const oEnd = clampDate(te, bk.start, bk.end);
          const overlapDays = workingDayCount(oStart, oEnd, dowSet, holidaySet);
          if (overlapDays <= 0) continue;
          const hrs = overlapDays * taskDailyHours(t, perDayCap, dowSet, holidaySet);
          demand += hrs;
          if (!projAgg.has(t.project_id)) {
            projAgg.set(t.project_id, {
              project_id: t.project_id,
              project_name: t.project_name || `#${t.project_id}`,
              buckets: new Array(buckets.length).fill(0),
              total: 0,
            });
          }
          const pa = projAgg.get(t.project_id);
          pa.buckets[bi] += hrs;
          pa.total += hrs;
        }
        demand = Math.round(demand * 100) / 100;
        const util = capacity > 0 ? Math.round((demand / capacity) * 100) : demand > 0 ? 999 : 0;
        const state = util > 100 ? "over" : util >= 85 ? "full" : demand > 0 ? "partial" : "free";
        return { key: bk.key, demand_hours: demand, capacity_hours: capacity, util_pct: util, state };
      });

      const demandTotal = Math.round(series.reduce((s, x) => s + x.demand_hours, 0) * 100) / 100;
      const capacityTotal = Math.round(series.reduce((s, x) => s + x.capacity_hours, 0) * 100) / 100;
      const utilPct = capacityTotal > 0 ? Math.round((demandTotal / capacityTotal) * 100) : demandTotal > 0 ? 999 : 0;

      const projects = [...projAgg.values()]
        .map((p) => ({
          ...p,
          total: Math.round(p.total * 100) / 100,
          buckets: p.buckets.map((h) => Math.round(h * 100) / 100),
        }))
        .sort((a, c) => c.total - a.total);

      return {
        id: r.id,
        user_id: r.user_id,
        name: r.name,
        role: r.role || "",
        color: colorFor(`id:${r.id}`),
        per_day_capacity: perDayCap,
        capacity_total: capacityTotal,
        demand_total: demandTotal,
        util_pct: utilPct,
        overbooked_periods: series.filter((x) => x.state === "over").length,
        series,
        projects,
      };
    });

    let list = outResources;
    if (onlyAllocated) list = list.filter((r) => r.demand_total > 0);
    list.sort((a, c) => c.util_pct - a.util_pct);

    const totalDemand = Math.round(list.reduce((s, r) => s + r.demand_total, 0) * 100) / 100;
    const totalCapacity = Math.round(list.reduce((s, r) => s + r.capacity_total, 0) * 100) / 100;

    return res.status(200).json({
      success: true,
      view,
      periods,
      from: iso(rangeStart),
      to: iso(rangeEnd),
      buckets: buckets.map((b2) => ({ key: b2.key, label: b2.label, start: iso(b2.start), end: iso(b2.end) })),
      summary: {
        resource_count: list.length,
        allocated_count: list.filter((r) => r.demand_total > 0).length,
        overbooked_count: list.filter((r) => r.overbooked_periods > 0).length,
        avg_util: totalCapacity > 0 ? Math.round((totalDemand / totalCapacity) * 100) : 0,
        total_demand: totalDemand,
        total_capacity: totalCapacity,
      },
      resources: list,
    });
  } catch (error) {
    console.error("getWorkload error:", error);
    return res.status(500).json({ success: false, message: error.message, resources: [] });
  }
};

// task-level rows for one resource (row-expand drill-down)
exports.getWorkloadTasks = async (req, res) => {
  try {
    const b = req.body || {};
    const resourceId = toInt(b.resource_id);
    if (!resourceId) return res.status(400).json({ success: false, message: "resource_id is required" });
    const view = ["daily", "weekly", "monthly"].includes(b.view) ? b.view : "weekly";
    let periods = toInt(b.periods) || VIEW_DEFAULTS[view];
    periods = Math.max(1, Math.min(VIEW_MAX[view], periods));
    const anchorISO = b.start_date ? iso(parseD(b.start_date)) : iso(new Date());

    const buckets = buildBuckets(view, anchorISO, periods);

    const [r] = await S(
      `SELECT id, user_id, name, role, COALESCE(capacity_hours,8) AS cap,
              start_time, end_time, monday, tuesday, wednesday, thursday, friday, saturday, sunday
         FROM resources WHERE id = :id`,
      { id: resourceId }
    );
    if (!r) return res.status(404).json({ success: false, message: "Resource not found" });

    const holRows = await S(`SELECT holiday_date FROM holidays WHERE (is_active IS NULL OR is_active = 1)`).catch(() => []);
    const holidaySet = new Set(holRows.map((h) => (h.holiday_date ? iso(h.holiday_date) : null)).filter(Boolean));
    const perDayCap = Number(r.cap) > 0 ? Number(r.cap) : (shiftHours(r.start_time, r.end_time) || 8);
    const dowSet = resourceDowSet(r);

    const tasks = await S(
      `SELECT s.id, s.project_id, p.project_name, s.task_name, s.planned_start, s.planned_end,
              COALESCE(s.allocation_pct,100) AS alloc, s.planned_hours, s.status
         FROM project_schedule s JOIN projects p ON p.id = s.project_id
        WHERE s.is_active = 1
          AND ( s.resource_id = :rid
             OR ( s.resource_id = :uid
                  AND NOT EXISTS (SELECT 1 FROM resources r2 WHERE r2.id = :uid) ) )
          AND s.planned_start IS NOT NULL AND s.planned_end IS NOT NULL
          AND (s.status IS NULL OR s.status <> 'completed')
        ORDER BY s.planned_start`,
      { rid: resourceId, uid: r.user_id ?? -1 }
    );

    const rows = tasks.map((t) => {
      const ts = parseD(t.planned_start);
      const te = parseD(t.planned_end);
      const per = buckets.map((bk) => {
        if (te < bk.start || ts > bk.end) return 0;
        const oStart = clampDate(ts, bk.start, bk.end);
        const oEnd = clampDate(te, bk.start, bk.end);
        const od = workingDayCount(oStart, oEnd, dowSet, holidaySet);
        return od <= 0 ? 0 : Math.round(od * taskDailyHours(t, perDayCap, dowSet, holidaySet) * 100) / 100;
      });
      return {
        id: t.id,
        project_id: t.project_id,
        project_name: t.project_name,
        task_name: t.task_name,
        planned_start: t.planned_start,
        planned_end: t.planned_end,
        allocation_pct: Number(t.alloc),
        planned_hours: t.planned_hours != null ? Number(t.planned_hours) : null,
        buckets: per,
        total: Math.round(per.reduce((s, x) => s + x, 0) * 100) / 100,
      };
    });

    return res.status(200).json({
      success: true,
      resource: { id: r.id, name: r.name, role: r.role || "" },
      buckets: buckets.map((b2) => ({ key: b2.key, label: b2.label })),
      tasks: rows,
    });
  } catch (error) {
    console.error("getWorkloadTasks error:", error);
    return res.status(500).json({ success: false, message: error.message, tasks: [] });
  }
};
