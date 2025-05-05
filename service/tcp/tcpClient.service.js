const net = require("net");
const { logger } = require("../../helpers");
const { handlePriceUpdate } = require("../strategy/strategy.service");
const { redis } = require("../../config/redis.config");

const TCP_HOST = "127.0.0.1";
const TCP_PORT = 5050;

let client = null;

const ACTIVE_SYMBOLS_KEY = "active:symbols";

const tcpClient = {
  connectToDLL: () => {
    client = new net.Socket();

    client.connect(TCP_PORT, TCP_HOST, () => {
      logger.info(`✔ [TCP] Connected to DLL on ${TCP_HOST}:${TCP_PORT}`);
    });

    let buffer = "";

    client.on("data", (data) => {
      buffer += data.toString();

      const delimiter = "\n";
      const parts = buffer.split(delimiter);
      buffer = parts.pop();

      for (let message of parts) {
        const sanitized = message.replace(/\0/g, "").trim();

        try {
          if (sanitized) {
            const json = JSON.parse(sanitized);
            handlePriceUpdate(json);
          }
        } catch (e) {
          console.error("❌ JSON Parse Error:", e.message);
          console.error("Offending message:", sanitized);
        }
      }
    });

    client.on("close", () => {
      logger.warn("🛜 [TCP] Connection closed. Reconnecting...");
      setTimeout(() => tcpClient.connectToDLL(), 1000);
    });

    client.on("error", (err) => {
      logger.error(`❌ [TCP] Connection error: ${err.message}`);
    });
  },

  getClient: () => {
    if (!client) {
      logger.error("❌ [TCP] Client is not connected. Please connect first.");
      return null;
    }
    return client;
  },

  sendMessageToDLL: (jsonObject) => {
    const client = tcpClient.getClient();
    if (client && !client.destroyed) {
      const message = JSON.stringify(jsonObject);
      client.write(message + "\n");
      logger.info(`➡️ [TCP] Sent to DLL: ${message}`);
      return true;
    } else {
      logger.error("❌ [TCP] DLL connection not established!");
      return false;
    }
  },

  // Redis-backed symbol tracking
  addActiveSymbol: async (symbol) => {
    await redis.sadd(ACTIVE_SYMBOLS_KEY, symbol);
  },

  removeActiveSymbol: async (symbol) => {
    await redis.srem(ACTIVE_SYMBOLS_KEY, symbol);
  },

  isSymbolActive: async (symbol) => {
    return await redis.sismember(ACTIVE_SYMBOLS_KEY, symbol);
  },

  getActiveSymbols: async () => {
    return await redis.smembers(ACTIVE_SYMBOLS_KEY);
  },
};

module.exports = tcpClient;
