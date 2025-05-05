const Redis = require("ioredis");
const { logger } = require("../helpers");

// Create a single shared Redis instance
const redis = new Redis(); // defaults to 127.0.0.1:6379

redis.on("connect", () => {
    logger.info("✔ [Redis] Connected successfully");
});

redis.on("error", (err) => {
    logger.error("❌ [Redis] Connection error:", err);
});

// Optional: Utility functions for symbol config
const setSymbolConfig = async (symbol, config) => {
    await redis.hset(`symbol:${symbol}`, config);
};

const getSymbolConfig = async (symbol) => {
    return await redis.hgetall(`symbol:${symbol}`);
};

const deleteSymbolConfig = async (symbol) => {
    return await redis.del(`symbol:${symbol}`);
};

module.exports = {
    redis,
    setSymbolConfig,
    getSymbolConfig,
    deleteSymbolConfig,
};
