const Redis = require("ioredis");
const { logger } = require("../helpers");
const env = require("../config/env.config");

const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null, // disables the 20-retry limit (be careful with this in prod)
    enableOfflineQueue: true,   // allows queueing commands while Redis is reconnecting
    reconnectOnError: (err) => {
        const targetError = "READONLY";
        if (err.message.includes(targetError)) {
            logger.warn("Reconnect on error: READONLY");
            return true; // try reconnecting
        }
        return false;
    },
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000); // exponential backoff up to 2 seconds
        logger.warn(`Retrying Redis connection in ${delay}ms`);
        return delay;
    },
});

redis.on("connect", () => {
    logger.info("✔ [Redis] Connected successfully");
});

redis.on("error", (err) => {
    logger.error("❌ [Redis] Connection error:", err);
});

module.exports = {
    redis
};
