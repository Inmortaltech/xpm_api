// =============================================================================
//  PMO CONTROLLER
//  Pages: PMOReviewPage, ResourceChangeRequests(List/Queue/Detail), CreateProjectPage
//
//  Endpoints:
//    POST /api/admin/getProjectsStatus                  { pmo_id } | { pm_id }
//    POST /api/projectManager/scheduleStatusByPm        PM/PMO shape (see below)
//    GET  /api/admin/resource_change_requests
//    GET  /api/admin/resource_change_request_detail     ?id=RCR-xxxx
//    POST /api/admin/approve_resource_change            { id, notes }
//    POST /api/admin/reject_resource_change             { id, reason }
//    POST /api/admin/clarify_resource_change            { id, query }
//    POST /api/projectManager/create_resource_change_request   { ...payload }
// =============================================================================

const sequelize = require("../config/db");
const { logActivity } = require("./_activity");

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const nowStamp = () => {
  const d = new Date();
  return (
    d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) +
    ", " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
};
const parseJSON = (v, fb) => {
  if (v == null) return fb;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fb;
  }
};

let ready = false;
const ensureSchema = async () => {
  if (ready) return;
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS project_status (
      id INT NOT NULL AUTO_INCREMENT,
      project_id INT NOT NULL,
      pm_id INT DEFAULT NULL,
      pmo_id INT DEFAULT NULL,
      pm_status VARCHAR(30) NOT NULL DEFAULT 'draft',
      pmo_status VARCHAR(30) NOT NULL DEFAULT 'pending',
      reason TEXT DEFAULT NULL,
      schedule_data LONGTEXT DEFAULT NULL,
      pm_updated_at DATETIME DEFAULT NULL,
      pmo_updated_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_project_status (project_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS resource_change_requests (
      id INT NOT NULL AUTO_INCREMENT,
      request_code VARCHAR(40) NOT NULL,
      project_id VARCHAR(50) DEFAULT NULL,
      project_name VARCHAR(255) DEFAULT NULL,
      pm_id INT DEFAULT NULL,
      project_manager VARCHAR(150) DEFAULT NULL,
      priority VARCHAR(20) DEFAULT 'High',
      department VARCHAR(100) DEFAULT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'Pending PMO Review',
      payload LONGTEXT NOT NULL,
      pmo_action_notes TEXT DEFAULT NULL,
      decided_at VARCHAR(60) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_rcr_code (request_code),
      KEY idx_rcr_status (status),
      KEY idx_rcr_project (project_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  ready = true;
};

// =============================================================================
//  PROJECT STATUS  (PMO Review / PM freeze workflow)
// =============================================================================

// POST /getProjectsStatus   { pmo_id } | { pm_id }
exports.getProjectsStatus = async (req, res) => {
  try {
    await ensureSchema();
    const body = req.body || {};
    const pmId = toInt(body.pm_id);

    const rows = await sequelize.query(
      `
      SELECT
        p.id,
        p.project_code,
        p.project_name,
        p.company_name,
        p.project_manager,
        p.project_manager_id,
        p.start_date,
        p.end_date,
        p.duration,
        p.priority,
        p.budget,
        COALESCE(s.pm_status, 'draft')    AS pm_status,
        COALESCE(s.pmo_status, 'pending') AS pmo_status,
        s.reason,
        s.schedule_data,
        s.pm_updated_at,
        s.pmo_updated_at
      FROM projects p
      LEFT JOIN project_status s ON s.project_id = p.id
      ${pmId ? "WHERE p.project_manager_id = :pmId" : ""}
      ORDER BY p.id DESC
      `,
      { replacements: pmId ? { pmId } : {}, type: sequelize.QueryTypes.SELECT }
    );

    const data = rows.map((r) => ({
      ...r,
      schedule_data: parseJSON(r.schedule_data, null),
    }));

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("getProjectsStatus error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /scheduleStatusByPm
//   PM :  { project_id, pm_id,  pm_status,  reason, pmo_id?, pmo_status?, schedule_data? }
//   PMO:  { project_id, pmo_id, pmo_status, reason }
exports.scheduleStatusByPm = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const projectId = toInt(b.project_id);
    if (!projectId) {
      return res.status(400).json({ success: false, message: "project_id is required" });
    }

    const isPm = b.pm_status !== undefined;
    const isPmo = b.pmo_status !== undefined;
    if (!isPm && !isPmo) {
      return res
        .status(400)
        .json({ success: false, message: "pm_status or pmo_status is required" });
    }

    // row ensure
    await sequelize.query(
      `INSERT IGNORE INTO project_status (project_id) VALUES (:project_id)`,
      { replacements: { project_id: projectId } }
    );

    const sets = [];
    const repl = { project_id: projectId };

    if (isPm) {
      sets.push("pm_status = :pm_status", "pm_id = COALESCE(:pm_id, pm_id)", "pm_updated_at = NOW()");
      repl.pm_status = String(b.pm_status);
      repl.pm_id = toInt(b.pm_id);
      if (b.schedule_data !== undefined) {
        sets.push("schedule_data = :schedule_data");
        repl.schedule_data =
          typeof b.schedule_data === "string" ? b.schedule_data : JSON.stringify(b.schedule_data);
      }
      // PM re-submit -> PMO decision reset to pending (see scheduleWorkflow.js)
      if (b.pmo_status !== undefined) {
        sets.push("pmo_status = :pmo_status");
        repl.pmo_status = String(b.pmo_status);
      }
      if (b.pmo_id !== undefined) {
        sets.push("pmo_id = COALESCE(:pmo_id, pmo_id)");
        repl.pmo_id = toInt(b.pmo_id);
      }
    }

    if (isPmo) {
      sets.push(
        "pmo_status = :pmo_status",
        "pmo_id = COALESCE(:pmo_id, pmo_id)",
        "pmo_updated_at = NOW()"
      );
      repl.pmo_status = String(b.pmo_status);
      repl.pmo_id = toInt(b.pmo_id);
    }

    if (b.reason !== undefined) {
      sets.push("reason = :reason");
      repl.reason = b.reason || null;
    }

    await sequelize.query(
      `UPDATE project_status SET ${sets.join(", ")} WHERE project_id = :project_id`,
      { replacements: repl }
    );

    // project row par bhi reflect
    if (isPmo && String(b.pmo_status).toLowerCase() === "approved") {
      await sequelize
        .query(`UPDATE projects SET status = 'Active' WHERE id = :id`, {
          replacements: { id: projectId },
        })
        .catch(() => {});
    }

    return res
      .status(200)
      .json({ success: true, message: "Schedule status updated", data: { project_id: projectId } });
  } catch (error) {
    console.error("scheduleStatusByPm error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// =============================================================================
//  RESOURCE CHANGE REQUESTS
// =============================================================================
const hydrate = (row) => {
  const payload = parseJSON(row.payload, {});
  return {
    ...payload,
    id: row.request_code,
    status: row.status,
    priority: row.priority || payload.priority,
    projectId: row.project_id || payload.projectId,
    projectName: row.project_name || payload.projectName,
    projectManager: row.project_manager || payload.projectManager,
    pmoActionNotes: row.pmo_action_notes || payload.pmoActionNotes || "",
    decidedAt: row.decided_at || payload.decidedAt || null,
    requestedOn: payload.requestedOn || row.created_at,
  };
};

// GET /resource_change_requests
exports.getResourceChangeRequests = async (req, res) => {
  try {
    await ensureSchema();
    const rows = await sequelize.query(
      `SELECT * FROM resource_change_requests ORDER BY id DESC`,
      { type: sequelize.QueryTypes.SELECT }
    );
    const data = rows.map(hydrate);
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("getResourceChangeRequests error:", error);
    return res.status(500).json({ success: false, message: error.message, data: [] });
  }
};

// GET /resource_change_request_detail?id=RCR-xxxx
exports.getResourceChangeRequestDetail = async (req, res) => {
  try {
    await ensureSchema();
    const code = String(req.query.id || req.query.request_code || "").trim();
    if (!code) return res.status(400).json({ success: false, message: "id is required" });

    const rows = await sequelize.query(
      `SELECT * FROM resource_change_requests WHERE request_code = :code LIMIT 1`,
      { replacements: { code }, type: sequelize.QueryTypes.SELECT }
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    return res.status(200).json({ success: true, data: hydrate(rows[0]) });
  } catch (error) {
    console.error("getResourceChangeRequestDetail error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// shared: status change + activity log append
const decideRequest = async (code, newStatus, actorLine, detailsLine, extra = {}) => {
  const rows = await sequelize.query(
    `SELECT * FROM resource_change_requests WHERE request_code = :code LIMIT 1`,
    { replacements: { code }, type: sequelize.QueryTypes.SELECT }
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  const payload = parseJSON(row.payload, {});
  const stamp = nowStamp();

  payload.status = newStatus;
  payload.decidedAt = stamp;
  payload.activityLog = [
    ...(Array.isArray(payload.activityLog) ? payload.activityLog : []),
    {
      id: `act-${Date.now()}`,
      timestamp: stamp,
      author: actorLine,
      avatarTone:
        newStatus === "Approved"
          ? "bg-emerald-100 text-emerald-700"
          : newStatus === "Rejected"
          ? "bg-rose-100 text-rose-700"
          : "bg-blue-100 text-blue-700",
      action:
        newStatus === "Approved"
          ? "Request Approved by PMO"
          : newStatus === "Rejected"
          ? "Request Rejected by PMO"
          : "Clarification Requested from PM",
      details: detailsLine,
    },
  ];
  Object.assign(payload, extra);

  await sequelize.query(
    `UPDATE resource_change_requests
       SET status = :status, payload = :payload, decided_at = :stamp,
           pmo_action_notes = COALESCE(:notes, pmo_action_notes)
     WHERE request_code = :code`,
    {
      replacements: {
        code,
        status: newStatus,
        payload: JSON.stringify(payload),
        stamp,
        notes: extra.pmoActionNotes ?? null,
      },
    }
  );
  logActivity({ entity_type: "resource_request", entity_id: code, project_id: Number(row.project_id) || null, action: newStatus.toLowerCase().replace(/ .*/, ""), detail: detailsLine });
  return hydrate({ ...row, status: newStatus, payload: JSON.stringify(payload), decided_at: stamp });
};

// POST /approve_resource_change   { id, notes }
exports.approveResourceChange = async (req, res) => {
  try {
    await ensureSchema();
    const code = String(req.body.id || req.body.request_code || "").trim();
    const notes = req.body.notes || req.body.pmoNotes || "";
    if (!code) return res.status(400).json({ success: false, message: "id is required" });

    const updated = await decideRequest(
      code,
      "Approved",
      "Admin (PMO)",
      notes ? `Approved with note: "${notes}"` : "All requested resource changes have been approved and applied.",
      { pmoActionNotes: notes }
    );
    if (!updated) return res.status(404).json({ success: false, message: "Request not found" });
    return res.status(200).json({ success: true, message: "Request approved", data: updated });
  } catch (error) {
    console.error("approveResourceChange error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /reject_resource_change   { id, reason }
exports.rejectResourceChange = async (req, res) => {
  try {
    await ensureSchema();
    const code = String(req.body.id || req.body.request_code || "").trim();
    const reason = req.body.reason || "";
    if (!code) return res.status(400).json({ success: false, message: "id is required" });

    const updated = await decideRequest(
      code,
      "Rejected",
      "Admin (PMO)",
      `Rejection reason: "${reason}"`,
      { rejectionReason: reason }
    );
    if (!updated) return res.status(404).json({ success: false, message: "Request not found" });
    return res.status(200).json({ success: true, message: "Request rejected", data: updated });
  } catch (error) {
    console.error("rejectResourceChange error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /clarify_resource_change   { id, query }
exports.clarifyResourceChange = async (req, res) => {
  try {
    await ensureSchema();
    const code = String(req.body.id || req.body.request_code || "").trim();
    const query = req.body.query || req.body.clarificationQuery || "";
    if (!code) return res.status(400).json({ success: false, message: "id is required" });

    const updated = await decideRequest(
      code,
      "Clarification Requested",
      "Admin (PMO)",
      `PMO query: "${query}"`,
      { clarificationQuery: query }
    );
    if (!updated) return res.status(404).json({ success: false, message: "Request not found" });
    return res.status(200).json({ success: true, message: "Clarification requested", data: updated });
  } catch (error) {
    console.error("clarifyResourceChange error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /projectManager/create_resource_change_request   { ...payload }
exports.createResourceChangeRequest = async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};

    // next code
    const last = await sequelize.query(
      `SELECT request_code FROM resource_change_requests
       WHERE request_code LIKE 'RCR-%' ORDER BY id DESC LIMIT 1`,
      { type: sequelize.QueryTypes.SELECT }
    );
    let seq = 1;
    if (last.length) {
      const m = /RCR-(?:\d{4})?(\d+)$/.exec(last[0].request_code);
      if (m) seq = parseInt(m[1], 10) + 1;
    }
    const year = new Date().getFullYear();
    const code = `RCR-${year}${String(seq).padStart(3, "0")}`;
    const stamp = nowStamp();

    const payload = {
      ...b,
      id: code,
      requestedOn: new Date().toISOString(),
      requestedOnFormatted: stamp,
      status: "Pending PMO Review",
      currentAllocation: b.currentAllocation || [],
      requestedAllocation: b.requestedAllocation || [],
      attachments: b.attachments || [],
      paymentMilestones: b.paymentMilestones || [],
      activityLog: [
        {
          id: `act-${Date.now()}`,
          timestamp: stamp,
          author: `${b.projectManager || "Project Manager"} (PM)`,
          avatarTone: "bg-emerald-100 text-emerald-700",
          action: "Resource Change Request Submitted",
          details: b.reasonProvidedByPM
            ? `Submitted with reason: "${b.reasonProvidedByPM}"`
            : "Staffing adjustment request submitted to PMO queue.",
        },
      ],
    };

    await sequelize.query(
      `INSERT INTO resource_change_requests
        (request_code, project_id, project_name, pm_id, project_manager, priority, department, status, payload)
       VALUES (:code, :project_id, :project_name, :pm_id, :pm, :priority, :department, 'Pending PMO Review', :payload)`,
      {
        replacements: {
          code,
          project_id: b.projectId != null ? String(b.projectId) : null,
          project_name: b.projectName || null,
          pm_id: toInt(b.pm_id ?? b.pmId),
          pm: b.projectManager || null,
          priority: b.priority || "High",
          department: b.department || null,
          payload: JSON.stringify(payload),
        },
      }
    );

    return res
      .status(201)
      .json({ success: true, message: "Resource change request submitted", data: payload });
  } catch (error) {
    console.error("createResourceChangeRequest error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
