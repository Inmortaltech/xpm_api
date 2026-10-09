const User = require("../models/admin.model");

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({
      where: { email: normalizedEmail },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    if ((user.status || "").toLowerCase() === "disable") {
      return res.status(403).json({
        success: false,
        message: "Your account is disabled. Please contact admin.",
      });
    }

    if (user.password !== password) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const token = `wk_${Buffer.from(`${user.id}:${Date.now()}`).toString("base64")}`;
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
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
};

const otpStore = new Map();

exports.generateOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ where: { email: normalizedEmail } });
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const otp = Math.floor(10000 + Math.random() * 90000).toString();
    const expiresAt = Date.now() + 2 * 60 * 1000; // 2 minutes

    otpStore.set(normalizedEmail, { otp, expiresAt });

    return res.status(200).json({ success: true, message: "OTP generated", otp });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || "Internal server error" });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: "Email and OTP are required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const stored = otpStore.get(normalizedEmail);

    if (!stored) {
      return res.status(400).json({ success: false, message: "No OTP found or OTP expired" });
    }

    if (Date.now() > stored.expiresAt) {
      otpStore.delete(normalizedEmail);
      return res.status(400).json({ success: false, message: "OTP has expired" });
    }

    if (stored.otp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    if (stored.verified) {
      return res.status(400).json({ success: false, message: "OTP has already been used" });
    }

    stored.verified = true;
    otpStore.set(normalizedEmail, stored);

    return res.status(200).json({ success: true, message: "OTP verified successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || "Internal server error" });
  }
};

exports.verifyOtpAndResetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ success: false, message: "Email, OTP, and new password are required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const stored = otpStore.get(normalizedEmail);

    if (!stored) {
      return res.status(400).json({ success: false, message: "No OTP found or OTP expired" });
    }

    if (Date.now() > stored.expiresAt) {
      otpStore.delete(normalizedEmail);
      return res.status(400).json({ success: false, message: "OTP has expired" });
    }

    if (stored.otp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    const user = await User.findOne({ where: { email: normalizedEmail } });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    user.password = newPassword;
    await user.save();

    otpStore.delete(normalizedEmail);

    return res.status(200).json({ success: true, message: "Password reset successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || "Internal server error" });
  }
};
