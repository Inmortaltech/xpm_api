// config/db.js
const { Sequelize } = require('sequelize');
require('dotenv').config();

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

// Test connection
sequelize.authenticate()
  .then(() => console.log(" DB Connected"))
  .catch(err => console.log(" DB Error:", err));

module.exports = sequelize;