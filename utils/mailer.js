// =============================================================================
//  mailer.js  —  tiny outbound mail abstraction.
//
//  * If `nodemailer` is installed AND SMTP_* env vars are set → real SMTP send.
//  * Otherwise → "log mode": the message is printed and recorded, nothing is
//    actually sent. This keeps the app working out of the box with no new
//    hard dependency; installing nodemailer + setting SMTP_HOST upgrades it.
//
//  ENV:  SMTP_HOST  SMTP_PORT  SMTP_USER  SMTP_PASS  SMTP_SECURE(=true|false)
//        MAIL_FROM  (default "XMP <no-reply@xmp.local>")
// =============================================================================

let transporter = null;
let mode = "log";

try {
  if (process.env.SMTP_HOST) {
    // eslint-disable-next-line global-require
    const nodemailer = require("nodemailer");
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "false") === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    mode = "smtp";
  }
} catch (_) {
  transporter = null;
  mode = "log";
}

const FROM = process.env.MAIL_FROM || "XMP <no-reply@xmp.local>";

/**
 * send({ to, subject, text, html }) -> { mode, delivered, detail }
 * `to` may be an array or a comma-separated string. Never throws.
 */
async function send({ to, subject, text, html }) {
  const recipients = Array.isArray(to)
    ? to.filter(Boolean)
    : String(to || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  if (recipients.length === 0) {
    return { mode, delivered: false, detail: "no recipients" };
  }

  if (mode === "smtp" && transporter) {
    try {
      const info = await transporter.sendMail({ from: FROM, to: recipients.join(", "), subject, text, html });
      return { mode: "smtp", delivered: true, detail: info.messageId || "sent" };
    } catch (e) {
      return { mode: "smtp", delivered: false, detail: e.message };
    }
  }

  // log mode
  console.log(
    `\n[mailer:log] to=${recipients.join(", ")}\n           subject=${subject}\n           ${(text || "").slice(0, 500)}\n`
  );
  return { mode: "log", delivered: false, detail: "logged (no SMTP configured)" };
}

module.exports = { send, mailerMode: () => mode };
