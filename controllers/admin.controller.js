const User = require("../models/admin.model");
const sequelize =require("../config/db");
const { hashPassword } = require("../middleware/auth");

const toBool = (v) => {
  if (v === 'true' || v === true || v === 1 || v === '1' || v === 'on' || v === 'TRUE' || v === 'yes' || v === 'YES') {
    return 1;
  }
  return 0;
};

const ensureResourcesTable = async () => {
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS resources (
      id INT NOT NULL AUTO_INCREMENT,
      resource_type VARCHAR(100) DEFAULT NULL,
      name VARCHAR(255) DEFAULT NULL,
      role VARCHAR(255) DEFAULT NULL,
      email VARCHAR(255) DEFAULT NULL,
      mobile VARCHAR(20) DEFAULT NULL,
      shift VARCHAR(100) DEFAULT NULL,
      salary_ctc DECIMAL(15,2) DEFAULT NULL,
      start_time VARCHAR(50) DEFAULT NULL,
      end_time VARCHAR(50) DEFAULT NULL,
      experience VARCHAR(100) DEFAULT NULL,
      salary_per_hours DECIMAL(15,2) DEFAULT NULL,
      unit_bag_kg DECIMAL(15,2) DEFAULT NULL,
      rate_per_unit DECIMAL(15,2) DEFAULT NULL,
      \`date\` DATE DEFAULT NULL,
      \`time\` TIME DEFAULT NULL,
      rate DECIMAL(15,2) DEFAULT NULL,
      cost DECIMAL(15,2) DEFAULT NULL,
      image VARCHAR(255) DEFAULT NULL,
      monday TINYINT(1) DEFAULT 0,
      tuesday TINYINT(1) DEFAULT 0,
      wednesday TINYINT(1) DEFAULT 0,
      thursday TINYINT(1) DEFAULT 0,
      friday TINYINT(1) DEFAULT 0,
      saturday TINYINT(1) DEFAULT 0,
      sunday TINYINT(1) DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  await sequelize.query(createTableSql);

  // Ensure missing columns are added if the table already existed
  const columnsToAdd = [
    { name: 'shift', type: 'VARCHAR(100) DEFAULT NULL' },
    { name: 'monday', type: 'TINYINT(1) DEFAULT 0' },
    { name: 'tuesday', type: 'TINYINT(1) DEFAULT 0' },
    { name: 'wednesday', type: 'TINYINT(1) DEFAULT 0' },
    { name: 'thursday', type: 'TINYINT(1) DEFAULT 0' },
    { name: 'friday', type: 'TINYINT(1) DEFAULT 0' },
    { name: 'saturday', type: 'TINYINT(1) DEFAULT 0' },
    { name: 'sunday', type: 'TINYINT(1) DEFAULT 0' }
  ];

  for (const col of columnsToAdd) {
    try {
      await sequelize.query(`ALTER TABLE resources ADD COLUMN ${col.name} ${col.type}`);
      console.log(`Added missing column: ${col.name}`);
    } catch (err) {
      // Column probably already exists, ignore error
    }
  }
};

const ensureProjectsTable = async () => {
  try {
    await sequelize.query(`ALTER TABLE projects ADD COLUMN resource_allocations LONGTEXT DEFAULT NULL`);
  } catch (err) {
    // Column probably already exists
  }
};

exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role, user_type, mobile } = req.body;

    // Check duplicate email
    const existingUser = await User.findOne({ where: { email } });

    if (existingUser) {
      return res.json({
        success: false,
        message: "Email already exists",
      });
    }

    //  Get uploaded file
    const image = req.file ? req.file.filename : null;
    const status = "enable";
    const user = await User.create({
      name,
      email,
      password: password ? await hashPassword(password) : null,
      role,
      user_type,
	  status,
	  mobile,
      image
    });

    res.json({
      success: true,
      message: "User created successfully",
      user_id: user.id,
      image: image
    });
  } catch (error) {
    res.json({
      success: false,
      message: error.message,
    });
  }
};

exports.getUsers = async (req, res) => {
  try {
    const users = await User.findAll();

    const baseUrl = `${req.protocol}://${req.get("host")}/uploads`;

    const formattedUsers = users.map(user => {
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        user_type: user.user_type,
		// password intentionally NOT returned (was a plaintext leak).
		// The edit form treats a blank password field as "keep existing".
		has_password: !!user.password,
		status: user.status,
		mobile: user.mobile,
        image: user.image ? `${baseUrl}/${user.image}` : null,

        // formatted datetime
        createdAt: new Date(user.createdAt).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        })
      };
    });

    res.json({
      success: true,
      data: formattedUsers
    });

  } catch (error) {
    res.json({
      success: false,
      message: error.message
    });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id, name, email, password, role, user_type, mobile } = req.body;

    //  Check user exists
    const user = await User.findByPk(id);

    if (!user) {
      return res.json({
        success: false,
        message: "User not found",
      });
    }

    //  Check duplicate email (exclude current user)
    const existingUser = await User.findOne({
      where: {
        email,
        id: { [require("sequelize").Op.ne]: id }
      }
    });

    if (existingUser) {
      return res.json({
        success: false,
        message: "Email already exists",
      });
    }

    //  Handle image update
    const image = req.file ? req.file.filename : user.image;

    //  Update user — blank / masked password means "keep the existing one"
    const patch = { name, email, role, user_type, mobile, image };
    if (password && String(password).trim() && String(password).trim() !== "********") {
      patch.password = await hashPassword(String(password).trim());
    }
    await user.update(patch);

    const safeUser = user.toJSON ? user.toJSON() : { ...user };
    delete safeUser.password;

    res.json({
      success: true,
      message: "User updated successfully",
      data: safeUser,
    });

  } catch (error) {
    res.json({
      success: false,
      message: error.message,
    });
  }
};

// ── Self-service profile ──────────────────────────────────────────────────
//  GET  /api/admin/me              -> the signed-in user's own record
//  POST /api/admin/update_profile  -> name / mobile / image / password only
//                                     (role, status, email stay server-owned)
exports.getMe = async (req, res) => {
  try {
    const id = req.user && req.user.id;
    if (!id) return res.status(401).json({ success: false, message: "Not authenticated" });
    const user = await User.findByPk(id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const baseUrl = `${req.protocol}://${req.get("host")}/uploads`;
    return res.json({
      success: true,
      data: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        user_type: user.user_type, status: user.status, mobile: user.mobile,
        image: user.image ? `${baseUrl}/${user.image}` : null,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const id = req.user && req.user.id;
    if (!id) return res.status(401).json({ success: false, message: "Not authenticated" });
    const user = await User.findByPk(id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const { name, mobile, password } = req.body || {};
    const patch = {};
    if (name != null && String(name).trim()) patch.name = String(name).trim();
    if (mobile != null) patch.mobile = String(mobile).trim();
    if (req.file) patch.image = req.file.filename;
    if (password && String(password).trim() && String(password).trim() !== "********") {
      if (String(password).trim().length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
      }
      patch.password = await hashPassword(String(password).trim());
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update" });
    }
    await user.update(patch);

    const baseUrl = `${req.protocol}://${req.get("host")}/uploads`;
    return res.json({
      success: true,
      message: "Profile updated",
      data: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        user_type: user.user_type, status: user.status, mobile: user.mobile,
        image: user.image ? `${baseUrl}/${user.image}` : null,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateUserStatus = async (req, res) => {
  try {
    const id = Number(req.body.id);
    const { status } = req.body;

    if (!id) {
      return res.json({
        success: false,
        message: "Invalid or missing ID",
      });
    }

    const user = await User.findByPk(id);

    if (!user) {
      return res.json({
        success: false,
        message: "User not found",
      });
    }

    await user.update({ status });

    res.json({
      success: true,
      message: "Status updated successfully",
      data: { id, status },
    });

  } catch (error) {
    res.json({
      success: false,
      message: error.message,
    });
  }
};

exports.createProject = async (req, res) => {
  try {
    const year = new Date().getFullYear();

    // Get last project code
    const [result] = await sequelize.query(`
      SELECT project_code 
      FROM project_code 
      WHERE project_code LIKE 'P-${year}%'
      ORDER BY id DESC 
      LIMIT 1
    `);

    let newCode;

    if (result.length > 0) {
      let lastCode = result[0].project_code;

      let lastNumber = parseInt(lastCode.slice(-3));
      let nextNumber = lastNumber + 1;

      newCode = `P-${year}${nextNumber.toString().padStart(3, "0")}`;
    } else {
      newCode = `P-${year}001`;
    }

    // Insert new project code
    await sequelize.query(
      `INSERT INTO project_code (project_code) VALUES (:project_code)`,
      {
        replacements: { project_code: newCode },
      }
    );

    return res.status(201).json({
      success: true,
      project_code: newCode,
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Error creating project code",
    });
  }
};


exports.addProject = async (req, res) => {
  const t = await sequelize.transaction();
  await ensureProjectsTable();

  try {
    const files = req.files; // multiple files

    let {
      project_code,
      project_name,
      contact_sign_date,
      start_date,
      end_date,
      duration,
      project_manager,
      technical_lead,
      technology,
      project_type,
      priority,
      methodology,
      project_scope,
      company_name,
      location,
      budget,
      no_billing,
      contacts,
      milestones,
      resource_allocations
    } = req.body;

    const status = "Allocated";

    //  Safe JSON parse
    const parseJSON = (val) => {
      try {
        return val ? JSON.parse(val) : null;
      } catch {
        return null;
      }
    };

    contacts = parseJSON(contacts);
    milestones = parseJSON(milestones);
    resource_allocations = parseJSON(resource_allocations);

    // multipart forms can send the literal string "null"/"undefined" — normalise
    const clean = (v, dflt = null) =>
      v == null || v === "" || v === "null" || v === "undefined" ? dflt : v;
    priority = clean(priority, "Medium");
    methodology = clean(methodology);
    project_type = clean(project_type);
    project_scope = clean(project_scope);
    company_name = clean(company_name);
    location = clean(location);
    technology = clean(technology);
    technical_lead = clean(technical_lead);
    project_manager = clean(project_manager);

    // =========================
    // BUILD DATA OBJECT
    // =========================
    let data = {
      project_code,
      project_name,
      contact_sign_date,
      start_date,
      end_date,
      duration,
      project_manager,
      technical_lead,
      technology,
      project_type,
      priority,
      methodology,
      project_scope,
      company_name,
      location,
      budget,
      no_billing,
      status
    };

    // =========================
    // FILE HANDLING 
    // =========================
    if (files && files.upload_personal_document) {
      data.upload_personal_document =
        files.upload_personal_document[0].filename;
    }

    if (files && files.company_logo) {
      data.company_logo = files.company_logo[0].filename;
    }

    // =========================
    // JSON FIELDS
    // =========================
    if (contacts) {
      data.contacts = JSON.stringify(contacts);
    }

    if (milestones) {
      data.milestones = JSON.stringify(milestones);
    }

    if (resource_allocations) {
      data.resource_allocations = JSON.stringify(resource_allocations);
    }

    // =========================
    // REMOVE EMPTY FIELDS
    // =========================
    Object.keys(data).forEach((key) => {
      if (
        data[key] === undefined ||
        data[key] === null ||
        data[key] === ""
      ) {
        delete data[key];
      }
    });

    // =========================
    // DYNAMIC QUERY
    // =========================
    const columns = Object.keys(data).join(", ");
    const values = Object.keys(data)
      .map((key) => `:${key}`)
      .join(", ");

    const query = `
      INSERT INTO projects (${columns})
      VALUES (${values})
    `;

    const [result] = await sequelize.query(query, {
      replacements: data,
      transaction: t
    });

    await t.commit();

    return res.status(200).json({
      success: true,
      project_id: result.insertId
    });

  } catch (error) {
    await t.rollback();
    console.error(error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
exports.getProjectList = async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT * FROM projects ORDER BY id DESC`
    );

    const parseJSON = (val) => {
      try {
        return typeof val === "string" ? JSON.parse(val) : val;
      } catch (e) {
        return [];
      }
    };

    const data = rows.map((item) => ({
      ...item,
      contacts: parseJSON(item.contacts),
      milestones: parseJSON(item.milestones),
      resource_allocations: parseJSON(item.resource_allocations)
    }));

    return res.status(200).json({
      success: true,
      count: data.length,
      data
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.getAllProjects = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const replacements = {};
    const whereClauses = [];

    if (search) {
      replacements.search = `%${search}%`;
      whereClauses.push(
        `(p.project_name LIKE :search OR p.project_code LIKE :search OR p.company_name LIKE :search OR p.project_manager LIKE :search)`
      );
    }

    if (status) {
      replacements.status = status;
      whereClauses.push(`p.status = :status`);
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const [rows] = await sequelize.query(
      `
      SELECT
        p.id,
        p.project_code,
        p.project_name,
        p.budget,
        p.priority,
        p.duration,
        p.start_date,
        p.end_date,
        p.company_name,
        p.project_manager,
        p.status
      FROM projects p
      ${whereSql}
      ORDER BY p.id DESC
      `,
      { replacements }
    );

    const data = rows.map((project) => ({
      id: project.id,
      projectCode: project.project_code || "",
      projectName: project.project_name || "-",
      budget: project.budget ?? "-",
      cost: project.budget ?? "-",
      priority: project.priority || "-",
      schedule: project.duration ? `${project.duration} days` : "-",
      plannedStartDate: project.start_date || "-",
      deadline: project.end_date || "-",
      clientName: project.company_name || "-",
      pm: project.project_manager || "-",
      status: project.status || "Pending",
    }));

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("Get All Projects Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

exports.updateProject = async (req, res) => {
  const t = await sequelize.transaction();

  try {
    console.log("FILES:", req.files);
    console.log("BODY:", req.body);

    // =========================
    // FILE HANDLING
    // =========================
    let documentFile = null;
    let logoFile = null;

    if (req.files) {
      if (req.files.upload_personal_document) {
        documentFile = req.files.upload_personal_document[0].filename;
      }

      if (req.files.company_logo) {
        logoFile = req.files.company_logo[0].filename;
      }
    }

    // =========================
    // BODY DATA
    // =========================
    let {
      project_id,
      project_name,
      contact_sign_date,
      start_date,
      end_date,
      duration,
      project_manager,
      technical_lead,
      technology,
      project_type,
      priority,
      methodology,
      project_scope,
      company_name,
      location,
      budget,
      no_billing,
      status,
      contacts,
      milestones,
      resource_allocations,
    } = req.body;

    contacts = contacts ? JSON.parse(contacts) : [];
    milestones = milestones ? JSON.parse(milestones) : [];
    resource_allocations = resource_allocations ? JSON.parse(resource_allocations) : [];

    // treat the literal strings "null"/"undefined" (multipart form artefacts) as empty
    const safe = (val) =>
      val !== undefined && val !== "" && val !== "null" && val !== "undefined" ? val : null;

    // =========================
    // VALIDATION
    // =========================
    if (!project_id) {
      return res.status(400).json({
        success: false,
        message: "project_id is required",
      });
    }

    // =========================
    // GET OLD FILES
    // =========================
    const [oldData] = await sequelize.query(
      `SELECT upload_personal_document, company_logo 
       FROM projects WHERE id = :id`,
      {
        replacements: { id: project_id },
        transaction: t,
      }
    );

    if (oldData.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Project not found",
      });
    }

    // Keep old files if new not uploaded
    let finalDocument =
      documentFile || oldData[0].upload_personal_document;

    let finalLogo =
      logoFile || oldData[0].company_logo;

    // =========================
    // UPDATE QUERY
    // =========================
    await sequelize.query(
      `UPDATE projects SET
        project_name = :project_name,
        contact_sign_date = :contact_sign_date,
        start_date = :start_date,
        end_date = :end_date,
        duration = :duration,
        project_manager = :project_manager,
        technical_lead = :technical_lead,
        technology = :technology,
        project_type = :project_type,
        priority = :priority,
        methodology = :methodology,
        project_scope = :project_scope,
        upload_personal_document = :upload_personal_document,
        company_logo = :company_logo,
        company_name = :company_name,
        location = :location,
        budget = :budget,
        no_billing = :no_billing,
        status = :status,
        contacts = :contacts,
        milestones = :milestones,
        resource_allocations = :resource_allocations
      WHERE id = :id`,
      {
        replacements: {
          id: project_id,
          project_name: safe(project_name),
          contact_sign_date: safe(contact_sign_date),
          start_date: safe(start_date),
          end_date: safe(end_date),
          duration: safe(duration),
          project_manager: safe(project_manager),
          technical_lead: safe(technical_lead),
          technology: safe(technology),
          project_type: safe(project_type),
          priority: safe(priority),
          methodology: safe(methodology),
          project_scope: safe(project_scope),
          upload_personal_document: finalDocument,
          company_logo: finalLogo,
          company_name: safe(company_name),
          location: safe(location),
          budget: safe(budget),
          no_billing: safe(no_billing),
          status: safe(status),
          contacts: JSON.stringify(contacts),
          milestones: JSON.stringify(milestones),
          resource_allocations: JSON.stringify(resource_allocations),
        },
        transaction: t,
      }
    );

    await t.commit();

    return res.status(200).json({
      success: true,
      message: "Project updated successfully",
    });

  } catch (error) {
    await t.rollback();
    console.error(error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};



exports.createResource = async (req, res) => {
  try {
    await ensureResourcesTable();

    console.log("Create Resource Body:", req.body);
    const {
      resource_type,
      name,
      role,
      email,
      mobile,
      shift,
      salary_ctc,
      start_time,
      end_time,
      experience,
      salary_per_hours,
      unit_bag_kg,
      rate_per_unit,
      date,
      time,
      rate,
      cost,
      monday,
      tuesday,
      wednesday,
      thursday,
      friday,
      saturday,
      sunday,
    } = req.body;

    const image = req.file ? req.file.filename : null;
    const is_active = 1;

    // Celoxis resource economics — added by db_bkp/xmp_db_celoxis_polish.sql
    const { cost_rate, bill_rate, capacity_hours } = req.body;
    try {
      await sequelize.query(`ALTER TABLE resources ADD COLUMN cost_rate DECIMAL(10,2) DEFAULT NULL`);
    } catch (e) { /* exists */ }
    try {
      await sequelize.query(`ALTER TABLE resources ADD COLUMN bill_rate DECIMAL(10,2) DEFAULT NULL`);
    } catch (e) { /* exists */ }
    try {
      await sequelize.query(`ALTER TABLE resources ADD COLUMN capacity_hours DECIMAL(4,1) DEFAULT 8`);
    } catch (e) { /* exists */ }

    const sql = `
      INSERT INTO resources (
        resource_type, name, role, email, mobile, shift, salary_ctc,
        start_time, end_time, experience, salary_per_hours, unit_bag_kg,
        rate_per_unit, \`date\`, \`time\`, rate, cost, image,
        cost_rate, bill_rate, capacity_hours,
        monday, tuesday, wednesday, thursday, friday, saturday, sunday,
        created_at, is_active
      ) VALUES (
        :resource_type, :name, :role, :email, :mobile, :shift, :salary_ctc,
        :start_time, :end_time, :experience, :salary_per_hours, :unit_bag_kg,
        :rate_per_unit, :date, :time, :rate, :cost, :image,
        :cost_rate, :bill_rate, :capacity_hours,
        :monday, :tuesday, :wednesday, :thursday, :friday, :saturday, :sunday,
        NOW(), :is_active
      )
    `;

    const replacements = {
      resource_type: resource_type || null,
      name: name || null,
      role: role || null,
      email: email || null,
      mobile: mobile || null,
      shift: shift || null,
      salary_ctc: salary_ctc || null,
      start_time: start_time || null,
      end_time: end_time || null,
      experience: experience || null,
      salary_per_hours: salary_per_hours || null,
      unit_bag_kg: unit_bag_kg || null,
      rate_per_unit: rate_per_unit || null,
      date: date || null,
      time: time || null,
      rate: rate || null,
      cost: cost || null,
      image: image,
      cost_rate: cost_rate || null,
      bill_rate: bill_rate || null,
      capacity_hours: capacity_hours || 8,
      monday: toBool(monday),
      tuesday: toBool(tuesday),
      wednesday: toBool(wednesday),
      thursday: toBool(thursday),
      friday: toBool(friday),
      saturday: toBool(saturday),
      sunday: toBool(sunday),
      is_active: is_active
    };

    console.log("Create Resource Replacements:", replacements);

    const [result] = await sequelize.query(sql, {
      replacements: replacements,
      type: sequelize.QueryTypes.INSERT
    });

    const insertId = result; // result is usually the insertId for INSERT queries in MySQL

    return res.status(200).json({
      success: true,
      message: "Resource created successfully",
      id: insertId,
    });

  } catch (error) {
    console.error("Create Resource Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

exports.getAllResources = async (req, res) => {
  try {
    await ensureResourcesTable();

    const sql = `
      SELECT * 
      FROM resources 
      ORDER BY id DESC
    `;

    const [rows] = await sequelize.query(sql);

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });

  } catch (error) {
    console.error("Get Resources Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

exports.updateResource = async (req, res) => {
  try {
    await ensureResourcesTable();

    const {
      id,
      resource_type,
      name,
      role,
      email,
      mobile,
      shift,
      salary_ctc,
      start_time,
      end_time,
      experience,
      salary_per_hours,
      unit_bag_kg,
      rate_per_unit,
      date,
      time,
      rate,
      cost,
      monday,
      tuesday,
      wednesday,
      thursday,
      friday,
      saturday,
      sunday,
    } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID is required",
      });
    }

    const image = req.file ? req.file.filename : null;

    const sql = `
      UPDATE resources SET
        resource_type = :resource_type,
        name = :name,
        role = :role,
        email = :email,
        mobile = :mobile,
        shift = :shift,
        salary_ctc = :salary_ctc,
        start_time = :start_time,
        end_time = :end_time,
        experience = :experience,
        salary_per_hours = :salary_per_hours,
        unit_bag_kg = :unit_bag_kg,
        rate_per_unit = :rate_per_unit,
        \`date\` = :date,
        \`time\` = :time,
        rate = :rate,
        cost = :cost,
        cost_rate = :cost_rate,
        bill_rate = :bill_rate,
        capacity_hours = :capacity_hours,
        image = COALESCE(:image, image),
        monday = :monday,
        tuesday = :tuesday,
        wednesday = :wednesday,
        thursday = :thursday,
        friday = :friday,
        saturday = :saturday,
        sunday = :sunday
      WHERE id = :id
    `;

    const replacements = {
      id: id,
      cost_rate: req.body.cost_rate || null,
      bill_rate: req.body.bill_rate || null,
      capacity_hours: req.body.capacity_hours || 8,
      resource_type: resource_type || null,
      name: name || null,
      role: role || null,
      email: email || null,
      mobile: mobile || null,
      shift: shift || null,
      salary_ctc: salary_ctc || null,
      start_time: start_time || null,
      end_time: end_time || null,
      experience: experience || null,
      salary_per_hours: salary_per_hours || null,
      unit_bag_kg: unit_bag_kg || null,
      rate_per_unit: rate_per_unit || null,
      date: date || null,
      time: time || null,
      rate: rate || null,
      cost: cost || null,
      image: image,
      monday: toBool(monday),
      tuesday: toBool(tuesday),
      wednesday: toBool(wednesday),
      thursday: toBool(thursday),
      friday: toBool(friday),
      saturday: toBool(saturday),
      sunday: toBool(sunday)
    };

    console.log("Update Resource Replacements:", replacements);

    await sequelize.query(sql, {
      replacements: replacements,
      type: sequelize.QueryTypes.UPDATE
    });

    return res.status(200).json({
      success: true,
      message: "Resource updated successfully",
    });

  } catch (error) {
    console.error("Update Error:", error);

    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

exports.deactivateResource = async (req, res) => {
  try {
    const { id, is_active } = req.body;
    
    if (!id) {
      return res.status(400).json({ success: false, message: "ID is required" });
    }

    await sequelize.query(
      "UPDATE resources SET is_active = :is_active WHERE id = :id",
      { replacements: { is_active, id } }
    );

    res.json({ success: true, message: "Resource status updated" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Ensure Holidays Table ────────────────────────────────────────────────────
const ensureHolidaysTable = async () => {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS \`holidays\` (
      \`id\`           INT          NOT NULL AUTO_INCREMENT,
      \`holiday_date\` DATE         NOT NULL,
      \`title\`        VARCHAR(255) NOT NULL,
      \`description\`  TEXT         DEFAULT NULL,
      \`is_active\`    TINYINT(1)   NOT NULL DEFAULT 1,
      \`created_at\`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\`   DATETIME         NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_holiday_date\` (\`holiday_date\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
};

// GET /admin/holidays – list all active holidays
exports.getHolidays = async (req, res) => {
  try {
    await ensureHolidaysTable();
    const [rows] = await sequelize.query(
      `SELECT id, holiday_date, title, description, is_active
       FROM holidays
       WHERE is_active = 1
       ORDER BY holiday_date ASC`
    );
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Get Holidays Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /admin/add_holiday – add a new holiday
exports.addHoliday = async (req, res) => {
  try {
    await ensureHolidaysTable();
    const { holiday_date, title, description } = req.body;
    if (!holiday_date || !title) {
      return res.status(400).json({ success: false, message: "holiday_date and title are required" });
    }

    // Pre-check for duplicate holiday dates to avoid DB constraint unique key errors (500)
    const existing = await sequelize.query(
      `SELECT id, is_active FROM holidays WHERE holiday_date = :holiday_date LIMIT 1`,
      { replacements: { holiday_date }, type: sequelize.QueryTypes.SELECT }
    );

    if (existing && existing.length > 0) {
      const row = existing[0];
      const isActiveVal = row.is_active instanceof Buffer ? row.is_active[0] : row.is_active;
      if (parseInt(isActiveVal) === 1) {
        return res.status(400).json({ success: false, message: "A holiday already exists on this date." });
      } else {
        // Reactivate soft-deleted holiday
        await sequelize.query(
          `UPDATE holidays SET title = :title, description = :description, is_active = 1 WHERE id = :id`,
          { replacements: { id: row.id, title, description: description || null } }
        );
        return res.status(200).json({ success: true, message: "Holiday added (reactivated) successfully" });
      }
    }

    await sequelize.query(
      `INSERT INTO holidays (holiday_date, title, description)
       VALUES (:holiday_date, :title, :description)`,
      { replacements: { holiday_date, title, description: description || null } }
    );
    return res.status(201).json({ success: true, message: "Holiday added successfully" });
  } catch (error) {
    console.error("Add Holiday Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /admin/update_holiday – update an existing holiday
exports.updateHoliday = async (req, res) => {
  try {
    await ensureHolidaysTable();
    const { id, holiday_date, title, description, is_active } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    await sequelize.query(
      `UPDATE holidays SET
        holiday_date = :holiday_date,
        title        = :title,
        description  = :description,
        is_active    = :is_active
       WHERE id = :id`,
      {
        replacements: {
          id, holiday_date, title,
          description: description || null,
          is_active: is_active !== undefined ? (is_active ? 1 : 0) : 1,
        }
      }
    );
    return res.status(200).json({ success: true, message: "Holiday updated successfully" });
  } catch (error) {
    console.error("Update Holiday Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /admin/delete_holiday – soft-delete (deactivate) a holiday
exports.deleteHoliday = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "id is required" });
    await sequelize.query(
      `UPDATE holidays SET is_active = 0 WHERE id = :id`,
      { replacements: { id } }
    );
    return res.status(200).json({ success: true, message: "Holiday deleted successfully" });
  } catch (error) {
    console.error("Delete Holiday Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /admin/check_holidays?start_date=YYYY-MM-DD&duration=N&exclude_weekends=0|1
// Returns the calculated end_date (skipping holidays + optionally weekends)
// and the list of holidays encountered in that range.
exports.checkHolidays = async (req, res) => {
  try {
    await ensureHolidaysTable();

    const { start_date, duration, exclude_weekends } = req.query;
    if (!start_date || !duration) {
      return res.status(400).json({ success: false, message: "start_date and duration are required" });
    }

    const n = parseInt(duration);
    const excludeWeekends = exclude_weekends === "1" || exclude_weekends === "true";

    if (isNaN(n) || n <= 0) {
      return res.status(400).json({ success: false, message: "duration must be a positive integer" });
    }

    // ── Helper: parse "YYYY-MM-DD" as LOCAL date (avoid UTC midnight shift) ──
    const parseLocalDate = (str) => {
      const [y, m, d] = str.split("-").map(Number);
      return new Date(y, m - 1, d); // local midnight
    };

    // ── Helper: format a local Date to "YYYY-MM-DD" ──
    const toLocalKey = (date) => {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    };

    // Fetch all active holidays
    const [holidayRows] = await sequelize.query(
      `SELECT holiday_date, title FROM holidays WHERE is_active = 1`
    );

    // Build a Set of holiday date strings "YYYY-MM-DD"
    const holidaySet = new Set();
    const holidayMap = {};

    holidayRows.forEach(row => {
      // MySQL returns DATE as a JS Date object (UTC midnight) — use toLocalKey safely
      const d = new Date(row.holiday_date);
      // Extract MM-DD from the UTC date (DATE columns don't have time, so UTC is fine here)
      const month = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day   = String(d.getUTCDate()).padStart(2, "0");
      const year  = d.getUTCFullYear();

      const key = `${year}-${month}-${day}`;
      holidaySet.add(key);
      holidayMap[key] = row.title;
    });

    // Walk forward day-by-day using LOCAL dates
    let cursor = parseLocalDate(start_date);
    let added = 0;
    const skippedHolidays = [];

    while (added < n) {
      cursor.setDate(cursor.getDate() + 1);
      const dayOfWeek = cursor.getDay(); // 0=Sun, 6=Sat
      const key = toLocalKey(cursor);

      // Skip weekends if requested
      if (excludeWeekends && (dayOfWeek === 0 || dayOfWeek === 6)) continue;

      // Skip holidays
      if (holidaySet.has(key)) {
        skippedHolidays.push({ date: key, title: holidayMap[key] });
        continue;
      }

      added++;
    }

    const endDate = toLocalKey(cursor);

    return res.status(200).json({
      success: true,
      start_date,
      duration: n,
      end_date: endDate,
      holidays_skipped: skippedHolidays,
      holidays_found: skippedHolidays.length > 0,
    });

  } catch (error) {
    console.error("Check Holidays Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  POST /api/admin/re-allocated       (FormData or JSON)
//  body: { id | project_id, pm_id, project_manager, status }
//  PMO se project ko naye PM ko re-allocate karna (CreateProjectPage.jsx).
//  Naya PM = 'Pending' acceptance, status = 're-allocated', history me entry.
// =============================================================================
exports.reallocateProject = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    // ensure history + pm columns exist
    const projectCols = [
      ["project_manager_id", "INT DEFAULT NULL"],
      ["request_status", "VARCHAR(30) DEFAULT NULL"],
      ["decline_reason", "TEXT DEFAULT NULL"],
      ["pm_responded_at", "DATETIME DEFAULT NULL"],
      ["assigned_at", "DATETIME DEFAULT NULL"],
    ];
    for (const [name, ddl] of projectCols) {
      try { await sequelize.query(`ALTER TABLE projects ADD COLUMN ${name} ${ddl}`); } catch (e) { /* exists */ }
    }
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS project_pm_history (
        id INT NOT NULL AUTO_INCREMENT,
        project_id INT NOT NULL,
        project_name VARCHAR(255) DEFAULT NULL,
        action VARCHAR(30) NOT NULL,
        pm_id INT DEFAULT NULL,
        pm_name VARCHAR(150) DEFAULT NULL,
        previous_pm_id INT DEFAULT NULL,
        previous_pm_name VARCHAR(150) DEFAULT NULL,
        reassigned_to_id INT DEFAULT NULL,
        reassigned_to_name VARCHAR(150) DEFAULT NULL,
        reason TEXT DEFAULT NULL,
        performed_by INT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_pmhist_project (project_id),
        KEY idx_pmhist_action (action)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const projectId = Number(req.body.project_id || req.body.id);
    if (!projectId) {
      await t.rollback();
      return res.status(400).json({ success: false, message: "project id is required" });
    }

    // "Ashu (Freelancer)" -> "Ashu"
    const cleanName = String(req.body.project_manager || "")
      .replace(/\s*\((In-house|Freelancer)\)\s*$/i, "")
      .trim() || null;

    // FE galti se pm_id = projectId bhejta hai — naam se resolve karo
    let pmId = Number(req.body.pm_id) || null;
    if ((!pmId || pmId === projectId) && cleanName) {
      const u = await sequelize.query(
        `SELECT id FROM users WHERE name = :n AND LOWER(role) = 'project manager' LIMIT 1`,
        { replacements: { n: cleanName }, type: sequelize.QueryTypes.SELECT, transaction: t }
      );
      pmId = u[0]?.id || null;
    }

    const existing = await sequelize.query(
      `SELECT id, project_name, project_manager, project_manager_id FROM projects WHERE id = :id LIMIT 1`,
      { replacements: { id: projectId }, type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    if (existing.length === 0) {
      await t.rollback();
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    const prev = existing[0];

    await sequelize.query(
      `
      UPDATE projects SET
        project_manager    = :pmName,
        project_manager_id = :pmId,
        status             = :status,
        request_status     = 'Pending',
        decline_reason     = NULL,
        pm_responded_at    = NULL,
        assigned_at        = NOW()
      WHERE id = :id
      `,
      {
        replacements: {
          id: projectId,
          pmName: cleanName,
          pmId,
          status: req.body.status || "re-allocated",
        },
        transaction: t,
      }
    );

    await sequelize.query(
      `
      INSERT INTO project_pm_history
        (project_id, project_name, action, pm_id, pm_name, previous_pm_id, previous_pm_name,
         reassigned_to_id, reassigned_to_name, reason, performed_by)
      VALUES
        (:project_id, :project_name, 're-allocated', :pm_id, :pm_name, :prev_id, :prev_name,
         :pm_id, :pm_name, :reason, :performed_by)
      `,
      {
        replacements: {
          project_id: projectId,
          project_name: prev.project_name,
          pm_id: pmId,
          pm_name: cleanName,
          prev_id: prev.project_manager_id,
          prev_name: prev.project_manager,
          reason: req.body.reason || "Re-allocated by PMO",
          performed_by: pmId,
        },
        transaction: t,
      }
    );

    await t.commit();
    return res.status(200).json({
      success: true,
      message: "Project re-allocated successfully",
      data: { project_id: projectId, project_manager: cleanName, status: req.body.status || "re-allocated" },
    });
  } catch (error) {
    await t.rollback();
    console.error("reallocateProject error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};