const fetch = require('node-fetch'); // node-fetch might not be globally available, use http
const http = require('http');

http.get('http://localhost:5051/api/admin/resource_list', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Response:', data.substring(0, 500)));
}).on('error', err => console.log('Error:', err.message));
