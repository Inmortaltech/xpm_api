// =============================================================================
//  Smoke tests — every controller & route module loads without throwing and
//  exposes the handlers the routers wire up. Catches syntax errors, bad
//  requires and renamed/removed exports before they hit a running server.
//  DB-free: requiring config/db creates a Sequelize instance but does not
//  block on a connection.
// =============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// controllers require config/db which opens a pool — close it so the test
// runner can exit promptly instead of waiting on the idle connection.
test.after(async () => {
  try { await require("../config/db").close(); } catch { /* not opened */ }
});

test("every controller module requires cleanly and exports handlers", () => {
  const dir = path.join(ROOT, "controllers");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const mod = require(path.join(dir, file));
    assert.equal(typeof mod, "object", `${file} should export an object`);
    const fns = Object.values(mod).filter((v) => typeof v === "function");
    assert.ok(fns.length > 0, `${file} should export at least one function`);
  }
});

test("every route module requires cleanly and is an express router", () => {
  const dir = path.join(ROOT, "routes");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const r = require(path.join(dir, file));
    assert.equal(typeof r, "function", `${file} should export a router function`);
    assert.ok(r.stack || r.name === "router", `${file} should look like an express router`);
  }
});

test("key Part-A / Part-B handlers are present", () => {
  const admin = require("../controllers/admin.controller");
  const pm = require("../controllers/projectManager.controller");
  const sched = require("../controllers/schedule.controller");
  const appr = require("../controllers/approval.controller");
  const rep = require("../controllers/report.controller");
  const client = require("../controllers/client.controller");
  const wl = require("../controllers/workload.controller");

  for (const [obj, name] of [
    [pm.createScheduleTask, "pm.createScheduleTask"],
    [pm.updateScheduleTask, "pm.updateScheduleTask"],
    [sched.computeCriticalPath, "schedule.computeCriticalPath"],
    [sched.cascadeSchedule, "schedule.cascadeSchedule"],
    [sched.rescheduleProject, "schedule.rescheduleProject"],
    [sched.setAutoSchedule, "schedule.setAutoSchedule"],
    [appr.runApprovalSla, "approval.runApprovalSla"],
    [appr.runApprovalSlaHandler, "approval.runApprovalSlaHandler"],
    [rep.runScheduledReports, "report.runScheduledReports"],
    [rep.getReportDeliveries, "report.getReportDeliveries"],
    [client.accessList, "client.accessList"],
    [wl.getWorkload, "workload.getWorkload"],
    [wl.getWorkloadTasks, "workload.getWorkloadTasks"],
    [admin.getMe, "admin.getMe"],
    [admin.updateProfile, "admin.updateProfile"],
  ]) {
    assert.equal(typeof obj, "function", `${name} must be a function`);
  }
});
