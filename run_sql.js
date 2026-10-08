const fs = require('fs');
const mysql = require('mysql2/promise');

const dbConfig = {
  host: '127.0.0.1',
  user: 'xmp_db',
  password: 'xmpdb123#',
  database: 'xmp_db',
  port: 3306,
  multipleStatements: true
};

async function runSQL() {
  try {
    const connection = await mysql.createConnection(dbConfig);
    const sql = fs.readFileSync('c:/Business/XPM/xmp_ai/db_bkp/xmp_db_celoxis_polish.sql', 'utf8');
    
    console.log('Executing SQL...');
    await connection.query(sql);
    console.log('SQL executed successfully!');
    
    await connection.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

runSQL();
