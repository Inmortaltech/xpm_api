// =============================================================================
//  paginate.js  —  tiny shared pagination helper for list endpoints.
//
//  parsePage(req, { defLimit, maxLimit })  ->  { page, limit, offset }
//  meta(total, page, limit)                ->  { total, page, pages, has_more }
//
//  Convention (query string):  ?page=1&limit=25   (1-indexed page)
//  Back-compat: an endpoint may still be called with no page/limit — then it
//  falls back to `defLimit` and page 1, and callers that ignore the `pagination`
//  block keep working unchanged.
// =============================================================================

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function parsePage(req, { defLimit = 25, maxLimit = 200 } = {}) {
  const q = (req && (req.query || req.body)) || {};
  let limit = toInt(q.limit);
  if (!limit || limit < 1) limit = defLimit;
  if (limit > maxLimit) limit = maxLimit;

  let page = toInt(q.page);
  if (!page || page < 1) page = 1;

  return { page, limit, offset: (page - 1) * limit };
}

function meta(total, page, limit) {
  const t = Number(total) || 0;
  const pages = limit > 0 ? Math.max(1, Math.ceil(t / limit)) : 1;
  return { total: t, page, limit, pages, has_more: page < pages };
}

module.exports = { parsePage, meta };
