const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload");
const pmController = require("../controllers/projectManager.controller");

// PM — assigned projects (NewAssignedProjectPage / MyProjectsPage)
router.post("/get_projectsByPm", pmController.getProjectsByPm);

// PM — accept / decline
router.post("/project_approvalBYPM", pmController.projectApprovalByPm);

// PM — additional resource request (Add Required Resource modal)
router.post("/create_requiredResource", pmController.createRequiredResource);

// PM — backlog (Jira-style: sprint_id IS NULL issues + sprints)
const backlogController = require("../controllers/backlog.controller");
router.post("/get_pmBacklog", backlogController.getBacklog);

// PMO — assign PM
router.post("/assign_project", upload.none(), pmController.assignProject);

// PM/PMO — milestone update
router.post("/update_project_milestone", pmController.updateProjectMilestone);

// PMO — Denied PM History modal
router.get("/denied_pm_history", pmController.deniedPmHistory);
router.get("/get_deniedPmHistory", pmController.deniedPmHistory); // alias

// ─── Board (Jira-style: active sprint issues grouped by status) ─────────────
router.post("/getBoard", backlogController.getBoard);
router.post("/get_project_schedule", pmController.getProjectSchedule);

// ─── Backlog <-> Board / Sprints (Jira behaviour) ─────────────────────────
router.post("/moveToSprint", upload.none(), backlogController.moveToSprint);
router.post("/rankItem", upload.none(), backlogController.rankItem);
router.post("/getSprints", backlogController.getSprints);
router.post("/createSprint", upload.none(), backlogController.createSprint);
router.post("/startSprint", upload.none(), backlogController.startSprint);
router.post("/completeSprint", upload.none(), backlogController.completeSprint);
router.post("/sync_schedule_backlog", upload.none(), backlogController.syncScheduleToBacklog);

// Board custom columns
router.post("/getBoardStatus", pmController.getBoardStatus);
router.get("/getBoardStatus", pmController.getBoardStatus);
router.post("/saveBoardStatus", upload.none(), pmController.saveBoardStatus);
router.post("/editBoardStatus", upload.none(), pmController.editBoardStatus);
router.post("/deleteBoardStatus", upload.none(), pmController.deleteBoardStatus);

// ─── PMO Review workflow + Resource Change Request (PM side) ────────────────
const pmoController = require("../controllers/pmo.controller");
router.post("/scheduleStatusByPm", pmoController.scheduleStatusByPm);
router.post("/create_resource_change_request", upload.none(), pmoController.createResourceChangeRequest);

// ─── Schedule / Plan (Celoxis WBS) ────────────────────────────────────────
router.post("/create_schedule_task", upload.none(), pmController.createScheduleTask);
router.post("/update_schedule_task", upload.none(), pmController.updateScheduleTask);
router.post("/delete_schedule_task", upload.none(), pmController.deleteScheduleTask);

// ─── Legacy Gantt (GanttChart.jsx) aliases ───────────────────────────────
// The interactive Gantt component predates the create/update/delete_schedule_task
// naming and posts a slightly different shape. These thin adapters normalise the
// body and hand off to the same controllers so the Gantt's add/edit/delete work
// against one code path (no duplicate schedule logic).
const _ganttAdapt = (fn, shape) => (req, res) => {
  req.body = shape(req.body || {});
  return fn(req, res);
};
router.post("/schedule_project", upload.none(), _ganttAdapt(pmController.createScheduleTask, (b) => ({
  ...b,
  task_name: b.task_name || b.name,
})));
router.post("/subTask_schedule", upload.none(), _ganttAdapt(pmController.createScheduleTask, (b) => ({
  ...b,
  parent_id: b.parent_id || b.task_id,
  task_name: b.sub_task_name || b.task_name,
})));
router.post("/editTaskScheduleProject", upload.none(), _ganttAdapt(pmController.updateScheduleTask, (b) => ({
  ...b,
  id: b.id || b.task_id,
})));
router.post("/editSubTaskSchedule", upload.none(), _ganttAdapt(pmController.updateScheduleTask, (b) => ({
  ...b,
  id: b.id || b.sub_task_id,
  task_name: b.sub_task_name || b.task_name,
})));
router.post("/deleteTaskSubtask", upload.none(), _ganttAdapt(pmController.deleteScheduleTask, (b) => ({
  ...b,
  id: b.sub_task_id || b.id || b.task_id,
})));

// ─── Baseline + Critical Path (Celoxis) ──────────────────────────────────
const scheduleCtl = require("../controllers/schedule.controller");
router.post("/set_baseline", upload.none(), scheduleCtl.setBaseline);
router.post("/get_schedule_variance", scheduleCtl.getScheduleVariance);
router.post("/compute_critical_path", scheduleCtl.computeCriticalPath);
router.post("/reschedule_project", upload.none(), scheduleCtl.rescheduleProject);
router.post("/set_auto_schedule", upload.none(), scheduleCtl.setAutoSchedule);

// ─── Timesheet approvals (PM side) ────────────────────────────────────────
const timesheetPm = require("../controllers/timesheet.controller");
router.post("/timesheet_approvals", upload.none(), timesheetPm.timesheetApprovals);
router.post("/approve_timesheet", upload.none(), timesheetPm.approveTimesheet);
router.post("/reject_timesheet", upload.none(), timesheetPm.rejectTimesheet);

module.exports = router;
