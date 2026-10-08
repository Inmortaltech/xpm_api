const mysql = require('mysql2/promise');
mysql.createConnection({host:'127.0.0.1', user:'xmp_db', password:'xmpdb123#', database:'xmp_db'}).then(async c => { 
  try { await c.query("ALTER TABLE boards ADD COLUMN item_key VARCHAR(24) DEFAULT NULL"); } catch(e){}
  try { await c.query("ALTER TABLE boards ADD COLUMN type VARCHAR(16) NOT NULL DEFAULT 'task'"); } catch(e){}
  console.log('Added missing board cols'); 
  c.end(); 
});
