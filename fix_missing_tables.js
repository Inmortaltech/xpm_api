const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const dbConfig = { 
  host: '127.0.0.1', 
  user: 'xmp_db', 
  password: 'xmpdb123#', 
  database: 'xmp_db', 
  port: 3306
};

async function createMissingTables() {
  const connection = await mysql.createConnection(dbConfig);
  const backupDir = 'c:/Business/XPM/xmp_ai/db_bkp';
  
  const filesToRun = [
    'xmp_db_pmo_module.sql',
    'xmp_db_pm_pmo_module.sql',
    'xmp_db_user_module.sql',
    'xmp_db_celoxis_polish.sql',
    'xmp_db_celoxis_full.sql',
    'xmp_db_celoxis_partb.sql',
    'xmp_db_backlog_board_module.sql',
    'xmp_db_seed_accounts.sql'
  ];

  for (const file of filesToRun) {
    let sql = fs.readFileSync(path.join(backupDir, file), 'utf8');
    
    // find all CREATE TABLE blocks
    // This matches CREATE TABLE ... up to the first semicolon that follows a closing parenthesis
    const regex = /CREATE TABLE IF NOT EXISTS\s+`[^`]+`\s*\([\s\S]*?\)\s*ENGINE=[^;]+;/gi;
    
    let match;
    while ((match = regex.exec(sql)) !== null) {
      const createTableQuery = match[0];
      try {
        await connection.query(createTableQuery);
        console.log(`Executed CREATE TABLE from ${file}`);
      } catch (e) {
        console.error(`Error executing CREATE TABLE in ${file}:`, e.message);
      }
    }
  }

  await connection.end();
  console.log('Finished creating tables!');
}

createMissingTables();
