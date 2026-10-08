// =============================================================================
//  INVOICE / AR CONTROLLER  (Celoxis billing)
//
//  GET  /api/admin/invoices              ?project_id&status
//  GET  /api/admin/invoice_detail        ?id
//  POST /api/admin/create_invoice        { project_id, type, tax_pct?, due_days?,
//                                          from_time?:bool, from_expense?:bool,
//                                          milestone?:{name,amount}, lines?:[...] }
//  POST /api/admin/update_invoice_status { id, status }        sent | paid | void
//  POST /api/admin/mark_invoice_paid     { id, paid_amount?, paid_date? }
//  GET  /api/admin/ar_aging              ?project_id           (0-30 / 31-60 / 61-90 / 90+)
// =============================================================================

const sequelize = require("../config/db");
const { logActivity } = require("./_activity");
const { parsePage, meta } = require("../utils/paginate");

const S = (q, r) => sequelize.query(q, { replacements: r || {}, type: sequelize.QueryTypes.SELECT });
const X = (q, r) => sequelize.query(q, r && r.replacements ? r : { replacements: r || {} });
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const num = (v) => {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};
const iso = (d) => (d ? new Date(d).toISOString().split("T")[0] : null);

let ready = false;
const ensure = async () => {
  if (ready) return;
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INT NOT NULL AUTO_INCREMENT, invoice_no VARCHAR(30) NOT NULL,
      project_id INT DEFAULT NULL, client_name VARCHAR(200) DEFAULT NULL,
      type VARCHAR(20) NOT NULL DEFAULT 'time_material', status VARCHAR(16) NOT NULL DEFAULT 'draft',
      issue_date DATE DEFAULT NULL, due_date DATE DEFAULT NULL, currency VARCHAR(6) NOT NULL DEFAULT 'INR',
      subtotal DECIMAL(15,2) NOT NULL DEFAULT 0, tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_amount DECIMAL(15,2) NOT NULL DEFAULT 0, total DECIMAL(15,2) NOT NULL DEFAULT 0,
      paid_amount DECIMAL(15,2) NOT NULL DEFAULT 0, paid_date DATE DEFAULT NULL,
      notes VARCHAR(500) DEFAULT NULL, created_by INT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_invoice_no (invoice_no), KEY idx_inv_project (project_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS invoice_lines (
      id INT NOT NULL AUTO_INCREMENT, invoice_id INT NOT NULL,
      description VARCHAR(300) NOT NULL, qty DECIMAL(10,2) NOT NULL DEFAULT 1,
      unit VARCHAR(20) DEFAULT 'hrs', rate DECIMAL(12,2) NOT NULL DEFAULT 0,
      amount DECIMAL(15,2) NOT NULL DEFAULT 0, source_type VARCHAR(20) DEFAULT 'manual',
      source_id VARCHAR(40) DEFAULT NULL,
      PRIMARY KEY (id), KEY idx_iline_invoice (invoice_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  for (const t of ["timesheets", "expenses"]) {
    try { await sequelize.query(`ALTER TABLE ${t} ADD COLUMN invoiced TINYINT(1) NOT NULL DEFAULT 0`); } catch (e) { /* exists */ }
  }
  ready = true;
};

const nextNo = async () => {
  const r = await S(`SELECT invoice_no FROM invoices WHERE invoice_no LIKE 'INV-%' ORDER BY id DESC LIMIT 1`);
  let seq = 1;
  if (r.length) {
    const m = /(\d+)$/.exec(r[0].invoice_no);
    if (m) seq = parseInt(m[1].slice(-3), 10) + 1;
  }
  return `INV-${new Date().getFullYear()}${String(seq).padStart(3, "0")}`;
};

exports.getInvoices = async (req, res) => {
  try {
    await ensure();
    const projectId = toInt(req.query.project_id);
    const status = req.query.status ? String(req.query.status) : null;
    const where = ["1=1"];
    const repl = {};
    if (projectId) { where.push("i.project_id = :pid"); repl.pid = projectId; }
    if (status) { where.push("i.status = :st"); repl.st = status; }
    const whereSql = where.join(" AND ");

    const { page, limit, offset } = parsePage(req, { defLimit: 25, maxLimit: 200 });
    const [cnt] = await S(`SELECT COUNT(*) AS n FROM invoices i WHERE ${whereSql}`, repl);

    const rows = await S(
      `SELECT i.*, p.project_name,
              DATEDIFF(CURDATE(), i.due_date) AS days_overdue
       FROM invoices i LEFT JOIN projects p ON p.id = i.project_id
       WHERE ${whereSql} ORDER BY i.id DESC
       LIMIT :__limit OFFSET :__offset`,
      { ...repl, __limit: limit, __offset: offset }
    );
    // auto-flag overdue
    const data = rows.map((i) => ({
      ...i,
      outstanding: num(i.total) - num(i.paid_amount),
      is_overdue: i.status === "sent" && num(i.days_overdue) > 0,
    }));
    return res.status(200).json({
      success: true,
      count: data.length,
      pagination: meta(cnt?.n, page, limit),
      data,
    });
  } catch (error) {
    console.error("getInvoices error:", error);
    return res.status(500).json({ success: false, message: error.message, data: [] });
  }
};

exports.getInvoiceDetail = async (req, res) => {
  try {
    await ensure();
    const id = toInt(req.query.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    const [inv] = await S(`SELECT i.*, p.project_name FROM invoices i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = :id`, { id });
    if (!inv) return res.status(404).json({ success: false, message: "Invoice not found" });
    const lines = await S(`SELECT * FROM invoice_lines WHERE invoice_id = :id ORDER BY id`, { id });
    return res.status(200).json({ success: true, data: { ...inv, lines } });
  } catch (error) {
    console.error("getInvoiceDetail error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createInvoice = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const projectId = toInt(b.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });

    const [proj] = await S(`SELECT project_name, company_name FROM projects WHERE id = :id`, { id: projectId });
    const lines = [];

    // pull un-invoiced approved billable time
    if (b.from_time) {
      const t = await S(
        `SELECT t.id, t.task_name, SUM(t.hours) AS hrs, MAX(COALESCE(r.bill_rate,3000)) AS rate
         FROM timesheets t
         LEFT JOIN resources r ON r.user_id = t.resource_id OR r.id = t.resource_id
         WHERE t.project_id = :pid AND t.status = 'approved' AND t.billable = 1 AND COALESCE(t.invoiced,0) = 0
         GROUP BY t.task_name`,
        { pid: projectId }
      );
      t.forEach((row) => {
        const amt = num(row.hrs) * num(row.rate);
        if (amt > 0) lines.push({ description: `Billable time — ${row.task_name || "work"}`, qty: num(row.hrs), unit: "hrs", rate: num(row.rate), amount: amt, source_type: "time" });
      });
    }

    // pull un-invoiced approved billable expenses
    if (b.from_expense) {
      const e = await S(
        `SELECT id, description, amount FROM expenses
         WHERE project_id = :pid AND status = 'approved' AND billable = 1 AND COALESCE(invoiced,0) = 0`,
        { pid: projectId }
      );
      e.forEach((row) => lines.push({ description: `Expense — ${row.description || "reimbursable"}`, qty: 1, unit: "item", rate: num(row.amount), amount: num(row.amount), source_type: "expense", source_id: String(row.id) }));
    }

    // milestone line
    if (b.milestone && b.milestone.amount) {
      lines.push({ description: `Milestone — ${b.milestone.name || "delivery"}`, qty: 1, unit: "milestone", rate: num(b.milestone.amount), amount: num(b.milestone.amount), source_type: "milestone" });
    }

    // manual lines
    (Array.isArray(b.lines) ? b.lines : []).forEach((l) => {
      const qty = num(l.qty) || 1;
      const rate = num(l.rate);
      lines.push({ description: l.description || "Line item", qty, unit: l.unit || "item", rate, amount: num(l.amount) || qty * rate, source_type: "manual" });
    });

    if (lines.length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to invoice — no un-invoiced billable time/expense and no lines supplied." });
    }

    const subtotal = lines.reduce((s, l) => s + num(l.amount), 0);
    const taxPct = num(b.tax_pct);
    const taxAmt = Math.round((subtotal * taxPct) / 100);
    const total = subtotal + taxAmt;
    const dueDays = toInt(b.due_days) || 15;
    const no = await nextNo();

    const [invId] = await sequelize.query(
      `INSERT INTO invoices (invoice_no, project_id, client_name, type, status, issue_date, due_date,
                             subtotal, tax_pct, tax_amount, total, created_by)
       VALUES (:no, :pid, :client, :type, 'draft', CURDATE(), DATE_ADD(CURDATE(), INTERVAL :due DAY),
               :sub, :tp, :ta, :tot, :by)`,
      {
        replacements: {
          no, pid: projectId, client: b.client_name || proj?.company_name || null,
          type: b.type || "time_material", due: dueDays, sub: subtotal, tp: taxPct, ta: taxAmt, tot: total,
          by: toInt(b.created_by),
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );

    for (const l of lines) {
      await X(
        `INSERT INTO invoice_lines (invoice_id, description, qty, unit, rate, amount, source_type, source_id)
         VALUES (:iid, :d, :q, :u, :r, :a, :st, :sid)`,
        { iid: invId, d: l.description, q: l.qty, u: l.unit, r: l.rate, a: l.amount, st: l.source_type, sid: l.source_id || null }
      );
    }
    // mark source rows invoiced
    if (b.from_time) await X(`UPDATE timesheets SET invoiced = 1 WHERE project_id = :pid AND status='approved' AND billable=1 AND COALESCE(invoiced,0)=0`, { pid: projectId });
    if (b.from_expense) await X(`UPDATE expenses SET invoiced = 1 WHERE project_id = :pid AND status='approved' AND billable=1 AND COALESCE(invoiced,0)=0`, { pid: projectId });

    await logActivity({
      entity_type: "invoice", entity_id: no, project_id: projectId, actor_id: toInt(b.created_by),
      action: "created", detail: `Invoice ${no} raised — ${total}`,
    });
    return res.status(201).json({ success: true, message: "Invoice created", data: { id: invId, invoice_no: no, subtotal, tax_amount: taxAmt, total } });
  } catch (error) {
    console.error("createInvoice error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateInvoiceStatus = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const id = toInt(b.id);
    const status = String(b.status || "").toLowerCase();
    if (!id || !["sent", "paid", "void", "draft"].includes(status)) {
      return res.status(400).json({ success: false, message: "id and a valid status are required" });
    }
    const extra = status === "paid" ? ", paid_amount = total, paid_date = CURDATE()" : "";
    await X(`UPDATE invoices SET status = :st ${extra} WHERE id = :id`, { replacements: { st: status, id } });
    const [row] = await S(`SELECT invoice_no, project_id FROM invoices WHERE id = :id`, { id });
    await logActivity({ entity_type: "invoice", entity_id: row?.invoice_no || String(id), project_id: row?.project_id, action: status, detail: `Invoice ${row?.invoice_no} marked ${status}` });
    return res.status(200).json({ success: true, message: `Invoice ${status}` });
  } catch (error) {
    console.error("updateInvoiceStatus error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.markInvoicePaid = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const id = toInt(b.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    const [inv] = await S(`SELECT total FROM invoices WHERE id = :id`, { id });
    const paid = b.paid_amount != null ? num(b.paid_amount) : num(inv?.total);
    const status = paid >= num(inv?.total) ? "paid" : "sent";
    await X(`UPDATE invoices SET paid_amount = :p, paid_date = :d, status = :st WHERE id = :id`, {
      replacements: { p: paid, d: iso(b.paid_date) || iso(new Date()), st: status, id },
    });
    return res.status(200).json({ success: true, message: "Payment recorded", data: { paid, status } });
  } catch (error) {
    console.error("markInvoicePaid error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.arAging = async (req, res) => {
  try {
    await ensure();
    const projectId = toInt(req.query.project_id);
    const rows = await S(
      `SELECT total, paid_amount, DATEDIFF(CURDATE(), due_date) AS overdue
       FROM invoices
       WHERE status IN ('sent','overdue') ${projectId ? "AND project_id = :pid" : ""}`,
      projectId ? { pid: projectId } : {}
    );
    const bucket = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total_outstanding: 0 };
    rows.forEach((r) => {
      const out = num(r.total) - num(r.paid_amount);
      bucket.total_outstanding += out;
      const o = num(r.overdue);
      if (o <= 0) bucket.current += out;
      else if (o <= 30) bucket.d1_30 += out;
      else if (o <= 60) bucket.d31_60 += out;
      else if (o <= 90) bucket.d61_90 += out;
      else bucket.d90_plus += out;
    });
    return res.status(200).json({ success: true, data: bucket, invoice_count: rows.length });
  } catch (error) {
    console.error("arAging error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
