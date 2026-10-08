// =============================================================================
//  REPORT BUILDER  (Celoxis custom reports — constrained, safe query builder)
//
//  POST /api/admin/run_report        { entity, columns[], filters[], group_by?, order_by?, limit? }
//  GET  /api/admin/report_fields     ?entity           -> allowed columns for an entity
//  GET  /api/admin/saved_reports
//  POST /api/admin/save_report       { id?, name, entity, config }
//  POST /api/admin/delete_report     { id }
//  POST /api/admin/run_saved_report  { id }
//
//  Only whitelisted entities + columns are queryable; values are always bound.
// =============================================================================

const sequelize = require("../config/db");
const { send: sendMail, mailerMode } = require("../utils/mailer");
const { logActivity } = require("./_activity");
const S = (q, r) => sequelize.query(q, { replacements: r || {}, type: sequelize.QueryTypes.SELECT });
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

// entity -> { table, alias, join, cols:{ outName: "sqlExpr" } }
const ENTITIES = {
  projects: {
    from: "projects p",
    cols: {
      id: "p.id", project_code: "p.project_code", project_name: "p.project_name",
      project_manager: "p.project_manager", company_name: "p.company_name",
      status: "p.status", priority: "p.priority", phase: "p.phase",
      health: "p.health", progress_pct: "p.progress_pct",
      budget: "p.budget", actual_cost: "p.actual_cost", billed_amount: "p.billed_amount",
      start_date: "p.start_date", end_date: "p.end_date", methodology: "p.methodology",
      portfolio_id: "p.portfolio_id",
    },
  },
  timesheets: {
    from: "timesheets t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.resource_id",
    cols: {
      id: "t.id", resource: "u.name", project_name: "p.project_name", task_name: "t.task_name",
      work_date: "t.work_date", hours: "t.hours", billable: "t.billable", status: "t.status",
      week_start: "t.week_start", invoiced: "t.invoiced",
    },
  },
  expenses: {
    from: "expenses e LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN users u ON u.id = e.resource_id",
    cols: {
      id: "e.id", expense_code: "e.expense_code", project_name: "p.project_name", claimant: "u.name",
      category: "e.category", description: "e.description", amount: "e.amount",
      billable: "e.billable", status: "e.status", expense_date: "e.expense_date",
    },
  },
  risks: {
    from: "risks r LEFT JOIN projects p ON p.id = r.project_id",
    cols: {
      id: "r.id", project_name: "p.project_name", task_name: "r.task_name", state: "r.state",
      impact: "r.impact", probability: "r.probability", severity: "r.severity",
      severity_score: "r.severity_score", mitigation: "r.mitigation", target_date: "r.target_date",
    },
  },
  issues: {
    from: "boards b LEFT JOIN projects p ON p.id = b.project_id LEFT JOIN users u ON u.id = b.resource_id",
    cols: {
      id: "b.id", item_key: "b.item_key", project_name: "p.project_name", title: "b.title",
      type: "b.type", priority: "b.priority", status: "b.status", assignee: "u.name",
      story_points: "b.story_points", sprint_id: "b.sprint_id", due_date: "b.due_date",
    },
    where: "b.is_active = 1",
  },
  resources: {
    from: "resources r",
    cols: {
      id: "r.id", name: "r.name", role: "r.role", email: "r.email",
      cost_rate: "r.cost_rate", bill_rate: "r.bill_rate", capacity_hours: "r.capacity_hours",
      is_active: "r.is_active",
    },
  },
  invoices: {
    from: "invoices i LEFT JOIN projects p ON p.id = i.project_id",
    cols: {
      id: "i.id", invoice_no: "i.invoice_no", project_name: "p.project_name", type: "i.type",
      status: "i.status", issue_date: "i.issue_date", due_date: "i.due_date",
      subtotal: "i.subtotal", total: "i.total", paid_amount: "i.paid_amount",
    },
  },
};

const OPS = {
  eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
  like: "LIKE", in: "IN", not_in: "NOT IN", is_null: "IS NULL", not_null: "IS NOT NULL",
};

function buildQuery(cfg) {
  const ent = ENTITIES[cfg.entity];
  if (!ent) throw new Error(`Unknown entity "${cfg.entity}"`);

  const wanted = (Array.isArray(cfg.columns) && cfg.columns.length ? cfg.columns : Object.keys(ent.cols))
    .filter((c) => ent.cols[c]);
  if (wanted.length === 0) throw new Error("No valid columns selected");

  const selectParts = wanted.map((c) => `${ent.cols[c]} AS \`${c}\``);
  const where = [];
  const repl = {};
  if (ent.where) where.push(ent.where);

  (Array.isArray(cfg.filters) ? cfg.filters : []).forEach((f, i) => {
    const col = ent.cols[f.field];
    const op = OPS[f.op];
    if (!col || !op) return;
    if (op === "IS NULL" || op === "IS NOT NULL") {
      where.push(`${col} ${op}`);
    } else if (op === "IN" || op === "NOT IN") {
      const vals = Array.isArray(f.value) ? f.value : [f.value];
      repl[`f${i}`] = vals;
      where.push(`${col} ${op} (:f${i})`);
    } else {
      repl[`f${i}`] = op === "LIKE" ? `%${f.value}%` : f.value;
      where.push(`${col} ${op} :f${i}`);
    }
  });

  let groupExpr = "";
  if (cfg.group_by && ent.cols[cfg.group_by]) {
    // aggregate mode: group col + count + numeric sums
    const numCols = wanted.filter((c) => /amount|hours|budget|cost|points|total|rate|progress|score/.test(c));
    const g = ent.cols[cfg.group_by];
    const parts = [`${g} AS \`${cfg.group_by}\``, `COUNT(*) AS \`count\``];
    numCols.forEach((c) => parts.push(`COALESCE(SUM(${ent.cols[c]}),0) AS \`${c}\``));
    groupExpr = ` GROUP BY ${g}`;
    return {
      sql: `SELECT ${parts.join(", ")} FROM ${ent.from}${where.length ? " WHERE " + where.join(" AND ") : ""}${groupExpr} ORDER BY \`count\` DESC LIMIT :__lim`,
      repl: { ...repl, __lim: Math.min(1000, toInt(cfg.limit) || 500) },
      grouped: true,
    };
  }

  let orderExpr = "";
  if (cfg.order_by && cfg.order_by.field && ent.cols[cfg.order_by.field]) {
    const dir = String(cfg.order_by.dir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    orderExpr = ` ORDER BY ${ent.cols[cfg.order_by.field]} ${dir}`;
  }

  const lim = Math.min(2000, toInt(cfg.limit) || 500);
  const page = Math.max(1, toInt(cfg.page) || 1);
  const off = (page - 1) * lim;
  return {
    sql: `SELECT ${selectParts.join(", ")} FROM ${ent.from}${where.length ? " WHERE " + where.join(" AND ") : ""}${orderExpr} LIMIT :__lim OFFSET :__off`,
    repl: { ...repl, __lim: lim, __off: off },
    grouped: false,
    page,
    limit: lim,
  };
}

exports.reportFields = (req, res) => {
  const entity = req.query.entity;
  if (entity && ENTITIES[entity]) {
    return res.json({ success: true, entity, fields: Object.keys(ENTITIES[entity].cols), operators: Object.keys(OPS) });
  }
  return res.json({ success: true, entities: Object.keys(ENTITIES) });
};

exports.runReport = async (req, res) => {
  try {
    const cfg = req.body || {};
    const { sql, repl, grouped, page, limit } = buildQuery(cfg);
    const rows = await sequelize.query(sql, { replacements: repl, type: sequelize.QueryTypes.SELECT });
    return res.status(200).json({
      success: true, entity: cfg.entity, grouped, count: rows.length,
      pagination: grouped ? null : { page: page || 1, limit: limit || rows.length, has_more: !grouped && rows.length === (limit || 0) },
      data: rows,
    });
  } catch (error) {
    console.error("runReport error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

let ready = false;
const ensure = async () => {
  if (ready) return;
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS saved_reports (
      id INT NOT NULL AUTO_INCREMENT, name VARCHAR(150) NOT NULL, entity VARCHAR(30) NOT NULL,
      config TEXT NOT NULL, owner_id INT DEFAULT NULL, is_shared TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Part B — scheduled delivery columns + audit trail (guarded)
  for (const ddl of [
    `ALTER TABLE saved_reports ADD COLUMN schedule_freq VARCHAR(12) DEFAULT NULL`,
    `ALTER TABLE saved_reports ADD COLUMN schedule_hour TINYINT NOT NULL DEFAULT 7`,
    `ALTER TABLE saved_reports ADD COLUMN recipients VARCHAR(1000) DEFAULT NULL`,
    `ALTER TABLE saved_reports ADD COLUMN next_run_at DATETIME DEFAULT NULL`,
    `ALTER TABLE saved_reports ADD COLUMN last_run_at DATETIME DEFAULT NULL`,
  ]) {
    try { await sequelize.query(ddl); } catch (_) { /* exists */ }
  }
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS report_deliveries (
      id INT NOT NULL AUTO_INCREMENT, report_id INT DEFAULT NULL, report_name VARCHAR(150) DEFAULT NULL,
      recipients VARCHAR(1000) DEFAULT NULL, row_count INT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'sent', mode VARCHAR(16) NOT NULL DEFAULT 'log',
      detail VARCHAR(500) DEFAULT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_rdel_report (report_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  ready = true;
};

const FREQS = new Set(["daily", "weekly", "monthly"]);

// next occurrence of `hour` for the given frequency, strictly in the future
function computeNextRun(freq, hour) {
  const h = Math.min(23, Math.max(0, toInt(hour) || 7));
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, 0, 0, 0);
  if (freq === "daily") {
    if (next <= now) next.setDate(next.getDate() + 1);
  } else if (freq === "weekly") {
    // next Monday at hour
    const day = next.getDay(); // 0 Sun .. 1 Mon
    let add = (1 - day + 7) % 7;
    if (add === 0 && next <= now) add = 7;
    next.setDate(next.getDate() + add);
  } else if (freq === "monthly") {
    next.setDate(1);
    if (next <= now) next.setMonth(next.getMonth() + 1);
  } else {
    return null;
  }
  return next;
}

function advanceNextRun(freq, from) {
  const d = new Date(from);
  if (freq === "daily") d.setDate(d.getDate() + 1);
  else if (freq === "weekly") d.setDate(d.getDate() + 7);
  else if (freq === "monthly") d.setMonth(d.getMonth() + 1);
  else return null;
  return d;
}

// small plain-text + HTML rendering of result rows for the email body
function renderReport(name, rows) {
  if (!rows.length) return { text: `${name}\n\n(no rows)`, html: `<h3>${name}</h3><p>(no rows)</p>` };
  const keys = Object.keys(rows[0]);
  const head = keys.join(" | ");
  const sep = keys.map(() => "---").join(" | ");
  const body = rows.slice(0, 200).map((r) => keys.map((k) => String(r[k] ?? "")).join(" | ")).join("\n");
  const text = `${name}\n\n${head}\n${sep}\n${body}\n\n${rows.length} row(s).`;
  const th = keys.map((k) => `<th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ccc">${k}</th>`).join("");
  const trs = rows.slice(0, 200)
    .map((r) => `<tr>${keys.map((k) => `<td style="padding:4px 8px;border-bottom:1px solid #eee">${String(r[k] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  const html = `<h3>${name}</h3><table style="border-collapse:collapse;font:13px sans-serif"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table><p>${rows.length} row(s).</p>`;
  return { text, html };
}

exports.getSavedReports = async (req, res) => {
  try {
    await ensure();
    const rows = await S(`SELECT * FROM saved_reports ORDER BY id DESC`);
    return res.json({ success: true, data: rows.map((r) => ({ ...r, config: JSON.parse(r.config || "{}") })) });
  } catch (error) {
    console.error("getSavedReports error:", error);
    return res.status(500).json({ success: false, message: error.message, data: [] });
  }
};

exports.saveReport = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    if (!b.name || !b.entity || !ENTITIES[b.entity]) {
      return res.status(400).json({ success: false, message: "name and a valid entity are required" });
    }
    const config = JSON.stringify(b.config || {});
    const freq = FREQS.has(String(b.schedule_freq)) ? String(b.schedule_freq) : null;
    const hour = Math.min(23, Math.max(0, toInt(b.schedule_hour) || 7));
    const recipients = b.recipients ? String(b.recipients).trim() : null;
    const nextRun = freq ? computeNextRun(freq, hour) : null;

    if (b.id) {
      await sequelize.query(
        `UPDATE saved_reports
            SET name=:name, entity=:entity, config=:config,
                schedule_freq=:freq, schedule_hour=:hour, recipients=:rcpt,
                next_run_at = CASE WHEN :freq IS NULL THEN NULL
                                   ELSE COALESCE(next_run_at, :nextRun) END
          WHERE id=:id`,
        { replacements: { id: toInt(b.id), name: b.name, entity: b.entity, config, freq, hour, rcpt: recipients, nextRun } }
      );
      return res.json({ success: true, message: "Report updated", data: { id: toInt(b.id), next_run_at: nextRun } });
    }
    const [id] = await sequelize.query(
      `INSERT INTO saved_reports (name, entity, config, owner_id, schedule_freq, schedule_hour, recipients, next_run_at)
       VALUES (:name, :entity, :config, :owner, :freq, :hour, :rcpt, :nextRun)`,
      { replacements: { name: b.name, entity: b.entity, config, owner: toInt(b.owner_id), freq, hour, rcpt: recipients, nextRun }, type: sequelize.QueryTypes.INSERT }
    );
    return res.status(201).json({ success: true, message: "Report saved", data: { id, next_run_at: nextRun } });
  } catch (error) {
    console.error("saveReport error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteReport = async (req, res) => {
  try {
    await ensure();
    const id = toInt((req.body || {}).id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    await sequelize.query(`DELETE FROM saved_reports WHERE id = :id`, { replacements: { id } });
    return res.json({ success: true, message: "Report deleted" });
  } catch (error) {
    console.error("deleteReport error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.runSavedReport = async (req, res) => {
  try {
    await ensure();
    const id = toInt((req.body || {}).id ?? req.query.id);
    const [r] = await S(`SELECT * FROM saved_reports WHERE id = :id`, { id });
    if (!r) return res.status(404).json({ success: false, message: "Saved report not found" });
    const cfg = { entity: r.entity, ...JSON.parse(r.config || "{}"), page: toInt((req.body || {}).page ?? req.query.page) || 1 };
    const { sql, repl, grouped, page, limit } = buildQuery(cfg);
    const rows = await sequelize.query(sql, { replacements: repl, type: sequelize.QueryTypes.SELECT });
    return res.json({
      success: true, name: r.name, entity: r.entity, grouped, count: rows.length,
      pagination: grouped ? null : { page: page || 1, limit: limit || rows.length, has_more: !grouped && rows.length === (limit || 0) },
      data: rows,
    });
  } catch (error) {
    console.error("runSavedReport error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  B3.  SCHEDULED REPORT DELIVERY
//  runScheduledReports(): every saved_report whose next_run_at is due gets
//  executed and emailed (or logged), a report_deliveries row is written, and
//  next_run_at is advanced. Best-effort. Trigger: in-process interval,
//  POST /run_scheduled_reports, or a real cron hitting that endpoint.
// =============================================================================
let _lastReportSweep = 0;
async function runScheduledReports({ force = false } = {}) {
  await ensure();
  const now = Date.now();
  if (!force && now - _lastReportSweep < 60_000) return { skipped: true };
  _lastReportSweep = now;

  const due = await S(
    `SELECT * FROM saved_reports
      WHERE schedule_freq IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= NOW()`
  ).catch(() => []);

  const delivered = [];
  for (const r of due) {
    let rowCount = 0;
    let status = "sent";
    let mode = mailerMode();
    let detail = "";
    try {
      const cfg = { entity: r.entity, ...JSON.parse(r.config || "{}") };
      const { sql, repl } = buildQuery(cfg);
      const rows = await sequelize.query(sql, { replacements: repl, type: sequelize.QueryTypes.SELECT });
      rowCount = rows.length;
      const { text, html } = renderReport(r.name, rows);
      const out = await sendMail({
        to: r.recipients,
        subject: `[XMP] ${r.name} — ${new Date().toLocaleDateString("en-GB")}`,
        text,
        html,
      });
      mode = out.mode;
      detail = out.detail || "";
      if (!out.delivered && out.mode !== "log") status = "failed";
      if (!r.recipients) { status = "skipped"; detail = "no recipients configured"; }
    } catch (e) {
      status = "failed";
      detail = e.message;
    }

    await sequelize.query(
      `INSERT INTO report_deliveries (report_id, report_name, recipients, row_count, status, mode, detail)
       VALUES (:rid, :name, :rcpt, :rc, :st, :mode, :detail)`,
      { replacements: { rid: r.id, name: r.name, rcpt: r.recipients || null, rc: rowCount, st: status, mode, detail: detail.slice(0, 500) } }
    );

    const nxt = advanceNextRun(r.schedule_freq, new Date());
    await sequelize.query(
      `UPDATE saved_reports SET last_run_at = NOW(), next_run_at = :nxt WHERE id = :id`,
      { replacements: { nxt, id: r.id } }
    );
    await logActivity({
      entity_type: "report", entity_id: String(r.id), action: "delivered",
      detail: `"${r.name}" → ${r.recipients || "(none)"} · ${rowCount} rows · ${status}`,
    });
    delivered.push({ id: r.id, name: r.name, row_count: rowCount, status, mode });
  }
  return { skipped: false, delivered, count: delivered.length };
}
exports.runScheduledReports = runScheduledReports;

// POST /api/admin/run_scheduled_reports
exports.runScheduledReportsHandler = async (_req, res) => {
  try {
    const out = await runScheduledReports({ force: true });
    return res.status(200).json({ success: true, ...out });
  } catch (error) {
    console.error("runScheduledReports error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/report_deliveries?report_id=&limit=
exports.getReportDeliveries = async (req, res) => {
  try {
    await ensure();
    const reportId = toInt(req.query.report_id);
    const limit = Math.min(200, toInt(req.query.limit) || 50);
    const rows = await S(
      `SELECT * FROM report_deliveries
        ${reportId ? "WHERE report_id = :rid" : ""}
        ORDER BY id DESC LIMIT :lim`,
      reportId ? { rid: reportId, lim: limit } : { lim: limit }
    );
    return res.json({ success: true, mailer_mode: mailerMode(), count: rows.length, data: rows });
  } catch (error) {
    console.error("getReportDeliveries error:", error);
    return res.status(500).json({ success: false, message: error.message, data: [] });
  }
};
