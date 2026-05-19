const express = require("express");
const router = express.Router();
const adminController = require("../controllers/admin.controller");
const multer = require("multer");

const upload = require("../middleware/upload");


router.post("/create_user", upload.single("image"), adminController.createUser);
router.get("/user_list" , upload.none(), adminController.getUsers);
router.post("/update_user", upload.single("image"), adminController.updateUser);
router.post("/update_status" , upload.none(), adminController.updateUserStatus);
router.get("/create_project" , upload.none(), adminController.createProject);
//router.post("/add-project", upload.single("upload_personal_document"), adminController.addProject);

router.post("/add-project",upload.fields([{ name: "upload_personal_document", maxCount: 1 },{ name: "company_logo", maxCount: 1 }]),
  adminController.addProject
);

router.get("/get_projectList" , upload.none(), adminController.getProjectList);

router.post(
  "/update_project",
  upload.fields([
    { name: "upload_personal_document", maxCount: 1 },
    { name: "company_logo", maxCount: 1 }
  ]),
  adminController.updateProject
);
router.get("/all_projects", upload.none(), adminController.getAllProjects);

router.post("/create_resource", upload.single("image"),adminController.createResource);
router.get("/resource_list" , upload.none(), adminController.getAllResources);


router.post("/update_resource", upload.single("image"), adminController.updateResource);
router.post("/deactivate_resource", upload.none(), adminController.deactivateResource);

// ─── Holiday Routes ───────────────────────────────────────────────────────────
router.get("/holidays",        upload.none(), adminController.getHolidays);
router.post("/add_holiday",    adminController.addHoliday);
router.post("/update_holiday", adminController.updateHoliday);
router.post("/delete_holiday", adminController.deleteHoliday);

// Used by CreateProjectWizardModal to compute end date (skipping holidays)
// GET /admin/check_holidays?start_date=YYYY-MM-DD&duration=N&exclude_weekends=0|1
router.get("/check_holidays",  upload.none(), adminController.checkHolidays);


module.exports = router;