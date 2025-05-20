const { redis } = require("../../config/redis.config");
const { logger } = require("../../helpers");

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

async function sendTrade(symbol, price, direction) {
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
        logger.error("Error sending trade message:", err);
    }
}

const previousPriceMap = new Map();

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

        // Get last tick values from memory
        const previousTick = previousPriceMap.get(symbol) || {};
        const prevPrice = previousTick.price ?? price;
        const prevBuyPrice = previousTick.buyPrice ?? buyPrice;

        // Update immediately to reduce latency
        previousPriceMap.set(symbol, { price, buyPrice });

        let redisCheckpoint = await redis.hgetall(redisKey);
        if (!redisCheckpoint || Object.keys(redisCheckpoint).length === 0) {
            await redis.hset(redisKey, {
                // current: roundTo3(price),
                current: price,
                direction: "",
                initialTraded: 0
            });
            return;
        }

        const current = parseFloat(redisCheckpoint.current);
        const direction = redisCheckpoint.direction;
        const initialTraded = redisCheckpoint.initialTraded === "1";

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

            const message = `🔁 ${symbol}: ${tradePrice} | 🍭 Checkpoint: ${roundedCP} | ⬅️ Prev: ${prev} | ➡️ Next: ${next}`;
            if (shouldTrade) {
                logger.info(`✅ Trade Triggered | ${message}`);
                await sendTrade(symbol, tradePrice, newDirection);
            } else {
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

        // 🥇 Initial trade logic
        if (!initialTraded) {
            if (Math.abs(price - current) >= eclipseBuffer) {
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
                await sendTrade(symbol, tradePrice, initialDirection);
            }
            return;
        }

        // 🚦 Strategy Logic: Single checkpoint crossing
        const lastCheckpoint = parseFloat(redisCheckpoint.current);
        const lastDirection = redisCheckpoint.direction;

        // BUY logic: crossing upward
        if (price > lastCheckpoint && lastDirection !== "BUY") {
            logger.info(`📈 ${symbol} | Price: ${price} > CP: ${lastCheckpoint} | → BUY`);
            await redis.hset(redisKey, { direction: "BUY" });
            await sendTrade(symbol, buyPrice, "BUY");
        }

        // SELL logic: crossing downward
        else if (price < lastCheckpoint && lastDirection !== "SELL") {
            logger.info(`📉 ${symbol} | Price: ${price} < CP: ${lastCheckpoint} | → SELL`);
            await redis.hset(redisKey, { direction: "SELL" });
            await sendTrade(symbol, price, "SELL");
        }

        // const { prevs, nexts } = generateCheckpointRangeFromPrice(current, gap);
        // const { cp: closestCP, direction: cpDirection } = findClosestLevels(price, prevs, nexts);
        // const getTradeBuffer = await redis.hget(`symbol_config:${symbol}`, "tradeBuffer");
        // const tradeBuffer = parseFloat(getTradeBuffer) || 0.1;

        // const upperBound = current + tradeBuffer;
        // const lowerBound = current - tradeBuffer;

        // if (direction === "BUY") {
        //     const isTurningFromAbove =
        //         prevPrice > upperBound && price <= upperBound;

        //     const cond1 = isTurningFromAbove && buyPrice > current;
        //     const cond2 = price < current;

        //     if (closestCP && cpDirection === "BUY" && closestCP < current) {
        //         logger.warn('UPDATE CP BUY: Price >= Next CP');
        //         await updateCheckpoint(closestCP, "BUY", false);
        //     }

        //     // if (cond1 || cond2) {
        //     if (cond2) {
        //         logger.warn({
        //             event: "ENTER SELL",
        //             cond1: `turning from above: ${isTurningFromAbove} && buyPrice > current: ${buyPrice > current}`,
        //             cond2: `price < current: ${cond2}`,
        //             prevPrice,
        //             price,
        //             buyPrice,
        //             current,
        //             tradeBuffer
        //         });
        //         await updateCheckpoint(roundTo3(price), "SELL", true);
        //     }

        // } else if (direction === "SELL") {
        //     const isTurningFromBelow =
        //         prevBuyPrice < lowerBound && buyPrice >= lowerBound;

        //     const cond1 = isTurningFromBelow && buyPrice < current;
        //     const cond2 = buyPrice > current;

        //     if (closestCP && cpDirection === "SELL" && closestCP > current) {
        //         logger.warn('UPDATE CP SELL: Price <= Next CP');
        //         await updateCheckpoint(closestCP, "SELL", false);
        //     }

        //     // if (cond1 || cond2) {
        //     if (cond2) {
        //         logger.warn({
        //             event: "ENTER BUY",
        //             cond1: `turning from below: ${isTurningFromBelow} && buyPrice < current: ${buyPrice < current}`,
        //             cond2: `buyPrice > current: ${cond2}`,
        //             prevBuyPrice,
        //             buyPrice,
        //             current,
        //             tradeBuffer
        //         });
        //         await updateCheckpoint(roundTo3(buyPrice), "BUY", true);
        //     }
        // }

    } catch (err) {
        logger.error("handlePriceUpdate error:", data, "\n", err);
    }
}

function clearSymbolState(symbol) {
    previousPriceMap.delete(symbol);
}

module.exports = { handlePriceUpdate, clearSymbolState };
