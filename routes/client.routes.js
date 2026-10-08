const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload");
const { requireRole } = require("../middleware/auth");
const c = require("../controllers/client.controller");

const pmoOnly = requireRole("pmo", "admin");
const clientOrPmo = requireRole("client", "pmo", "admin");

// Client / stakeholder portal — scoped read-only (client's own controller re-checks)
router.post("/my_projects", clientOrPmo, upload.none(), c.myProjects);
router.post("/project_view", clientOrPmo, upload.none(), c.projectView);

// PMO manages client access
router.get("/access_list", pmoOnly, c.accessList);
router.post("/grant_access", pmoOnly, upload.none(), c.grantAccess);
router.post("/revoke_access", pmoOnly, upload.none(), c.revokeAccess);

module.exports = router;
