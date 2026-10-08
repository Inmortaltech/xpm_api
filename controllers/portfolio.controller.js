// =============================================================================
//  PORTFOLIO / PROGRAM CONTROLLER  (Celoxis portfolios)
//
//  GET  /api/admin/portfolios
//  POST /api/admin/create_portfolio     { name, code?, description?, owner_id? }
//  POST /api/admin/update_portfolio     { id, ...fields }
//  POST /api/admin/assign_portfolio     { project_id, portfolio_id | null }
//  POST /api/admin/getPortfolioRollup   { portfolio_id }   (health / budget / progress roll-up)
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
    CREATE TABLE IF NOT EXISTS portfolios (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      code VARCHAR(30) DEFAULT NULL,
      description VARCHAR(500) DEFAULT NULL,
      owner_id INT DEFAULT NULL,
      color VARCHAR(12) DEFAULT '#3b5bdb',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  try { await sequelize.query(`ALTER TABLE projects ADD COLUMN portfolio_id INT DEFAULT NULL`); } catch (e) { /* exists */ }
  ready = true;
};

exports.getPortfolios = async (req, res) => {
  try {
    await ensure();
    const rows = await S(
      `SELECT pf.*, u.name AS owner_name,
              (SELECT COUNT(*) FROM projects p WHERE p.portfolio_id = pf.id) AS project_count,
              (SELECT COALESCE(SUM(p.budget),0) FROM projects p WHERE p.portfolio_id = pf.id) AS budget
       FROM portfolios pf LEFT JOIN users u ON u.id = pf.owner_id
       WHERE pf.is_active = 1 ORDER BY pf.id`
    );
    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("getPortfolios error:", error);
    return res.status(500).json({ success: false, message: error.message, data: [] });
  }
};

exports.createPortfolio = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ success: false, message: "name is required" });
    const [id] = await sequelize.query(
      `INSERT INTO portfolios (name, code, description, owner_id, color) VALUES (:name, :code, :desc, :owner, :color)`,
      {
        replacements: {
          name: b.name,
          code: b.code || null,
          desc: b.description || null,
          owner: toInt(b.owner_id),
          color: b.color || "#3b5bdb",
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );
    return res.status(201).json({ success: true, message: "Portfolio created", data: { id } });
  } catch (error) {
    console.error("createPortfolio error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updatePortfolio = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const id = toInt(b.id);
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    const cols = { name: 1, code: 1, description: 1, owner_id: 1, color: 1, is_active: 1 };
    const sets = [];
    const repl = { id };
    for (const k of Object.keys(cols)) {
      if (Object.prototype.hasOwnProperty.call(b, k)) {
        sets.push(`${k} = :${k}`);
        repl[k] = k === "owner_id" || k === "is_active" ? toInt(b[k]) : b[k];
      }
    }
    if (!sets.length) return res.status(400).json({ success: false, message: "nothing to update" });
    await sequelize.query(`UPDATE portfolios SET ${sets.join(", ")} WHERE id = :id`, { replacements: repl });
    return res.status(200).json({ success: true, message: "Portfolio updated" });
  } catch (error) {
    console.error("updatePortfolio error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.assignPortfolio = async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const projectId = toInt(b.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: "project_id is required" });
    const pfId = b.portfolio_id === null || b.portfolio_id === "null" ? null : toInt(b.portfolio_id);
    await sequelize.query(`UPDATE projects SET portfolio_id = :pf WHERE id = :id`, {
      replacements: { pf: pfId, id: projectId },
    });
    return res.status(200).json({ success: true, message: pfId ? "Project added to portfolio" : "Project removed from portfolio" });
  } catch (error) {
    console.error("assignPortfolio error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPortfolioRollup = async (req, res) => {
  try {
    await ensure();
    const pfId = toInt((req.body || {}).portfolio_id ?? req.query.portfolio_id);
    if (!pfId) return res.status(400).json({ success: false, message: "portfolio_id is required" });

    const { _enrichProject } = require("./analytics.controller");
    const [pf] = await S(`SELECT * FROM portfolios WHERE id = :id LIMIT 1`, { id: pfId });
    if (!pf) return res.status(404).json({ success: false, message: "Portfolio not found" });

    const projects = await S(`SELECT * FROM projects WHERE portfolio_id = :id`, { id: pfId });
    const enriched = [];
    for (const p of projects) {
      try { enriched.push(await _enrichProject(p)); } catch { enriched.push(p); }
    }

    const byHealth = { green: 0, amber: 0, red: 0 };
    let budget = 0, actual = 0, progressSum = 0;
    enriched.forEach((p) => {
      if (byHealth[p.health] != null) byHealth[p.health] += 1;
      budget += Number(p.budget) || 0;
      actual += Number(p.actual_cost) || 0;
      progressSum += Number(p.progress) || 0;
    });

    return res.status(200).json({
      success: true,
      data: {
        portfolio: pf,
        project_count: enriched.length,
        by_health: byHealth,
        budget,
        actual_cost: actual,
        avg_progress: enriched.length ? Math.round(progressSum / enriched.length) : 0,
        projects: enriched.map((p) => ({
          id: p.id,
          project_code: p.project_code,
          project_name: p.project_name,
          project_manager: p.project_manager,
          health: p.health,
          progress: p.progress,
          budget: p.budget,
          end_date: p.end_date,
          status: p.status,
        })),
      },
    });
  } catch (error) {
    console.error("getPortfolioRollup error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
