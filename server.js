require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");

const sequelize = require("./config/db");
const { requireAuth, requireRole } = require("./middleware/auth");
const { rateLimit } = require("./middleware/rateLimit");

const app = express();
app.set("trust proxy", 1);

// ── CORS — allowlist from env (comma separated), '*' allowed only in dev ────
const ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || ORIGINS.includes("*") || ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// ── Minimal security headers (helmet-lite, no dependency) ──────────────────
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-XSS-Protection", "0");
  res.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  if (process.env.NODE_ENV === "production") {
    res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "2mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/api/health", (_req, res) =>
  sequelize
    .authenticate()
    .then(() => res.json({ success: true, status: "ok", db: "up" }))
    .catch(() => res.status(503).json({ success: false, status: "degraded", db: "down" }))
);

// ── Routes ────────────────────────────────────────────────────────────────
const adminRoutes = require("./routes/admin.routes");
const authRoutes = require("./routes/auth.routes");
const projectManagerRoutes = require("./routes/projectManager.routes");
const usersRoutes = require("./routes/users.routes");
const clientRoutes = require("./routes/client.routes");

// auth endpoints are public but rate-limited (brute-force protection)
app.use("/api/auth", rateLimit({ windowMs: 60_000, max: 12, message: "Too many auth attempts. Try again in a minute." }), authRoutes);

// everything else requires a valid JWT (AUTH_ENFORCED=false downgrades this to a warning)
app.use("/api/admin", requireAuth, adminRoutes);
app.use("/api/projectManager", requireAuth, projectManagerRoutes);
app.use("/api/users", requireAuth, usersRoutes);
app.use("/api/client", requireAuth, clientRoutes);

// ── 404 + central error handler ──────────────────────────────────────────
app.use((req, res) => res.status(404).json({ success: false, message: `Not found: ${req.method} ${req.path}` }));

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    message:
      process.env.NODE_ENV === "production" && status === 500
        ? "Internal server error"
        : err.message || "Internal server error",
  });
});

// DB sync — dev convenience only. Production must use `npm run migrate`.
// Enabled unless NODE_ENV=production; force with DB_SYNC=true / disable with DB_SYNC=false.
const wantSync = process.env.DB_SYNC
  ? String(process.env.DB_SYNC).toLowerCase() === "true"
  : process.env.NODE_ENV !== "production";
if (wantSync) {
  sequelize
    .sync()
    .then(() => console.log("Tables synced (dev sequelize.sync — run `npm run migrate` for prod)"))
    .catch((err) => console.log(err));
} else {
  console.log("DB sync skipped (production) — schema managed by `npm run migrate`");
}

const port = process.env.PORT || process.env.APP_PORT || 8021;
app.listen(port, () => console.log(`Server running on port ${port} · auth ${process.env.AUTH_ENFORCED === "false" ? "SOFT" : "ENFORCED"}`));

// ── Part B background sweeps: approval SLA/escalation + scheduled report email.
//    Interval minutes from SWEEP_INTERVAL_MIN (default 15; set 0 to disable).
const sweepMin = Number(process.env.SWEEP_INTERVAL_MIN ?? 15);
if (sweepMin > 0 && process.env.NODE_ENV !== "test") {
  const { runApprovalSla } = require("./controllers/approval.controller");
  const { runScheduledReports } = require("./controllers/report.controller");
  const tick = async () => {
    try { await runApprovalSla({ force: true }); } catch (e) { console.warn("SLA sweep:", e.message); }
    try { await runScheduledReports({ force: true }); } catch (e) { console.warn("report sweep:", e.message); }
  };
  setTimeout(tick, 20_000).unref?.();
  setInterval(tick, sweepMin * 60_000).unref?.();
  console.log(`Background sweeps every ${sweepMin} min (approval SLA + scheduled reports)`);
}
