// =============================================================================
//  Unit tests — pure helpers, no DB. Run: `npm test`  (node --test)
// =============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePage, meta } = require("../utils/paginate");
const { hashPassword, passwordMatches } = require("../middleware/auth");
const { send: sendMail, mailerMode } = require("../utils/mailer");

test("parsePage — defaults when nothing supplied", () => {
  const r = parsePage({ query: {} }, { defLimit: 25, maxLimit: 200 });
  assert.deepEqual(r, { page: 1, limit: 25, offset: 0 });
});

test("parsePage — reads page/limit and computes offset", () => {
  const r = parsePage({ query: { page: "3", limit: "10" } });
  assert.equal(r.page, 3);
  assert.equal(r.limit, 10);
  assert.equal(r.offset, 20);
});

test("parsePage — clamps limit to maxLimit and floors bad input", () => {
  assert.equal(parsePage({ query: { limit: "9999" } }, { maxLimit: 200 }).limit, 200);
  assert.equal(parsePage({ query: { limit: "-4" } }, { defLimit: 25 }).limit, 25);
  assert.equal(parsePage({ query: { page: "0" } }).page, 1);
  assert.equal(parsePage({ query: { page: "abc" } }).page, 1);
});

test("parsePage — falls back to body when query missing", () => {
  const r = parsePage({ body: { page: 2, limit: 5 } });
  assert.equal(r.page, 2);
  assert.equal(r.offset, 5);
});

test("meta — page math", () => {
  assert.deepEqual(meta(0, 1, 25), { total: 0, page: 1, limit: 25, pages: 1, has_more: false });
  assert.deepEqual(meta(51, 2, 25), { total: 51, page: 2, limit: 25, pages: 3, has_more: true });
  assert.deepEqual(meta(50, 2, 25), { total: 50, page: 2, limit: 25, pages: 2, has_more: false });
});

test("hashPassword + passwordMatches — bcrypt roundtrip", async () => {
  const hash = await hashPassword("s3cret!");
  assert.match(hash, /^\$2[aby]\$\d{2}\$/);
  assert.equal(await passwordMatches("s3cret!", hash), true);
  assert.equal(await passwordMatches("wrong", hash), false);
});

test("passwordMatches — legacy plaintext still compares", async () => {
  assert.equal(await passwordMatches("plain123", "plain123"), true);
  assert.equal(await passwordMatches("plain123", "nope"), false);
});

test("mailer — log mode returns a well-formed result and never throws", async () => {
  assert.equal(mailerMode(), "log"); // no SMTP_HOST in test env
  const out = await sendMail({ to: "a@b.com, c@d.com", subject: "hi", text: "body" });
  assert.equal(out.mode, "log");
  assert.equal(out.delivered, false);
  const empty = await sendMail({ to: "", subject: "x" });
  assert.equal(empty.detail, "no recipients");
});
