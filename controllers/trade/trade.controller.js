const DB = require("../../models");
const { response } = require("../../helpers");
const { redis } = require("../../config/redis.config");
const { sendMessageToDLL } = require("../../service/tcp/tcpClient.service");

const ACTIVE_SYMBOLS_KEY = "active:symbols";

module.exports = {
    Trade: async (req, res) => {
        const { symbol, GAP, ECLIPSE_BUFFER, volume, tradeBuffer } = req.body;
        let isActive = await redis.sismember(ACTIVE_SYMBOLS_KEY, symbol);
        if (!isActive) {
            isActive = await DB.TRADE.findOne({ symbol, isActive: true }).lean();
        }

        if (!isActive) {
            // Store in set
            await redis.sadd(ACTIVE_SYMBOLS_KEY, symbol);

            // Store full config as hash
            await redis.hset(`symbol_config:${symbol}`, {
                symbol,
                GAP,
                ECLIPSE_BUFFER,
                volume,
                tradeBuffer,
            });

            // Send subscription message to DLL
            sendMessageToDLL({
                action: "SUBSCRIBE",
                symbol,
                GAP,
                ECLIPSE_BUFFER,
                volume
            });

            await DB.TRADE.create({
                symbol,
                gap: GAP,
                eclipseBuffer: ECLIPSE_BUFFER,
                volume,
                tradeBuffer,
            })

            return response.OK({ res, message: "Symbol subscribed successfully" });

        } else {
            // Remove from set
            await redis.srem(ACTIVE_SYMBOLS_KEY, symbol);

            // Remove symbol config hash
            await redis.del(`symbol_config:${symbol}`);

            // Remove checkpoints hash
            await redis.del(`checkpoint:${symbol}`);

            // Remove trade history list
            const { clearSymbolState } = require('../../service/strategy/strategy.service')
            clearSymbolState(symbol);

            // Send unsubscription message to DLL
            sendMessageToDLL({
                action: "UNSUBSCRIBE",
                symbol
            });

            // update isActive in DB
            await DB.TRADE.updateOne(
                { symbol, isActive: true },
                { $set: { isActive: false } }
            );

            return response.OK({ res, message: "Symbol unsubscribed successfully" });
        }
    },

    getTradeData: async (req, res) => {
        const activeSymbols = await DB.TRADE.find().sort({ createdAt: -1 }).lean();
        if (!activeSymbols || activeSymbols.length === 0) return response.NOT_FOUND({ res, message: "No Trade Data Found" });

        return response.OK({
            res,
            message: "Trade data fetched successfully",
            payload: activeSymbols,
        });
    },

    getTradeHistory: async (req, res) => {
        const { tradeId } = req.params;
        const tradeHistory = await DB.TRADE_HISTORY.find({ tradeId }).sort({ createdAt: 1 }).lean();
        if (!tradeHistory || tradeHistory.length === 0) return response.NOT_FOUND({ res, message: "No trade history found" });

        return response.OK({
            res,
            message: "Trade history fetched successfully",
            payload: tradeHistory,
        });
    }
};
