const DB = require("./models");
const { redis } = require("./config/redis.config");

const TRADE_HISTORY_QUEUE = "queue:trade_history";

async function migrateTradeHistoryBatch(batchSize = 20) {
    try {
        const items = await redis.lrange(TRADE_HISTORY_QUEUE, 0, batchSize - 1);

        if (!items || items.length === 0) return;

        const parsedItems = items.map(item => JSON.parse(item));

        const symbols = [...new Set(parsedItems.map(t => t.symbol))];
        const tradeDocs = await DB.TRADE.find({ symbol: { $in: symbols }, isActive: true });
        const symbolToIdMap = {};
        for (const trade of tradeDocs) {
            symbolToIdMap[trade.symbol] = trade._id;
        }

        const finalDocs = parsedItems.map(item => ({
            tradeId: symbolToIdMap[item.symbol],
            price: item.price,
            action: item.action,
            direction: item.direction,
            checkpoint: item.checkpoint,
            createdAt: item.createdAt,
        })).filter(doc => doc.tradeId); // Remove ones that don't match an active trade

        await DB.TRADE_HISTORY.insertMany(finalDocs, { ordered: false });
        await redis.ltrim(TRADE_HISTORY_QUEUE, items.length, -1);

        console.log(`✅ Migrated ${finalDocs.length} trade history records to MongoDB.`);
    } catch (err) {
        console.error("❌ Error in migrateTradeHistoryBatch:", err);
    }
}

// Run every 5 seconds
setInterval(() => {
    migrateTradeHistoryBatch(20);
}, 5000);
