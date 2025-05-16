const { redis } = require("../../config/redis.config");
const { logger } = require("../../helpers");

let RANGE = 5;
let GAP = 2;
let ECLIPSE_BUFFER = 0.30;
const TRADE_HISTORY_QUEUE = "queue:trade_history";

function roundTo3(num) {
    return parseFloat(num.toFixed(3));
}

function floorCheckpoint(price) {
    return Math.floor(price);
}

function generateCheckpointRangeFromPrice(price) {
    const base = Math.floor(price / GAP) * GAP;
    const prevs = Array.from({ length: RANGE }, (_, i) => base - GAP * (i + 1)).reverse();
    const nexts = Array.from({ length: RANGE }, (_, i) => base + GAP * (i + 1));
    return { prevs, nexts };
}

function findClosestLevels(price, prevs, nexts) {
    if (nexts.includes(price)) return { cp: price, direction: "BUY" };
    if (prevs.includes(price)) return { cp: price, direction: "SELL" };

    if (price < Math.min(...prevs)) return { cp: prevs[0], direction: "SELL" };
    if (price > Math.max(...nexts)) return { cp: nexts[nexts.length - 1], direction: "BUY" };

    const lowerNext = nexts.filter(n => n < price).at(-1);
    if (lowerNext) return { cp: lowerNext, direction: "BUY" };

    const upperPrev = prevs.filter(p => p > price)[0];
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
        console.error("❌ sendTrade Error:", err);
    }
}

async function handlePriceUpdate(data) {
    try {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        const { symbol, bid, ask, GAP: dynamicGAP, ECLIPSE_BUFFER: dynamicEclipseBuffer } = parsed;

        if (!symbol || typeof bid !== "number") return;

        if (typeof dynamicGAP === "number" && dynamicGAP > 0) GAP = dynamicGAP;
        if (typeof dynamicEclipseBuffer === "number" && dynamicEclipseBuffer > 0) ECLIPSE_BUFFER = dynamicEclipseBuffer;

        const buyPrice = roundTo3(ask);
        const price = roundTo3(bid);
        const redisKey = `checkpoint:${symbol}`;

        let redisCheckpoint = await redis.hgetall(redisKey);
        if (!redisCheckpoint || Object.keys(redisCheckpoint).length === 0) {
            await redis.hset(redisKey, {
                current: roundTo3(price),
                direction: "",
                initialTraded: 0
            });
            return;
        }

        const current = parseFloat(redisCheckpoint.current);
        const direction = redisCheckpoint.direction;
        const initialTraded = redisCheckpoint.initialTraded === "1";

        const { prevs, nexts } = generateCheckpointRangeFromPrice(current);

        const updateCheckpoint = async (updatedCP, newDirection, shouldTrade = true) => {
            await redis.hset(redisKey, {
                current: updatedCP,
                direction: newDirection,
                initialTraded: 1
            });

            const tradePrice = newDirection === "BUY" ? buyPrice : price;
            const { prevs, nexts } = generateCheckpointRangeFromPrice(tradePrice);
            const next = nexts[0];
            const prev = prevs[prevs.length - 1];

            logger.info(`🔁 ${symbol}: ${tradePrice} | Checkpoint Updated | Current: ${updatedCP} | Prev: ${prev} | Next: ${next}`);

            if (shouldTrade) {
                sendTrade(symbol, tradePrice, newDirection);
            } else {
                await redis.rpush(TRADE_HISTORY_QUEUE, JSON.stringify({
                    symbol,
                    price: tradePrice,
                    action: "SKIP",
                    direction: newDirection,
                    checkpoint: roundTo3(updatedCP),
                    createdAt: new Date()
                }));
                logger.info(`⏭️ ${symbol}: ${tradePrice} | Skip re-entry | Current: ${updatedCP}`);
            }
        };

        // Initial Trade
        if (!initialTraded) {
            if (Math.abs(price - current) >= ECLIPSE_BUFFER) {
                const initialDirection = price > current ? "BUY" : "SELL";
                const tradePrice = initialDirection === "BUY" ? buyPrice : price;
                const initialCP = tradePrice;
                await redis.hset(redisKey, {
                    current: initialCP,
                    direction: initialDirection,
                    initialTraded: 1
                });
                await redis.hset(`symbol_config:${symbol}`, {
                    symbol,
                    GAP: parseFloat(dynamicGAP) || 0,
                    ECLIPSE_BUFFER: 0
                });
                const { prevs, nexts } = generateCheckpointRangeFromPrice(initialCP);
                const next = nexts[0];
                const prev = prevs[prevs.length - 1];
                logger.info(`🥇 ${symbol}: ${tradePrice} | Initial Trade | Current: ${initialCP} | Prev: ${prev} | Next: ${next}`);
                sendTrade(symbol, tradePrice, initialDirection);
            }

            return;
        }

        if (!initialTraded) return;

        const flooredPrice = floorCheckpoint(price);
        const { cp: closestCP, direction: cpDirection } = findClosestLevels(flooredPrice, prevs, nexts);
        const getTradeBuffer = await redis.hget(`symbol_config:${symbol}`, "tradeBuffer");
        const tradeBuffer = parseFloat(getTradeBuffer) || 0.10;

        if (direction === "BUY") {
            if (closestCP && cpDirection === "BUY" && closestCP > current) {
                logger.warn('UPDATE CP BUY: Price >= Next CP');
                await updateCheckpoint(closestCP, "BUY", false); // No re-entry
            } else if (buyPrice < (current + tradeBuffer) || buyPrice < current) {
                if (buyPrice < (current + tradeBuffer)) {
                    logger.warn({
                        event: "ENTER SELL - BUFFER",
                        buyPrice,
                        current,
                        tradeBuffer,
                        condition: "buyPrice < (current + tradeBuffer)",
                        result: buyPrice < (current + tradeBuffer)
                    });
                } else {
                    logger.warn({
                        event: "ENTER SELL - NO BUFFER",
                        buyPrice,
                        current,
                        tradeBuffer,
                        condition: "buyPrice < current",
                        result: buyPrice < current
                    });
                }
                await updateCheckpoint(roundTo3(price), "SELL", true); // Reverse trade
            }

        } else if (direction === "SELL") {
            if (closestCP && cpDirection === "SELL" && closestCP < current) {
                logger.warn('UPDATE CP SELL: Price <= Prev CP');
                await updateCheckpoint(closestCP, "SELL", false); // No re-entry
            } else if (price > (current - tradeBuffer) || price > current) {
                if (price > (current - tradeBuffer)) {
                    logger.warn({
                        event: "ENTER BUY - BUFFER",
                        buyPrice,
                        current,
                        tradeBuffer,
                        condition: "price > (current - tradeBuffer)",
                        result: price > (current - tradeBuffer)
                    });
                } else {
                    logger.warn({
                        event: "ENTER BUY - NO BUFFER",
                        buyPrice,
                        current,
                        tradeBuffer,
                        condition: "price > (current - tradeBuffer)",
                        result: price > (current - tradeBuffer)
                    });
                }
                await updateCheckpoint(roundTo3(price), "BUY", true); // Reverse trade
            }
        }

    } catch (err) {
        console.error("❌ handlePriceUpdate Error:", err);
        console.error("Offending message:", data);
    }
}

module.exports = { handlePriceUpdate };
