const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const dbConfig = {
  host: '127.0.0.1',
  user: 'xmp_db',
  password: 'xmpdb123#',
  database: 'xmp_db',
  port: 3306
};

async function seed() {
  try {
    const connection = await mysql.createConnection(dbConfig);
    const hashedPassword = await bcrypt.hash('123456', 10);
    
    // Check if user exists
    const [rows] = await connection.execute('SELECT * FROM users WHERE email = ?', ['ashu@gmail.com']);
    
    if (rows.length === 0) {
      await connection.execute(
        'INSERT INTO users (name, email, password, role, user_type, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())',
        ['Ashutosh Narayan', 'ashu@gmail.com', hashedPassword, 'Project Manager', 'internal', 'active']
      );
      console.log('User ashu@gmail.com seeded successfully!');
    } else {
      await connection.execute(
        'UPDATE users SET password = ? WHERE email = ?',
        [hashedPassword, 'ashu@gmail.com']
      );
      console.log('User ashu@gmail.com already exists. Password updated.');
    }
    
    await connection.end();
  } catch (err) {
    console.error('Database error:', err.message);
  }
}

seed();
