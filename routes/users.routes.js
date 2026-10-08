const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload");
const u = require("../controllers/users.controller");

// ─── My Tasks (For You / Project Detail / Risk page data source) ─────────────
router.post("/get_userProjectList", u.getUserProjectList);
router.post("/get_userProjectDetail", u.getUserProjectDetail);

// ─── Kanban Board / Backlog issues (Jira-style) ────────────────────────────
const backlog = require("../controllers/backlog.controller");
router.post("/create_board", upload.none(), backlog.createIssue);
router.post("/editBoard", upload.single("attachments"), backlog.editIssue);
router.post("/deleteBoard", upload.none(), backlog.deleteIssue);

// ─── Project Discussion ────────────────────────────────────────────────────
router.post("/get_userDiscussion", upload.none(), u.getUserDiscussion);
router.post("/create_discussion", upload.single("attachment"), u.createDiscussion);

// ─── Notifications ─────────────────────────────────────────────────────────
router.get("/get_notifications", u.getNotifications);
router.post("/mark_notification_read", upload.none(), u.markNotificationRead);
router.post("/mark_all_notifications_read", upload.none(), u.markAllNotificationsRead);
router.delete("/clear_all_notifications", u.clearAllNotifications);
router.post("/clear_all_notifications", u.clearAllNotifications); // alias
router.post("/delete_notification", upload.none(), u.deleteNotification);

// ─── Risk register ────────────────────────────────────────────────────────
router.get("/get_risks", u.getRisks);
router.post("/create_risk", upload.none(), u.createRisk);
router.post("/update_risk", upload.none(), u.updateRisk);
router.post("/delete_risk", upload.none(), u.deleteRisk);

// ─── Time tracking (Celoxis "Time") — team member side ────────────────────
const timesheet = require("../controllers/timesheet.controller");
router.post("/log_time", upload.none(), timesheet.logTime);
router.post("/get_my_timesheet", upload.none(), timesheet.getMyTimesheet);
router.post("/submit_timesheet", upload.none(), timesheet.submitTimesheet);
router.post("/delete_time", upload.none(), timesheet.deleteTime);

module.exports = router;
