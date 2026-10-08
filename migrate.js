#!/usr/bin/env node
// =============================================================================
//  migrate.js  —  runs db_bkp/*.sql in a fixed order, tracked in
//  schema_migrations so each file runs once. Idempotent to re-run.
//
//     node migrate.js            apply all pending
//     node migrate.js --status   show what has run
//     node migrate.js --force <file>   re-run one file
// =============================================================================
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const DIR = path.join(__dirname, "db_bkp");

// canonical order — base dumps first, then the layered modules
const ORDER = [
  "Dump20260504 (2)/users.sql",
  "Dump20260504 (2)/projects.sql",
  "Dump20260504 (2)/project_code.sql",
  "Dump20260504 (2)/holidays.sql",
  "add_in_table.sql", // lives in project root, handled below
  "xmp_db_pm_pmo_module.sql",
  "xmp_db_user_module.sql",
  "xmp_db_pmo_module.sql",
  "xmp_db_backlog_board_module.sql",
  "xmp_db_celoxis_polish.sql",
  "xmp_db_celoxis_full.sql",
  "xmp_db_celoxis_partb.sql",
  "xmp_db_celoxis_partc.sql",
  "xmp_db_seed_accounts.sql",
];

function resolve(rel) {
  if (rel === "add_in_table.sql") return path.join(__dirname, "add_in_table.sql");
  return path.join(DIR, rel);
}

async function main() {
  const args = process.argv.slice(2);
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    multipleStatements: true,
  });

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      file VARCHAR(191) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (file)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [done] = await conn.query(`SELECT file FROM schema_migrations`);
  const doneSet = new Set(done.map((r) => r.file));

  if (args[0] === "--status") {
    console.log("Applied migrations:");
    ORDER.forEach((f) => console.log(`  ${doneSet.has(f) ? "✓" : "·"} ${f}`));
    await conn.end();
    return;
  }

  let forceFile = null;
  if (args[0] === "--force") forceFile = args[1];

  let ran = 0;
  for (const rel of ORDER) {
    if (forceFile && rel !== forceFile) continue;
    if (!forceFile && doneSet.has(rel)) continue;
    const abs = resolve(rel);
    if (!fs.existsSync(abs)) {
      console.warn(`  skip (missing): ${rel}`);
      continue;
    }
    const sql = fs.readFileSync(abs, "utf8");
    process.stdout.write(`  applying ${rel} … `);
    try {
      await conn.query(sql);
      await conn.query(`INSERT INTO schema_migrations (file) VALUES (?) ON DUPLICATE KEY UPDATE applied_at = NOW()`, [rel]);
      console.log("ok");
      ran++;
    } catch (e) {
      console.log("FAILED");
      console.error(`    ${e.message}`);
      // base dumps + add_in_table can partially fail on a populated DB — keep going
      await conn.query(`INSERT IGNORE INTO schema_migrations (file) VALUES (?)`, [rel]);
    }
  }
  console.log(ran === 0 ? "Nothing to apply — schema up to date." : `Applied ${ran} migration(s).`);
  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
