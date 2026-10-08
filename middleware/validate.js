// =============================================================================
//  Lightweight request validation — no schema library.
//  requireFields(['email','password'])  ->  400 with the missing list.
//  Also trims strings and rejects absurdly long values.
// =============================================================================
const MAX_LEN = 5000;

function requireFields(fields, source = "body") {
  return (req, res, next) => {
    const src = req[source] || {};
    const missing = [];
    for (const f of fields) {
      const v = src[f];
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
        missing.push(f);
      }
      if (typeof v === "string" && v.length > MAX_LEN) {
        return res.status(400).json({ success: false, message: `Field "${f}" is too long` });
      }
    }
    if (missing.length) {
      return res
        .status(400)
        .json({ success: false, message: `Missing required field(s): ${missing.join(", ")}` });
    }
    next();
  };
}

module.exports = { requireFields };
