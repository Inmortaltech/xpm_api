const User = require("../models/admin.model");
const { signToken, hashPassword, isHashed, passwordMatches } = require("../middleware/auth");

// OTP is exposed in the response only in dev (real deployment emails it).
const EXPOSE_OTP = String(process.env.DEV_EXPOSE_OTP || "false").toLowerCase() === "true";

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ where: { email: normalizedEmail } });

    // Same generic response whether the email exists or the password is wrong.
    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }
    if ((user.status || "").toLowerCase() === "disable") {
      return res.status(403).json({ success: false, message: "Your account is disabled. Please contact admin." });
    }

    const ok = await passwordMatches(password, user.password);
    if (!ok) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    // Transparent upgrade: first successful login on a legacy plaintext row
    // re-stores the password as a bcrypt hash.
    if (!isHashed(user.password)) {
      try {
        user.password = await hashPassword(password);
        await user.save();
      } catch (e) {
        console.warn("password hash upgrade failed:", e.message);
      }
    }

    const token = signToken(user);
    const imageUrl = user.image
      ? `${req.protocol}://${req.get("host")}/uploads/${user.image}`
      : null;

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        user_type: user.user_type,
        status: user.status,
        mobile: user.mobile,
        image: imageUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const otpStore = new Map();

exports.generateOtp = async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ where: { email: normalizedEmail } });

    // Do not reveal whether the account exists.
    if (user) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      otpStore.set(normalizedEmail, { otp, expiresAt: Date.now() + 2 * 60 * 1000, attempts: 0 });
      // TODO: send `otp` by email/SMS here.
      if (EXPOSE_OTP) {
        return res.status(200).json({ success: true, message: "OTP generated (dev)", otp });
      }
    }
    return res.status(200).json({
      success: true,
      message: "If that account exists, an OTP has been sent.",
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

function checkOtp(email, otp) {
  const stored = otpStore.get(email);
  if (!stored) return { ok: false, message: "No OTP found or OTP expired" };
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(email);
    return { ok: false, message: "OTP has expired" };
  }
  stored.attempts = (stored.attempts || 0) + 1;
  if (stored.attempts > 5) {
    otpStore.delete(email);
    return { ok: false, message: "Too many attempts — request a new OTP" };
  }
  if (stored.otp !== otp) return { ok: false, message: "Invalid OTP" };
  return { ok: true, stored };
}

exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: "Email and OTP are required" });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const r = checkOtp(normalizedEmail, otp);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    if (r.stored.verified) {
      return res.status(400).json({ success: false, message: "OTP has already been used" });
    }
    r.stored.verified = true;
    otpStore.set(normalizedEmail, r.stored);
    return res.status(200).json({ success: true, message: "OTP verified successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

exports.verifyOtpAndResetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body || {};
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ success: false, message: "Email, OTP, and new password are required" });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const r = checkOtp(normalizedEmail, otp);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    if (!r.stored.verified) {
      return res.status(400).json({ success: false, message: "Verify the OTP first" });
    }

    const user = await User.findOne({ where: { email: normalizedEmail } });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    user.password = await hashPassword(newPassword);
    await user.save();
    otpStore.delete(normalizedEmail);

    return res.status(200).json({ success: true, message: "Password reset successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
