const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");
const { constants: { ENUM: { ROLE } } } = require("../helpers")

const { USER: { VALIDATOR, APIS } } = require("../controllers");

/* Get Apis */
router.get("/", auth({ usersAllowed: ["*"] }), VALIDATOR.fetch, APIS.getUser);
router.get("/dashboard", auth({ usersAllowed: [ROLE.ADMIN] }), APIS.dashboardCounts);

/* Post Apis */
router.post("/signup", VALIDATOR.signup, APIS.signUp);
router.post("/signin", VALIDATOR.signIn, APIS.signIn);
router.post("/forgot", VALIDATOR.forgot, APIS.forgot);
router.post("/verifyOtp", VALIDATOR.verifyOtp, APIS.verifyOtp);

/* Put Apis */
router.patch("/update/:_id", auth({ usersAllowed: ["*"] }), VALIDATOR.update, APIS.update);
router.patch("/verifyOtp/resetPassword", auth({ usersAllowed: ["*"] }), VALIDATOR.resetForgotPassword, APIS.resetForgotPassword)
router.patch("/changePassword", auth({ usersAllowed: ["*"] }), VALIDATOR.changePassword, APIS.changePassword);

/* Patch Apis */
router.patch("/toggleActive/:_id", auth({ usersAllowed: [ROLE.ADMIN] }), VALIDATOR.toggleActive, APIS.toggleActive)

module.exports = router;
