const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const dbConfig = { host: '127.0.0.1', user: 'xmp_db', password: 'xmpdb123#', database: 'xmp_db', port: 3306 };

async function fixAll() {
  const connection = await mysql.createConnection(dbConfig);
  const backupDir = 'c:/Business/XPM/xmp_ai/db_bkp';
  const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.sql'));

  const queries = [];
  const regex = /CALL\s+xmp_[^\(]+\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*"([^"]+)"\s*\)/g;

  for (const file of files) {
    const content = fs.readFileSync(path.join(backupDir, file), 'utf8');
    let match;
    while ((match = regex.exec(content)) !== null) {
      const table = match[1];
      const col = match[2];
      const ddl = match[3];
      queries.push({ table, col, ddl: `ALTER TABLE \`${table}\` ADD COLUMN ${ddl}` });
    }
  }

  for (const q of queries) {
    try {
      await connection.query(q.ddl);
      console.log('Added:', q.table, q.col);
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        // console.log('Exists:', q.table, q.col);
      } else {
        console.error('Error on', q.ddl, e.message);
      }
    }
  }
  
  await connection.end();
  console.log('Finished updating columns!');
}

fixAll();
