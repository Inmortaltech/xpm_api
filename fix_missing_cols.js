const mysql = require('mysql2/promise');
const dbConfig = { host: '127.0.0.1', user: 'xmp_db', password: 'xmpdb123#', database: 'xmp_db', port: 3306 };

async function fix() {
  const connection = await mysql.createConnection(dbConfig);
  const queries = [
    "ALTER TABLE projects ADD COLUMN project_manager_id INT DEFAULT NULL",
    "ALTER TABLE projects ADD COLUMN technical_lead VARCHAR(255) DEFAULT NULL",
    "ALTER TABLE projects ADD COLUMN technology VARCHAR(255) DEFAULT NULL",
    "ALTER TABLE project_schedule ADD COLUMN predecessor_id INT DEFAULT NULL",
    "ALTER TABLE project_schedule ADD COLUMN predecessor_type VARCHAR(50) DEFAULT NULL",
    "ALTER TABLE project_schedule ADD COLUMN lag_days INT DEFAULT 0",
    "ALTER TABLE holidays ADD COLUMN is_recurring TINYINT(1) DEFAULT 0",
    "ALTER TABLE project_schedule ADD COLUMN auto_schedule TINYINT(1) DEFAULT 0",
    "ALTER TABLE users ADD COLUMN account_name VARCHAR(255) DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN company_name VARCHAR(255) DEFAULT NULL"
  ];
  for (let q of queries) {
    try {
      await connection.query(q);
      console.log('Success:', q);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error:', e.message, 'on', q);
      } else {
        console.log('Skipped (already exists):', q);
      }
    }
  }
  await connection.end();
}
fix();
