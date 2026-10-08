const express = require("express");
const router = express.Router();
const adminController = require("../controllers/admin.controller");
const multer = require("multer");

const upload = require("../middleware/upload");
const { requireRole } = require("../middleware/auth");

// PMO / admin only — everything else in this file just needs a valid session
const pmoOnly = requireRole("pmo", "admin");
const pmOrPmo = requireRole("pm", "project manager", "pmo", "admin");

router.post("/create_user", pmoOnly, upload.single("image"), adminController.createUser);
router.get("/user_list" , upload.none(), adminController.getUsers);
router.post("/update_user", upload.single("image"), adminController.updateUser);
router.post("/update_status" , pmoOnly, upload.none(), adminController.updateUserStatus);

// self-service profile (any authenticated user, scoped to req.user.id)
router.get("/me", adminController.getMe);
router.post("/update_profile", upload.single("image"), adminController.updateProfile);
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

// PMO — re-allocate project to a new PM (CreateProjectPage.jsx)
router.post("/re-allocated", pmoOnly, upload.none(), adminController.reallocateProject);

// ─── PMO section ───────────────────────────────────────────────────────────
const pmoController = require("../controllers/pmo.controller");
router.post("/getProjectsStatus", pmoController.getProjectsStatus);
router.get("/resource_change_requests", pmoController.getResourceChangeRequests);
router.get("/resource_change_request_detail", pmoController.getResourceChangeRequestDetail);
router.post("/approve_resource_change", pmoOnly, upload.none(), pmoController.approveResourceChange);
router.post("/reject_resource_change", pmoOnly, upload.none(), pmoController.rejectResourceChange);
router.post("/clarify_resource_change", pmoOnly, upload.none(), pmoController.clarifyResourceChange);

// ─── Analytics / dashboards (Celoxis reports) ──────────────────────────────
const analyticsController = require("../controllers/analytics.controller");
router.post("/getPortfolioSummary", analyticsController.getPortfolioSummary);
router.get("/getPortfolioSummary", analyticsController.getPortfolioSummary);
router.post("/getProjectDashboard", analyticsController.getProjectDashboard);
router.post("/getPmDashboard", analyticsController.getPmDashboard);
router.post("/getResourceDashboard", analyticsController.getResourceDashboard);
router.post("/getResourceUtilization", analyticsController.getResourceUtilization);
router.post("/refresh_project_health", analyticsController.refreshAllProjectHealth);
router.get("/activity", analyticsController.getActivity);

// ─── Expenses (Celoxis Expenses) ──────────────────────────────────────────
const expenseController = require("../controllers/expense.controller");
router.post("/create_expense", upload.single("receipt"), expenseController.createExpense);
router.get("/expenses", expenseController.getExpenses);
router.get("/expense_summary", expenseController.expenseSummary);
router.post("/approve_expense", pmOrPmo, upload.none(), expenseController.approveExpense);
router.post("/reject_expense", pmOrPmo, upload.none(), expenseController.rejectExpense);

// ─── Portfolios / Programs ────────────────────────────────────────────────
const portfolioController = require("../controllers/portfolio.controller");
router.get("/portfolios", portfolioController.getPortfolios);
router.post("/create_portfolio", pmoOnly, upload.none(), portfolioController.createPortfolio);
router.post("/update_portfolio", upload.none(), portfolioController.updatePortfolio);
router.post("/assign_portfolio", pmoOnly, upload.none(), portfolioController.assignPortfolio);
router.post("/getPortfolioRollup", portfolioController.getPortfolioRollup);

// ─── Invoicing / AR (Celoxis Billing) ────────────────────────────────────
const invoiceController = require("../controllers/invoice.controller");
router.get("/invoices", invoiceController.getInvoices);
router.get("/invoice_detail", invoiceController.getInvoiceDetail);
router.post("/create_invoice", pmOrPmo, upload.none(), invoiceController.createInvoice);
router.post("/update_invoice_status", upload.none(), invoiceController.updateInvoiceStatus);
router.post("/mark_invoice_paid", pmOrPmo, upload.none(), invoiceController.markInvoicePaid);
router.get("/ar_aging", invoiceController.arAging);

// ─── Approval engine + unified inbox ─────────────────────────────────────
const approvalController = require("../controllers/approval.controller");
router.post("/create_approval", upload.none(), approvalController.createApproval);
router.post("/approval_decide", upload.none(), approvalController.approvalDecide);
router.post("/my_approvals", upload.none(), approvalController.myApprovals);
router.get("/approval_detail", approvalController.approvalDetail);
router.get("/approvals_inbox", approvalController.approvalsInbox);
router.post("/approvals_inbox", approvalController.approvalsInbox);
router.post("/run_approval_sla", pmoOnly, upload.none(), approvalController.runApprovalSlaHandler);

// ─── Capacity forecast (Celoxis resource planning) ──────────────────────
const scheduleController = require("../controllers/schedule.controller");
router.post("/getCapacityForecast", scheduleController.getCapacityForecast);

// ─── Workload / Resource Load grid (Celoxis Resource Load Chart) ────────
const workloadController = require("../controllers/workload.controller");
router.post("/get_workload", upload.none(), workloadController.getWorkload);
router.get("/get_workload", workloadController.getWorkload);
router.post("/get_workload_tasks", upload.none(), workloadController.getWorkloadTasks);

// ─── Report builder ─────────────────────────────────────────────────────
const reportController = require("../controllers/report.controller");
router.get("/report_fields", reportController.reportFields);
router.post("/run_report", upload.none(), reportController.runReport);
router.get("/saved_reports", reportController.getSavedReports);
router.post("/save_report", upload.none(), reportController.saveReport);
router.post("/delete_report", upload.none(), reportController.deleteReport);
router.post("/run_saved_report", upload.none(), reportController.runSavedReport);
router.post("/run_scheduled_reports", pmoOnly, upload.none(), reportController.runScheduledReportsHandler);
router.get("/report_deliveries", reportController.getReportDeliveries);

router.post("/create_resource", upload.single("image"),adminController.createResource);
router.get("/resource_list" , upload.none(), adminController.getAllResources);


router.post("/update_resource", upload.single("image"), adminController.updateResource);
router.post("/deactivate_resource", upload.none(), adminController.deactivateResource);

// ─── Holiday Routes ───────────────────────────────────────────────────────────
router.get("/holidays",        upload.none(), adminController.getHolidays);
router.post("/add_holiday",    adminController.addHoliday);
router.post("/update_holiday", adminController.updateHoliday);
router.post("/delete_holiday", pmoOnly, adminController.deleteHoliday);

// Used by CreateProjectWizardModal to compute end date (skipping holidays)
// GET /admin/check_holidays?start_date=YYYY-MM-DD&duration=N&exclude_weekends=0|1
router.get("/check_holidays",  upload.none(), adminController.checkHolidays);


module.exports = router;