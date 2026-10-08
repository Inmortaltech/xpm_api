const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");

router.post("/login", authController.login);
router.post("/forgot-password/generate-otp", authController.generateOtp);
router.post("/forgot-password/verify-otp", authController.verifyOtp);
router.post("/forgot-password/reset", authController.verifyOtpAndResetPassword);

module.exports = router;