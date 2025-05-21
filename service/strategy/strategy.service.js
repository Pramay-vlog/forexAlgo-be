const { redis } = require("../../config/redis.config");
const { logger } = require("../../helpers");
const { constants: { ENUM: { STRATEGY } } } = require('../../helpers')

let RANGE = 5;
const TRADE_HISTORY_QUEUE = "queue:trade_history";

function roundTo3(num) {
    return parseFloat(num.toFixed(3));
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

async function sendTrade(symbol, price, direction, strategy) {
    try {
        const [symbolConfig, checkpoint] = await Promise.all([
            redis.hgetall(`symbol_config:${symbol}`),
            redis.hgetall(`checkpoint:${symbol}`)
        ]);

        const GAP = parseFloat(symbolConfig.GAP) || 0;
        const ECLIPSE_BUFFER = parseFloat(symbolConfig.ECLIPSE_BUFFER) || 0;
        const volume = parseFloat(symbolConfig.volume) || 0.1;

        const nonce = Math.floor(Math.random() * 1e6).toString(36).substring(2, 10);

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
            volume,
            strategy,
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
        logger.error("Error sending trade message:", err);
    }
}

async function handlePriceUpdate(data) {
    try {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        const { symbol, bid, ask, GAP: dynamicGAP, strategy } = parsed;

        if (!symbol || typeof bid !== "number") return;
        if (!Object.values(STRATEGY).includes(strategy)) return;

        const buyPrice = roundTo3(ask);
        const price = roundTo3(bid);
        const gap = dynamicGAP > 0 ? dynamicGAP : 2;
        const redisKey = `checkpoint:${symbol}`;

        let redisCheckpoint = await redis.hgetall(redisKey);
        if (!redisCheckpoint || Object.keys(redisCheckpoint).length === 0) {
            await redis.hset(redisKey, {
                current: price || buyPrice,
                direction: "",
                initialTraded: 0
            });
            return;
        }

        const current = parseFloat(redisCheckpoint.current);
        const direction = redisCheckpoint.direction;
        const initialTraded = redisCheckpoint.initialTraded === "1";

        // 🥇 Initial trade logic
        if (!initialTraded) {
            const initialDirection = price > current ? "BUY" : "SELL";
            const tradePrice = initialDirection === "BUY" ? buyPrice : price;
            const initialCP = roundTo3(price);
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
            logger.info(`🥇 ${symbol}: ${tradePrice} | Initial Trade | Current: ${initialCP} | Prev: ${prevs.at(-1)} | Next: ${nexts[0]}`);
            await sendTrade(symbol, tradePrice, initialDirection, strategy);
            return;
        }

        if (strategy === STRATEGY.STATIC) {
            // 🚦 Strategy Logic: Single checkpoint crossing
            const lastCheckpoint = parseFloat(redisCheckpoint.current);
            const lastDirection = redisCheckpoint.direction;

            // BUY logic: crossing upward
            if (price > lastCheckpoint && lastDirection !== "BUY") {
                logger.info(`📈 ${symbol} | Price: ${price} > CP: ${lastCheckpoint} | → BUY`);
                await redis.hset(redisKey, { direction: "BUY" });
                await sendTrade(symbol, buyPrice, "BUY", strategy);
            }

            // SELL logic: crossing downward
            else if (price < lastCheckpoint && lastDirection !== "SELL") {
                logger.info(`📉 ${symbol} | Price: ${price} < CP: ${lastCheckpoint} | → SELL`);
                await redis.hset(redisKey, { direction: "SELL" });
                await sendTrade(symbol, price, "SELL", strategy);
            }
        }

        if (strategy === STRATEGY.TRAILING) {
            const dedupKey = `dedup:${symbol}`;
            const currentCP = roundTo3(current);
            const dedupValue = `${currentCP}|${direction}`;
            const lastValue = await redis.get(dedupKey);
            if (lastValue === dedupValue) return; // Skip duplicate trade

            const updateCheckpoint = async (updatedCP, newDirection, shouldTrade = true) => {
                const roundedCP = roundTo3(updatedCP);

                // Update Redis checkpoint regardless
                await redis.hset(redisKey, {
                    current: roundedCP,
                    direction: newDirection,
                    initialTraded: 1
                });

                if (!shouldTrade) return;

                // Only send trade if not duplicate
                const newDedupValue = `${roundedCP}|${newDirection}`;
                if (lastValue === newDedupValue) {
                    logger.warn(`⛔ Duplicate trade skipped for ${symbol} | CP: ${roundedCP} | Dir: ${newDirection}`);
                    return;
                }

                const tradePrice = newDirection === "BUY" ? buyPrice : price;
                logger.info(`✅ Trade Triggered | ${symbol} @ ${tradePrice} → ${newDirection} | CP: ${roundedCP}`);
                await sendTrade(symbol, tradePrice, newDirection, strategy);
                await redis.set(dedupKey, newDedupValue); // Save dedup state
            };

            const { prevs, nexts } = generateCheckpointRangeFromPrice(current, gap);
            const { cp: closestCP, direction: cpDirection } = findClosestLevels(price, prevs, nexts);

            if (direction === "BUY") {
                // If price dropped, reverse to SELL
                if (price < current) {
                    logger.info(`↩️ Reverse detected: BUY → SELL | Price: ${price} < CP: ${current}`);
                    await updateCheckpoint(price, "SELL", true);  // ⬅️ This is a new SELL entry
                }

                // Shift checkpoint upwards if price moved up but didn't reverse
                else if (closestCP && cpDirection === "BUY" && closestCP > current) {
                    logger.info(`🔄 Shift CP up (BUY): ${current} → ${closestCP}`);
                    await updateCheckpoint(closestCP, "BUY", false);  // No trade, only update CP
                }

            } else if (direction === "SELL") {
                // If price rose, reverse to BUY
                if (buyPrice > current) {
                    logger.info(`↩️ Reverse detected: SELL → BUY | Price: ${buyPrice} > CP: ${current}`);
                    await updateCheckpoint(buyPrice, "BUY", true);  // ⬅️ This is a new BUY entry
                }

                // Shift checkpoint downwards if price dropped but didn't reverse
                else if (closestCP && cpDirection === "SELL" && closestCP < current) {
                    logger.info(`🔄 Shift CP down (SELL): ${current} → ${closestCP}`);
                    await updateCheckpoint(closestCP, "SELL", false);  // No trade, only update CP
                }
            }
        }

    } catch (err) {
        logger.error("handlePriceUpdate error:", err);
    }
}

module.exports = { handlePriceUpdate };
