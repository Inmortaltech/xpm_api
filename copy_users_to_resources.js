const mysql = require('mysql2/promise');
mysql.createConnection({host:'127.0.0.1', user:'xmp_db', password:'xmpdb123#', database:'xmp_db'}).then(async c => { 
  try { 
    await c.query(`INSERT IGNORE INTO resources (name, role, email, password, user_id, resource_type, is_active) 
                   SELECT name, role, email, password, id, 'inhouse', 'enable' 
                   FROM users 
                   WHERE id NOT IN (SELECT user_id FROM resources WHERE user_id IS NOT NULL)`); 
    console.log('Copied users to resources (omitted mobile to avoid dupes)'); 
  } catch(e) {
    console.error(e.message);
  }
  c.end(); 
});
