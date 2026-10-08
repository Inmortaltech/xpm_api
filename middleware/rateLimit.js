// =============================================================================
//  Tiny in-memory sliding-window rate limiter (no external dependency).
//  Good enough for a single-process deployment; swap for redis-backed
//  express-rate-limit when running multiple instances.
// =============================================================================
function rateLimit({ windowMs = 60_000, max = 10, message = "Too many requests, slow down." } = {}) {
  const hits = new Map(); // key -> [timestamps]

  // opportunistic cleanup
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }, windowMs).unref?.();

  return (req, res, next) => {
    const key =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.ip ||
      req.connection?.remoteAddress ||
      "unknown";
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => t > now - windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (arr.length > max) {
      res.set("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({ success: false, message });
    }
    next();
  };
}

module.exports = { rateLimit };
