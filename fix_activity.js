const fs = require('fs');
const mysql = require('mysql2/promise');

const dbConfig = {
  host: '127.0.0.1',
  user: 'xmp_db',
  password: 'xmpdb123#',
  database: 'xmp_db',
  port: 3306
};

async function fixActivity() {
  try {
    const connection = await mysql.createConnection(dbConfig);
    const sql = `CREATE TABLE IF NOT EXISTS activity_log (
  id int NOT NULL AUTO_INCREMENT,
  entity_type varchar(50) NOT NULL,
  entity_id int NOT NULL,
  project_id int DEFAULT NULL,
  actor_id int DEFAULT NULL,
  actor_name varchar(255) DEFAULT NULL,
  action varchar(255) NOT NULL,
  detail text,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY entity_idx (entity_type,entity_id),
  KEY proj_idx (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;`;

    await connection.query(sql);
    console.log('activity_log table created!');
    
    // Also, maybe we should run sequelize sync to ensure other missing tables are created.
    
    await connection.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

fixActivity();
