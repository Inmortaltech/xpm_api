// =============================================================================
//  EXPENSE CONTROLLER   —  Celoxis "Expenses" pillar
//
//  POST /api/admin/create_expense     { project_id, resource_id, category, description, amount, billable?, expense_date? }
//  GET  /api/admin/expenses           ?project_id&status&resource_id
//  POST /api/admin/approve_expense    { id, note? }
//  POST /api/admin/reject_expense     { id, note }
//  GET  /api/admin/expense_summary    ?project_id
// =============================================================================

const sequelize = require("../config/db");
const { logActivity } = require("./_activity");
const { parsePage, meta } = require("../utils/paginate");

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const fmtDate = (d) => {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().split("T")[0];
};

let ready = false;
const ensure = async () => {
  if (ready) return;
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INT NOT NULL AUTO_INCREMENT,
      expense_code VARCHAR(30) DEFAULT NULL,
      project_id INT DEFAULT NULL,
      resource_id INT DEFAULT NULL,
      category VARCHAR(60) DEFAULT NULL,
      description VARCHAR(500) DEFAULT NULL,
      amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      currency VARCHAR(6) NOT NULL DEFAULT 'INR',
      billable TINYINT(1) NOT NULL DEFAULT 0,
      expense_date DATE DEFAULT NULL,
      receipt VARCHAR(255) DEFAULT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'submitted',
      approver_id INT DEFAULT NULL,
      decided_at DATETIME DEFAULT NULL,
      decision_note VARCHAR(500) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_exp_project (project_id, status),
      KEY idx_exp_resource (resource_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  ready = true;
};

const nextCode = async () => {
  const rows = await sequelize.query(
    `SELECT expense_code FROM expenses WHERE expense_code LIKE 'EXP-%' ORDER BY id DESC LIMIT 1`,
    { type: sequelize.QueryTypes.SELECT }
  );
  let seq = 1;
  if (rows.length) {
    const m = /(\d+)$/.exec(rows[0].expense_code);
    if (m) seq = parseInt(m[1].slice(-3), 10) + 1;
  }
  return `EXP-${new Date().getFullYear()}${String(seq).padStart(3, "0")}`;
};

exports.createExpense = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const amount = Number(b.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "amount must be greater than 0" });
    }
    const code = await nextCode();
    const [id] = await sequelize.query(
      `INSERT INTO expenses (expense_code, project_id, resource_id, category, description, amount, currency, billable, expense_date, receipt, status)
       VALUES (:code, :pid, :rid, :cat, :desc, :amt, :cur, :bill, :edate, :receipt, 'submitted')`,
      {
        replacements: {
          code,
          pid: toInt(b.project_id),
          rid: toInt(b.resource_id),
          cat: b.category || "Other",
          desc: b.description || null,
          amt: amount,
          cur: b.currency || "INR",
          bill: b.billable ? 1 : 0,
          edate: fmtDate(b.expense_date) || new Date().toISOString().split("T")[0],
          receipt: req.file ? req.file.filename : b.receipt || null,
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );
    await logActivity({
      entity_type: "expense",
      entity_id: code,
      project_id: toInt(b.project_id),
      actor_id: toInt(b.resource_id),
      action: "submitted",
      detail: `Expense ${code} submitted — ${b.category || "Other"} ${b.currency || "INR"} ${amount}`,
    });
    return res.status(201).json({ success: true, message: "Expense submitted", data: { id, expense_code: code } });
  } catch (error) {
    console.error("createExpense error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getExpenses = async (req, res) => {
  try {
    await ensure();
    const projectId = toInt(req.query.project_id);
    const resourceId = toInt(req.query.resource_id);
    const status = req.query.status ? String(req.query.status) : null;

    const where = ["1=1"];
    const repl = {};
    if (projectId) { where.push("e.project_id = :pid"); repl.pid = projectId; }
    if (resourceId) { where.push("e.resource_id = :rid"); repl.rid = resourceId; }
    if (status) { where.push("e.status = :st"); repl.st = status; }
    const whereSql = where.join(" AND ");

    const { page, limit, offset } = parsePage(req, { defLimit: 25, maxLimit: 200 });

    const [cnt] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM expenses e WHERE ${whereSql}`,
      { replacements: repl, type: sequelize.QueryTypes.SELECT }
    );

    const rows = await sequelize.query(
      `SELECT e.*, p.project_name, u.name AS resource_name
       FROM expenses e
       LEFT JOIN projects p ON p.id = e.project_id
       LEFT JOIN users u ON u.id = e.resource_id
       WHERE ${whereSql}
       ORDER BY e.id DESC
       LIMIT :__limit OFFSET :__offset`,
      { replacements: { ...repl, __limit: limit, __offset: offset }, type: sequelize.QueryTypes.SELECT }
    );
    return res.status(200).json({
      success: true,
      count: rows.length,
      pagination: meta(cnt?.n, page, limit),
      data: rows,
    });
  } catch (error) {
    console.error("getExpenses error:", error);
    return res.status(500).json({ success: false, message: error.message, data: [] });
  }
};

exports.expenseSummary = async (req, res) => {
  try {
    await ensure();
    const projectId = toInt(req.query.project_id);
    const rows = await sequelize.query(
      `SELECT status, category, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total,
              COALESCE(SUM(CASE WHEN billable=1 THEN amount ELSE 0 END),0) AS billable_total
       FROM expenses ${projectId ? "WHERE project_id = :pid" : ""}
       GROUP BY status, category`,
      { replacements: projectId ? { pid: projectId } : {}, type: sequelize.QueryTypes.SELECT }
    );
    const byStatus = {};
    const byCategory = {};
    let total = 0;
    let billable = 0;
    rows.forEach((r) => {
      byStatus[r.status] = (byStatus[r.status] || 0) + Number(r.total);
      byCategory[r.category] = (byCategory[r.category] || 0) + Number(r.total);
      total += Number(r.total);
      billable += Number(r.billable_total);
    });
    return res.status(200).json({
      success: true,
      data: { total, billable, non_billable: total - billable, by_status: byStatus, by_category: byCategory },
    });
  } catch (error) {
    console.error("expenseSummary error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const decide = async (req, res, newStatus) => {
  await ensure();
  const b = req.body || {};
  const id = toInt(b.id);
  const code = !id && (b.id || b.expense_code) ? String(b.id || b.expense_code) : null;
  if (!id && !code) return res.status(400).json({ success: false, message: "id or expense_code is required" });
  const keyClause = id ? "id = :id" : "expense_code = :code";
  const rows = await sequelize.query(
    `SELECT id, expense_code, project_id FROM expenses WHERE ${keyClause} LIMIT 1`,
    { replacements: { id, code }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows.length) return res.status(404).json({ success: false, message: "Expense not found" });
  await sequelize.query(
    `UPDATE expenses SET status = :st, approver_id = :approver, decided_at = NOW(), decision_note = :note WHERE id = :rid`,
    { replacements: { rid: rows[0].id, st: newStatus, approver: toInt(b.approver_id ?? b.pm_id ?? b.pmo_id), note: b.note || null } }
  );
  await logActivity({
    entity_type: "expense",
    entity_id: rows[0]?.expense_code || String(id),
    project_id: rows[0]?.project_id,
    actor_id: toInt(b.approver_id ?? b.pm_id ?? b.pmo_id),
    action: newStatus,
    detail: newStatus === "approved" ? "Expense approved" : `Expense rejected: ${b.note || "no reason"}`,
  });
  return res.status(200).json({ success: true, message: `Expense ${newStatus}` });
};

exports.approveExpense = (req, res) =>
  decide(req, res, "approved").catch((e) => {
    console.error("approveExpense error:", e);
    res.status(500).json({ success: false, message: e.message });
  });
exports.rejectExpense = (req, res) =>
  decide(req, res, "rejected").catch((e) => {
    console.error("rejectExpense error:", e);
    res.status(500).json({ success: false, message: e.message });
  });
