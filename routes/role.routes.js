const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");
const { constants: { ENUM: { ROLE } } } = require("../helpers")

const { ROLE: { VALIDATOR, APIS } } = require("../controllers");

/* Post Apis */
router.post("/", auth({ usersAllowed: [ROLE.ADMIN], isTokenRequired: false }), VALIDATOR.createRole, APIS.createRole);

module.exports = router;
