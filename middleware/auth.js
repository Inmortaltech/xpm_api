// =============================================================================
//  AUTH  —  JWT issue + verify, role guard, transparent bcrypt upgrade
// =============================================================================
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const SECRET = process.env.JWT_SECRET || "xmp-dev-secret-change-me";
const EXPIRES = process.env.JWT_EXPIRES || "12h";
const ENFORCED = String(process.env.AUTH_ENFORCED || "true").toLowerCase() !== "false";

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role || null, name: user.name || null, email: user.email || null },
    SECRET,
    { expiresIn: EXPIRES }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

function extract(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

// Always attach req.user when a valid token is present; never rejects.
function optionalAuth(req, _res, next) {
  const t = extract(req);
  if (t) {
    const payload = verifyToken(t);
    if (payload) req.user = payload;
  }
  next();
}

// Rejects when no valid token (unless AUTH_ENFORCED=false, then it just warns).
function requireAuth(req, res, next) {
  const t = extract(req);
  const payload = t ? verifyToken(t) : null;
  if (payload) {
    req.user = payload;
    return next();
  }
  if (!ENFORCED) {
    // staged rollout: let the request through but mark it
    req.authBypassed = true;
    return next();
  }
  return res.status(401).json({ success: false, message: "Authentication required" });
}

// Role guard — pass the allowed roles (case-insensitive). PMO/admin implicitly
// allowed everywhere.
function requireRole(...roles) {
  const allow = roles.map((r) => String(r).toLowerCase());
  return (req, res, next) => {
    if (!ENFORCED && !req.user) return next();
    const role = String(req.user?.role || "").toLowerCase();
    if (!req.user) return res.status(401).json({ success: false, message: "Authentication required" });
    if (role === "pmo" || role === "admin" || allow.includes(role)) return next();
    return res.status(403).json({ success: false, message: `Requires role: ${roles.join(" / ")}` });
  };
}

// bcrypt helpers + transparent upgrade check
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/;
const isHashed = (s) => typeof s === "string" && BCRYPT_RE.test(s);
const hashPassword = (plain) => bcrypt.hash(String(plain), 10);

async function passwordMatches(plain, stored) {
  if (!stored) return false;
  if (isHashed(stored)) return bcrypt.compare(String(plain), stored);
  // legacy plaintext row
  return String(plain) === String(stored);
}

module.exports = {
  signToken,
  verifyToken,
  optionalAuth,
  requireAuth,
  requireRole,
  hashPassword,
  isHashed,
  passwordMatches,
  AUTH_ENFORCED: ENFORCED,
};
