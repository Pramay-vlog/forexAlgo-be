const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");

const { TRADE: { VALIDATOR, APIS } } = require("../controllers");

/* Post Apis */
router.post("/", auth({ isTokenRequired: true }), VALIDATOR.Trade, APIS.Trade);

/* Get Apis */
router.get("/", auth({ isTokenRequired: true }), APIS.getTradeData);
router.get("/:tradeId", auth({ isTokenRequired: true }), VALIDATOR.TradeHistory, APIS.getTradeHistory);

module.exports = router;
