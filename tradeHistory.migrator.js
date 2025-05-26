const DB = require("./models");
const { redis } = require("./config/redis.config");

const TRADE_HISTORY_QUEUE = "queue:trade_history";

async function migrateTradeHistoryBatch(batchSize = 20) {
    try {
        const items = await redis.lrange(TRADE_HISTORY_QUEUE, 0, batchSize - 1);

        if (!items || items.length === 0) return;

        const parsedItems = items.map(item => JSON.parse(item)).filter(i => i.accountId && i.symbol);

        // Group trade entries by accountId
        const groupedByAccount = parsedItems.reduce((acc, item) => {
            if (!acc[item.accountId]) acc[item.accountId] = [];
            acc[item.accountId].push(item);
            return acc;
        }, {});

        const finalDocs = [];

        for (const [accountId, trades] of Object.entries(groupedByAccount)) {
            const symbols = [...new Set(trades.map(t => t.symbol))];

            const tradeDocs = await DB.TRADE.find({
                accountId,
                symbol: { $in: symbols },
                isActive: true
            });

            const symbolToTradeId = {};
            for (const trade of tradeDocs) {
                symbolToTradeId[trade.symbol] = trade._id;
            }

            for (const trade of trades) {
                const tradeId = symbolToTradeId[trade.symbol];
                if (!tradeId) continue;

                finalDocs.push({
                    tradeId,
                    price: trade.price,
                    action: trade.action,
                    direction: trade.direction,
                    checkpoint: trade.checkpoint,
                    createdAt: trade.createdAt,
                });
            }
        }

        if (finalDocs.length > 0) {
            await DB.TRADE_HISTORY.insertMany(finalDocs, { ordered: false });
        }

        await redis.ltrim(TRADE_HISTORY_QUEUE, parsedItems.length, -1);

        console.log(`✅ Migrated ${finalDocs.length} trade history records to MongoDB.`);
    } catch (err) {
        console.error("❌ Error in migrateTradeHistoryBatch:", err);
    }
}

// Run every 5 seconds
setInterval(() => {
    migrateTradeHistoryBatch(20);
}, 5000);
