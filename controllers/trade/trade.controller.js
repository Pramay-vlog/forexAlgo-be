const DB = require("../../models");
const { response } = require("../../helpers");
const { redis } = require("../../config/redis.config");
const { sendMessageToDLL } = require("../../service/tcp/tcpClient.service");
const { constants: { ENUM: { STRATEGY } } } = require("../../helpers");

module.exports = {
    Trade: async (req, res) => {
        const { symbol, GAP, ECLIPSE_BUFFER, volume, strategy, direction } = req.body;
        const { accountId } = req.user;

        const ACTIVE_SYMBOLS_KEY = `account:${accountId}:active:symbols`;
        const SYMBOL_CONFIG_KEY = `account:${accountId}:symbol_config:${symbol}`;
        const CHECKPOINT_KEY = `account:${accountId}:checkpoint:${symbol}`;

        let isActive = await redis.sismember(ACTIVE_SYMBOLS_KEY, symbol);

        if (!isActive) {
            isActive = await DB.TRADE.findOne({ accountId, symbol, isActive: true }).lean();
        }

        if (!isActive) {
            // Store in Redis set
            await redis.sadd(ACTIVE_SYMBOLS_KEY, symbol);

            // Store full config as hash
            await redis.hset(SYMBOL_CONFIG_KEY, {
                symbol,
                GAP: (STRATEGY.TRAILING === strategy || STRATEGY.REVERSAL === strategy) ? GAP : 0,
                ECLIPSE_BUFFER,
                volume,
                strategy,
                direction
            });

            // Send subscription message to DLL
            sendMessageToDLL({
                action: "SUBSCRIBE",
                symbol,
                GAP: (STRATEGY.TRAILING === strategy || STRATEGY.REVERSAL === strategy) ? GAP : 0,
                ECLIPSE_BUFFER,
                volume,
                strategy,
            });

            // Store in DB with accountId
            await DB.TRADE.create({
                accountId,
                symbol,
                gap: (STRATEGY.TRAILING === strategy || STRATEGY.REVERSAL === strategy) ? GAP : 0,
                eclipseBuffer: ECLIPSE_BUFFER,
                volume,
                strategy,
                direction,
                isActive: true
            });

            return response.OK({ res, message: "Symbol subscribed successfully" });

        } else {
            // Unsubscribe logic
            await redis.srem(ACTIVE_SYMBOLS_KEY, symbol);
            await redis.del(SYMBOL_CONFIG_KEY);
            await redis.del(CHECKPOINT_KEY);

            sendMessageToDLL({
                action: "UNSUBSCRIBE",
                symbol
            });

            // Update DB
            await DB.TRADE.updateOne(
                { accountId, symbol, isActive: true },
                { $set: { isActive: false } }
            );

            return response.OK({ res, message: "Symbol unsubscribed successfully" });
        }
    },

    getTradeData: async (req, res) => {
        const { accountId } = req.user;
        const activeSymbols = await DB.TRADE.find({ accountId }).sort({ createdAt: -1 }).lean();

        if (!activeSymbols || activeSymbols.length === 0) {
            return response.NOT_FOUND({ res, message: "No Trade Data Found" });
        }

        return response.OK({
            res,
            message: "Trade data fetched successfully",
            payload: activeSymbols,
        });
    },

    getTradeHistory: async (req, res) => {
        const { tradeId } = req.params;

        const tradeHistory = await DB.TRADE_HISTORY.find({ tradeId }).sort({ createdAt: 1 }).lean();

        if (!tradeHistory || tradeHistory.length === 0) {
            return response.NOT_FOUND({ res, message: "No trade history found" });
        }

        return response.OK({
            res,
            message: "Trade history fetched successfully",
            payload: tradeHistory,
        });
    }
};
