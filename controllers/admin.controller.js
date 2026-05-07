const User = require("../models/admin.model");
const sequelize =require("../config/db");

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
      password,
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
		password: user.password,
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

    //  Update user
    await user.update({
      name,
      email,
      password,
      role,
      user_type,
	  mobile,
      image,
    });

    res.json({
      success: true,
      message: "User updated successfully",
      data: user,
    });

  } catch (error) {
    res.json({
      success: false,
      message: error.message,
    });
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
      project_type,
      priority,
      methodology,
      project_scope,
      company_name,
      location,
      budget,
      no_billing,
      contacts,
      milestones
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
      milestones: parseJSON(item.milestones)
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
    } = req.body;

    contacts = contacts ? JSON.parse(contacts) : [];
    milestones = milestones ? JSON.parse(milestones) : [];

    const safe = (val) => (val !== undefined && val !== "" ? val : null);

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
        milestones = :milestones
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
    } = req.body;

    const image = req.file ? req.file.filename : null;
	const is_active = "1";

    const sql = `
      INSERT INTO resources (
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
        image,
        created_at,
		is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
    `;

    const values = [
      resource_type || null,
      name || null,
      role || null,
      email || null,
      mobile || null,
      shift || null,
      salary_ctc || null,
      start_time || null,
      end_time || null,
      experience || null,
      salary_per_hours || null,
      unit_bag_kg || null,
      rate_per_unit || null,
      date || null,
      time || null,
      rate || null,
      cost || null,
      image,
	  is_active
    ];

    const [result] = await sequelize.query(sql, {
      replacements: values,
    });

    return res.status(200).json({
      success: true,
      message: "Resource created successfully",
      insertId: result.insertId,
    });

  } catch (error) {
    console.error("Create Resource Error:", error);

    return res.status(201).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

exports.getAllResources = async (req, res) => {
  try {
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
        resource_type = ?,
        name = ?,
        role = ?,
        email = ?,
        mobile = ?,
        shift = ?,
        salary_ctc = ?,
        start_time = ?,
        end_time = ?,
        experience = ?,
        salary_per_hours = ?,
        unit_bag_kg = ?,
        rate_per_unit = ?,
        \`date\` = ?,
        \`time\` = ?,
        rate = ?,
        cost = ?,
        image = COALESCE(?, image)
      WHERE id = ?
    `;

    const values = [
      resource_type || null,
      name || null,
      role || null,
      email || null,
      mobile || null,
      shift || null,
      salary_ctc || null,
      start_time || null,
      end_time || null,
      experience || null,
      salary_per_hours || null,
      unit_bag_kg || null,
      rate_per_unit || null,
      date || null,
      time || null,
      rate || null,
      cost || null,
      image,
      id,
    ];

    await sequelize.query(sql, {
      replacements: values,
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