const mysql = require('mysql2/promise');

const dbConfig = {
  host: '127.0.0.1',
  user: 'xmp_db',
  password: 'xmpdb123#',
  database: 'xmp_db',
  port: 3306
};

async function seedWorkload() {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log('Connected to MySQL xmp_db');

    // 1. Seed Projects from Figma
    const figmaProjects = [
      { name: 'Website Redesign', priority: 'High', methodology: 'Predictive', start: '2024-03-27', progress: 35 },
      { name: 'Mobile App Development', priority: 'Medium', methodology: 'Agile', start: '2024-04-01', progress: 50 },
      { name: 'ERP System', priority: 'High', methodology: 'Predictive', start: '2024-02-15', progress: 60 },
      { name: 'API Integration', priority: 'Medium', methodology: 'Agile', start: '2024-03-01', progress: 40 },
      { name: 'CRM Development', priority: 'High', methodology: 'Predictive', start: '2024-03-10', progress: 45 },
      { name: 'Database Migration', priority: 'High', methodology: 'Predictive', start: '2024-03-15', progress: 70 },
      { name: 'Inventory Module', priority: 'Medium', methodology: 'Agile', start: '2024-04-10', progress: 25 },
      { name: 'Reporting Module', priority: 'Low', methodology: 'Agile', start: '2024-04-15', progress: 30 },
      { name: 'Security & Compliance', priority: 'High', methodology: 'Predictive', start: '2024-01-20', progress: 80 }
    ];

    const projectMap = {};
    for (const p of figmaProjects) {
      const [existing] = await connection.execute('SELECT id FROM projects WHERE project_name = ?', [p.name]);
      if (existing.length > 0) {
        projectMap[p.name] = existing[0].id;
        await connection.execute(
          'UPDATE projects SET priority = ?, methodology = ?, start_date = ?, progress_pct = ? WHERE id = ?',
          [p.priority, p.methodology, p.start, p.progress, existing[0].id]
        );
      } else {
        const [res] = await connection.execute(
          'INSERT INTO projects (project_name, priority, methodology, start_date, progress_pct, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, "In Progress", NOW(), NOW())',
          [p.name, p.priority, p.methodology, p.start, p.progress]
        );
        projectMap[p.name] = res.insertId;
      }
    }
    console.log('Projects seeded:', projectMap);

    // 2. Seed Resources from Figma
    const figmaResources = [
      { name: 'Dianne Russell', role: 'UI/UX Designer', email: 'dianne.russell@example.com', cap: 8, avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80' },
      { name: 'Brooklyn Simmons', role: 'Frontend Developer', email: 'brooklyn.simmons@example.com', cap: 8, avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80' },
      { name: 'Cody Fisher', role: 'Backend Developer', email: 'cody.fisher@example.com', cap: 8, avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80' },
      { name: 'Jacob Allen', role: 'Full Stack Developer', email: 'jacob.allen@example.com', cap: 8, avatar: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&auto=format&fit=crop&q=80' },
      { name: 'Marvin Hughes', role: 'DevOps Engineer', email: 'marvin.hughes@example.com', cap: 8, avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&auto=format&fit=crop&q=80' }
    ];

    const resourceMap = {};
    for (const r of figmaResources) {
      const [existing] = await connection.execute('SELECT id FROM resources WHERE name = ?', [r.name]);
      if (existing.length > 0) {
        resourceMap[r.name] = existing[0].id;
        await connection.execute(
          'UPDATE resources SET role = ?, capacity_hours = ?, image = ?, is_active = 1 WHERE id = ?',
          [r.role, r.cap, r.avatar, existing[0].id]
        );
      } else {
        const [res] = await connection.execute(
          'INSERT INTO resources (name, role, email, capacity_hours, image, is_active, monday, tuesday, wednesday, thursday, friday, saturday, sunday, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, 1, 1, 1, 1, 0, 0, NOW())',
          [r.name, r.role, r.email, r.cap, r.avatar]
        );
        resourceMap[r.name] = res.insertId;
      }
    }
    console.log('Resources seeded:', resourceMap);

    // 3. Seed Scheduled Tasks linking Resources to Projects
    const scheduleAssignments = [
      // Dianne Russell
      { res: 'Dianne Russell', proj: 'Website Redesign', task: 'Design System & UI Components', start: '2024-05-15', end: '2024-06-25', hours: 140, alloc: 60 },
      { res: 'Dianne Russell', proj: 'Mobile App Development', task: 'Mobile Wireframes & User Flows', start: '2024-05-15', end: '2024-06-25', hours: 70, alloc: 40 },
      // Brooklyn Simmons
      { res: 'Brooklyn Simmons', proj: 'ERP System', task: 'ERP Dashboard Interface', start: '2024-05-15', end: '2024-06-25', hours: 120, alloc: 60 },
      { res: 'Brooklyn Simmons', proj: 'API Integration', task: 'REST API Frontend Integration', start: '2024-05-15', end: '2024-06-25', hours: 80, alloc: 40 },
      // Cody Fisher
      { res: 'Cody Fisher', proj: 'CRM Development', task: 'CRM Lead Pipeline Backend', start: '2024-05-15', end: '2024-06-25', hours: 100, alloc: 50 },
      { res: 'Cody Fisher', proj: 'Database Migration', task: 'PostgreSQL to MySQL Schema Sync', start: '2024-05-15', end: '2024-06-25', hours: 100, alloc: 50 },
      // Jacob Allen
      { res: 'Jacob Allen', proj: 'Inventory Module', task: 'Stock Tracking Architecture', start: '2024-05-15', end: '2024-06-25', hours: 80, alloc: 50 },
      { res: 'Jacob Allen', proj: 'Reporting Module', task: 'Analytics & Export Reports', start: '2024-05-15', end: '2024-06-25', hours: 80, alloc: 50 },
      // Marvin Hughes
      { res: 'Marvin Hughes', proj: 'Security & Compliance', task: 'CI/CD Pipeline & Security Hardening', start: '2024-05-15', end: '2024-06-25', hours: 220, alloc: 120 }
    ];

    for (const s of scheduleAssignments) {
      const resId = resourceMap[s.res];
      const projId = projectMap[s.proj];
      if (!resId || !projId) continue;

      const [existing] = await connection.execute(
        'SELECT id FROM project_schedule WHERE project_id = ? AND resource_id = ? AND task_name = ?',
        [projId, resId, s.task]
      );

      if (existing.length === 0) {
        await connection.execute(
          `INSERT INTO project_schedule 
            (project_id, resource_id, task_name, planned_start, planned_end, planned_hours, allocation_pct, is_active, created_at, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
          [projId, resId, s.task, s.start, s.end, s.hours, s.alloc]
        );
      } else {
        await connection.execute(
          `UPDATE project_schedule 
           SET planned_start = ?, planned_end = ?, planned_hours = ?, allocation_pct = ?, is_active = 1, updated_at = NOW() 
           WHERE id = ?`,
          [s.start, s.end, s.hours, s.alloc, existing[0].id]
        );
      }
    }

    console.log('Workload seed completed successfully!');
  } catch (err) {
    console.error('Workload seed error:', err);
  } finally {
    if (connection) await connection.end();
  }
}

seedWorkload();
