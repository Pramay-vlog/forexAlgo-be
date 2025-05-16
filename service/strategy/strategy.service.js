const { redis } = require("../../config/redis.config");
const { logger } = require("../../helpers");

const RANGE = 5;
const TRADE_HISTORY_QUEUE = "queue:trade_history";

function roundTo3(num) {
    return parseFloat(num.toFixed(3));
}

function floorCheckpoint(price) {
    return Math.floor(price);
}

function generateCheckpointRangeFromPrice(price, gap) {
    const base = Math.floor(price / gap) * gap;
    const prevs = Array.from({ length: RANGE }, (_, i) => base - gap * (i + 1)).reverse();
    const nexts = Array.from({ length: RANGE }, (_, i) => base + gap * (i + 1));
    return { prevs, nexts };
}

function findClosestLevels(price, prevs, nexts) {
    if (nexts.includes(price)) return { cp: price, direction: "BUY" };
    if (prevs.includes(price)) return { cp: price, direction: "SELL" };

    if (price < Math.min(...prevs)) return { cp: prevs[0], direction: "SELL" };
    if (price > Math.max(...nexts)) return { cp: nexts[nexts.length - 1], direction: "BUY" };

    const lowerNext = nexts.filter(n => n < price).at(-1);
    if (lowerNext) return { cp: lowerNext, direction: "BUY" };

    const upperPrev = prevs.find(p => p > price);
    if (upperPrev) return { cp: upperPrev, direction: "SELL" };

    return { cp: null, direction: null };
}

async function sendTrade(symbol, price, direction) {
    try {
        const [symbolConfig, checkpoint] = await Promise.all([
            redis.hgetall(`symbol_config:${symbol}`),
            redis.hgetall(`checkpoint:${symbol}`)
        ]);

        const GAP = parseFloat(symbolConfig.GAP) || 0;
        const ECLIPSE_BUFFER = parseFloat(symbolConfig.ECLIPSE_BUFFER) || 0;
        const volume = parseFloat(symbolConfig.volume) || 0.1;

        const nonce = Math.floor(Math.random() * 1000000).toString(36).substring(2, 10);

        const message = {
            type: "trade",
            symbol: symbolConfig.symbol || symbol,
            action: direction,
            price,
            GAP,
            ECLIPSE_BUFFER,
            checkpoint: parseFloat(checkpoint.current) || 0,
            initialTraded: checkpoint.initialTraded === "1",
            direction: checkpoint.direction || "",
            nonce,
            volume
        };

        await redis.rpush(TRADE_HISTORY_QUEUE, JSON.stringify({
            symbol,
            price,
            action: direction,
            direction: checkpoint.direction || "",
            checkpoint: parseFloat(checkpoint.current) || 0,
            createdAt: new Date()
        }));

        const { sendMessageToDLL } = require("../tcp/tcpClient.service");
        sendMessageToDLL(message);

    } catch (err) {
        logger.error("❌ sendTrade Error:", err);
    }
}

async function handlePriceUpdate(data) {
    try {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        const { symbol, bid, ask, GAP: dynamicGAP, ECLIPSE_BUFFER: dynamicBuffer } = parsed;

        if (!symbol || typeof bid !== "number") return;

        const buyPrice = roundTo3(ask);
        const price = roundTo3(bid);
        const gap = dynamicGAP > 0 ? dynamicGAP : 2;
        const eclipseBuffer = dynamicBuffer > 0 ? dynamicBuffer : 0.3;

        const redisKey = `checkpoint:${symbol}`;
        let redisCheckpoint = await redis.hgetall(redisKey);

        if (!redisCheckpoint || Object.keys(redisCheckpoint).length === 0) {
            await redis.hset(redisKey, {
                current: price,
                direction: "",
                initialTraded: 0
            });
            logger.info(`🟡 ${symbol}: Initialized checkpoint at ${price}`);
            return;
        }

        const current = parseFloat(redisCheckpoint.current);
        const direction = redisCheckpoint.direction;
        const initialTraded = redisCheckpoint.initialTraded === "1";
        const tradeBuffer = parseFloat(await redis.hget(`symbol_config:${symbol}`, "tradeBuffer")) || 0.10;

        const { prevs, nexts } = generateCheckpointRangeFromPrice(current, gap);
        const flooredPrice = floorCheckpoint(price);
        const { cp: closestCP, direction: cpDirection } = findClosestLevels(flooredPrice, prevs, nexts);

        const updateCheckpoint = async (updatedCP, newDirection, shouldTrade = true) => {
            const roundedCP = roundTo3(updatedCP);
            await redis.hset(redisKey, {
                current: roundedCP,
                direction: newDirection,
                initialTraded: 1
            });

            const tradePrice = newDirection === "BUY" ? buyPrice : price;
            const { prevs, nexts } = generateCheckpointRangeFromPrice(tradePrice, gap);
            const next = nexts[0];
            const prev = prevs.at(-1);

            const message = `🔁 ${symbol}: ${tradePrice} | 📍 Checkpoint: ${roundedCP} | ⬅️ Prev: ${prev} | ➡️ Next: ${next}`;
            if (shouldTrade) {
                logger.info(`${message} | ✅ Trade Triggered`);
                await sendTrade(symbol, tradePrice, newDirection);
            } else {
                logger.info(`${message} | ⏭️ Skipped (No Re-entry)`);
                await redis.rpush(TRADE_HISTORY_QUEUE, JSON.stringify({
                    symbol,
                    price: tradePrice,
                    action: "SKIP",
                    direction: newDirection,
                    checkpoint: roundedCP,
                    createdAt: new Date()
                }));
            }
        };

        // 🥇 Initial Trade Logic
        if (!initialTraded) {
            if (Math.abs(price - current) >= eclipseBuffer) {
                const initialDirection = price > current ? "BUY" : "SELL";
                const tradePrice = initialDirection === "BUY" ? buyPrice : price;
                const initialCP = roundTo3(tradePrice);
                await redis.hset(redisKey, {
                    current: initialCP,
                    direction: initialDirection,
                    initialTraded: 1
                });
                await redis.hset(`symbol_config:${symbol}`, {
                    symbol,
                    GAP: gap,
                    ECLIPSE_BUFFER: 0
                });

                const { prevs, nexts } = generateCheckpointRangeFromPrice(initialCP, gap);
                logger.info(`🥇 ${symbol}: ${tradePrice} | Initial Trade | CP: ${initialCP} | ⬅️ ${prevs.at(-1)} | ➡️ ${nexts[0]}`);
                await sendTrade(symbol, tradePrice, initialDirection);
            }
            return;
        }

        // 🔄 Reversal / Progression
        if (direction === "BUY") {
            if (closestCP && cpDirection === "BUY" && closestCP > current) {
                logger.warn(`🔃 ${symbol}: Advancing BUY checkpoint → ${closestCP}`);
                await updateCheckpoint(closestCP, "BUY", false);
            } else if (buyPrice < (current + tradeBuffer)) {
                logger.warn(`🔁 ${symbol}: Reversing to SELL | buyPrice ${buyPrice} < current + buffer (${current + tradeBuffer})`);
                await updateCheckpoint(price, "SELL", true);
            }
        } else if (direction === "SELL") {
            if (closestCP && cpDirection === "SELL" && closestCP < current) {
                logger.warn(`🔃 ${symbol}: Advancing SELL checkpoint → ${closestCP}`);
                await updateCheckpoint(closestCP, "SELL", false);
            } else if (price > (current - tradeBuffer)) {
                logger.warn(`🔁 ${symbol}: Reversing to BUY | price ${price} > current - buffer (${current - tradeBuffer})`);
                await updateCheckpoint(price, "BUY", true);
            }
        }

    } catch (err) {
        logger.error("❌ handlePriceUpdate Error:", err);
        logger.error("🧾 Offending Data:", data);
    }
}

module.exports = { handlePriceUpdate };
