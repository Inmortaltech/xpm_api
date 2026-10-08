// =============================================================================
//  ACTIVITY LOG helper  —  Celoxis-style unified audit trail.
//  logActivity() is best-effort: it never throws into the caller's flow.
// =============================================================================
const sequelize = require("../config/db");

let ready = false;
const ensure = async () => {
  if (ready) return;
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id BIGINT NOT NULL AUTO_INCREMENT,
      entity_type VARCHAR(40) NOT NULL,
      entity_id VARCHAR(40) DEFAULT NULL,
      project_id INT DEFAULT NULL,
      actor_id INT DEFAULT NULL,
      actor_name VARCHAR(150) DEFAULT NULL,
      action VARCHAR(60) NOT NULL,
      detail VARCHAR(500) DEFAULT NULL,
      meta TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_act_project (project_id, created_at),
      KEY idx_act_entity (entity_type, entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  ready = true;
};

const nameCache = new Map();
const resolveName = async (id) => {
  if (!id) return null;
  if (nameCache.has(id)) return nameCache.get(id);
  try {
    const r = await sequelize.query(`SELECT name FROM users WHERE id = :id LIMIT 1`, {
      replacements: { id },
      type: sequelize.QueryTypes.SELECT,
    });
    const n = r[0]?.name || null;
    nameCache.set(id, n);
    return n;
  } catch {
    return null;
  }
};

async function logActivity(opts = {}) {
  try {
    await ensure();
    const actorName = opts.actor_name || (await resolveName(opts.actor_id));
    await sequelize.query(
      `INSERT INTO activity_log (entity_type, entity_id, project_id, actor_id, actor_name, action, detail, meta)
       VALUES (:entity_type, :entity_id, :project_id, :actor_id, :actor_name, :action, :detail, :meta)`,
      {
        replacements: {
          entity_type: opts.entity_type || "system",
          entity_id: opts.entity_id != null ? String(opts.entity_id) : null,
          project_id: opts.project_id != null ? Number(opts.project_id) || null : null,
          actor_id: opts.actor_id != null ? Number(opts.actor_id) || null : null,
          actor_name: actorName,
          action: opts.action || "updated",
          detail: opts.detail || null,
          meta: opts.meta ? JSON.stringify(opts.meta) : null,
        },
      }
    );
  } catch (e) {
    console.warn("logActivity failed:", e.message);
  }
}

module.exports = { logActivity };
