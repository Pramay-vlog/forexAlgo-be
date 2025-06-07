const { redis } = require("../../config/redis.config");
const { logger } = require("../../helpers");
const { constants: { ENUM: { STRATEGY } } } = require('../../helpers');

let RANGE = 5;
const TRADE_HISTORY_QUEUE = "queue:trade_history";

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

async function sendTrade({ symbol, price, direction, strategy, reason = "signal", accountId }) {
    try {
        const [symbolConfig, checkpoint] = await Promise.all([
            redis.hgetall(`account:${accountId}:symbol_config:${symbol}`), // Update the key
            redis.hgetall(`account:${accountId}:checkpoint:${symbol}`) // Update the key
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
            reason
        };

        await redis.rpush(TRADE_HISTORY_QUEUE, JSON.stringify({
            symbol,
            price,
            action: direction,
            direction: checkpoint.direction || "",
            checkpoint: parseFloat(checkpoint.current) || 0,
            createdAt: new Date(),
            reason,
            accountId
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
        const { symbol, bid, ask, GAP: dynamicGAP, strategy, accountId } = parsed;

        if (!symbol || typeof bid !== "number" || typeof ask !== "number") return;
        if (!Object.values(STRATEGY).includes(strategy)) return;
        if (!accountId) {
            logger.error("Missing accountId in incoming price message");
            return;
        }

        const roundTo3 = num => parseFloat(num.toFixed(3));

        const rawBid = bid;
        const rawAsk = ask;

        const price = roundTo3(rawBid);
        const buyPrice = roundTo3(rawAsk);
        const gap = dynamicGAP > 0 ? dynamicGAP : 2;
        const redisKey = `account:${accountId}:checkpoint:${symbol}`;
        const configKey = `account:${accountId}:symbol_config:${symbol}`;

        const redisCheckpoint = await redis.hgetall(redisKey);
        const checkpointExists = redisCheckpoint && Object.keys(redisCheckpoint).length > 0;
        const current = parseFloat(redisCheckpoint.current);
        const direction = redisCheckpoint.direction;
        const initialTraded = redisCheckpoint.initialTraded === "1";

        // 🥇 Initial trade.
        if (!initialTraded) {
            const ECLIPSE_BUFFER = parseFloat(redisCheckpoint.ECLIPSE_BUFFER) || 0;

            // Fetch predefined direction for REVERSE strategy
            let initialDirection;
            if (strategy === STRATEGY.REVERSAL) {
                const redisSymbolConfig = await redis.hgetall(configKey);
                console.log('🚀 ~ handlePriceUpdate ~ redisSymbolConfig:', redisSymbolConfig);
                initialDirection = redisSymbolConfig?.direction;
                if (!initialDirection) {
                    logger.error(`⛔️ ${symbol}: Missing 'direction' in symbol_config for REVERSAL strategy.`);
                    return;
                }
            } else {
                // For STATIC or TRAILING, calculate direction only if eclipse buffer is crossed
                const bufferCrossed = Math.abs(price - current) >= ECLIPSE_BUFFER;

                if (checkpointExists && !bufferCrossed) {
                    logger.info(`🛑 ${symbol}: Waiting for eclipse buffer | Price: ${price} | CP: ${current} | Gap: ${gap} | Buffer: ${ECLIPSE_BUFFER}`);
                    return;
                }

                initialDirection = price > (checkpointExists ? current : price) ? "BUY" : "SELL";
            }

            const tradePrice = initialDirection === "BUY" ? buyPrice : price;

            // Compute initial checkpoint
            let initialCheckpoint;
            if (strategy === STRATEGY.REVERSAL) {
                initialCheckpoint = roundTo3(
                    initialDirection === "BUY"
                        ? tradePrice - gap
                        : tradePrice + gap
                );
            } else {
                initialCheckpoint = roundTo3(price);
            }

            // Set checkpoint state
            await redis.hset(redisKey, {
                current: initialCheckpoint,
                direction: initialDirection,
                initialTraded: 1
            });

            // Store config (preserve direction if from REVERSAL)
            await redis.hset(configKey, {
                symbol,
                GAP: gap,
                ECLIPSE_BUFFER: ECLIPSE_BUFFER || 0,
                ...(strategy === STRATEGY.REVERSAL && { direction: initialDirection })
            });

            const { prevs, nexts } = generateCheckpointRangeFromPrice(initialCheckpoint, gap);
            logger.info(`🥇 ${symbol}: ${tradePrice} | Initial Trade (${strategy}) | CP: ${initialCheckpoint} | Prev: ${prevs.at(-1)} | Next: ${nexts[0]}`);
            await sendTrade({ symbol, price: tradePrice, direction: initialDirection, strategy, reason: "initial", accountId });
            return;
        }

        if (strategy === STRATEGY.STATIC) {
            const lastCheckpoint = current;
            const lastDirection = direction;

            if (price > lastCheckpoint && lastDirection !== "BUY") {
                logger.info(`📈 ${symbol} | Price: ${price} > CP: ${lastCheckpoint} | → BUY`);
                await redis.hset(redisKey, { direction: "BUY" });
                await sendTrade({ symbol, price: buyPrice, direction: "BUY", strategy, accountId });
            } else if (price < lastCheckpoint && lastDirection !== "SELL") {
                logger.info(`📉 ${symbol} | Price: ${price} < CP: ${lastCheckpoint} | → SELL`);
                await redis.hset(redisKey, { direction: "SELL" });
                await sendTrade({ symbol, price, direction: "SELL", strategy, accountId });
            }
        }

        if (strategy === STRATEGY.TRAILING) {
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
                    await sendTrade({ symbol, price: tradePrice, direction: newDirection, strategy, accountId });
                } else {
                    await redis.rpush(TRADE_HISTORY_QUEUE, JSON.stringify({
                        symbol,
                        price: tradePrice,
                        action: "SKIP",
                        direction: newDirection,
                        checkpoint: roundedCP,
                        createdAt: new Date(),
                        accountId
                    }));
                }
            };

            const { prevs, nexts } = generateCheckpointRangeFromPrice(current, gap);
            const { cp: closestCP, direction: cpDirection } = findClosestLevels(price, prevs, nexts);

            if (direction === "BUY") {
                const cond = price < current;

                if (closestCP && cpDirection === "BUY" && closestCP < current) {
                    logger.warn('UPDATE CP BUY: Price >= Next CP');
                    await updateCheckpoint(closestCP, "BUY", false);
                }

                if (cond) {
                    logger.warn({ event: "ENTER SELL", cond, price, current });
                    await updateCheckpoint(price, "SELL", true);
                }
            } else if (direction === "SELL") {
                const cond = buyPrice > current;

                if (closestCP && cpDirection === "SELL" && closestCP > current) {
                    logger.warn('UPDATE CP SELL: Price <= Next CP');
                    await updateCheckpoint(closestCP, "SELL", false);
                }

                if (cond) {
                    logger.warn({ event: "ENTER BUY", cond, buyPrice, current });
                    await updateCheckpoint(buyPrice, "BUY", true);
                }
            }
        }

        if (strategy === STRATEGY.REVERSAL) {
            const reverseCheckpoint = current;

            // 🔁 Reversal logic
            if (direction === "BUY" && price <= reverseCheckpoint) {
                const nextCP = roundTo3(price + gap);
                await redis.hset(redisKey, {
                    current: nextCP,
                    direction: "SELL",
                    initialTraded: 1
                });
                logger.info(`🔄 ${symbol} | REVERSAL | BUY → SELL | Crossed: ${reverseCheckpoint} → New CP: ${nextCP}`);
                await sendTrade({ symbol, price, direction: "SELL", strategy, accountId });
                return;
            }

            if (direction === "SELL" && buyPrice >= reverseCheckpoint) {
                const nextCP = roundTo3(buyPrice - gap);
                await redis.hset(redisKey, {
                    current: nextCP,
                    direction: "BUY",
                    initialTraded: 1
                });
                logger.info(`🔄 ${symbol} | REVERSAL | SELL → BUY | Crossed: ${reverseCheckpoint} → New CP: ${nextCP}`);
                await sendTrade({ symbol, price: buyPrice, direction: "BUY", strategy, accountId });
                return;
            }

            // 🛠️ Maintain trailing CP only if deeper in same direction
            if (direction === "BUY") {
                const proposedCP = roundTo3(rawAsk - gap);
                if (proposedCP > reverseCheckpoint) {
                    logger.info(`🔧 ${symbol} | REVERSAL | Adjust CP → ${proposedCP}`);
                    await redis.hset(redisKey, {
                        current: proposedCP,
                        direction,
                        initialTraded: 1
                    });
                }
            } else if (direction === "SELL") {
                const proposedCP = roundTo3(rawBid + gap);
                if (proposedCP < reverseCheckpoint) {
                    logger.info(`🔧 ${symbol} | REVERSAL | Adjust CP → ${proposedCP}`);
                    await redis.hset(redisKey, {
                        current: proposedCP,
                        direction,
                        initialTraded: 1
                    });
                }
            }
        }

    } catch (err) {
        logger.error("handlePriceUpdate error:", err);
    }
}

module.exports = { handlePriceUpdate };
