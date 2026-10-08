require('dotenv').config();
const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    port: process.env.DB_PORT,
    logging: false
  }
);

(async () => {
  try {
    await sequelize.query('DROP TABLE IF EXISTS board_status;');
    await sequelize.query(`
      CREATE TABLE board_status (
        id INT AUTO_INCREMENT PRIMARY KEY, 
        project_id INT NULL, 
        status_name VARCHAR(100), 
        status_key VARCHAR(100), 
        sort_order INT DEFAULT 0, 
        wip_limit INT DEFAULT NULL, 
        is_default TINYINT(1) DEFAULT 0, 
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await sequelize.query(`
      INSERT INTO board_status (status_name, status_key, sort_order, is_default) 
      VALUES 
        ('To Do', 'to_do', 1, 1), 
        ('In Progress', 'in_progress', 2, 1), 
        ('Done', 'done', 3, 1)
    `);
    console.log('board_status fixed');
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
})();
