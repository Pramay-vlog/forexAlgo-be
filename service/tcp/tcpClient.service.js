const net = require("net");
const { logger } = require("../../helpers");
const { handlePriceUpdate } = require("../strategy/strategy.service");

const TCP_PORT = 5050;

function startTCPServer() {
  const server = net.createServer((socket) => {
    logger.info("📡 [TCP] DLL connected.");

    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();

      const parts = buffer.split("\n");
      buffer = parts.pop();

      for (let msg of parts) {
        try {
          const sanitized = msg.replace(/\0/g, "").trim();
          if (sanitized) {
            const json = JSON.parse(sanitized);
            handlePriceUpdate(json);
          }
        } catch (err) {
          logger.error("❌ JSON parse error:", err.message);
        }
      }
    });

    socket.on("close", () => {
      logger.warn("❌ [TCP] DLL disconnected.");
    });

    socket.on("error", (err) => {
      logger.error("⚠️ [TCP] Error:", err.message);
    });

    // Expose the active socket globally
    global.dllSocket = socket;
  });

  server.listen(TCP_PORT, "0.0.0.0", () => {
    logger.info(`🚀 [TCP] Server listening on 0.0.0.0:${TCP_PORT}`);
  });
}

function sendMessageToDLL(jsonObject) {
  const socket = global.dllSocket;
  if (socket && !socket.destroyed) {
    const message = JSON.stringify(jsonObject);
    socket.write(message + "\n");
    logger.info(`➡️ [TCP] Sent to DLL: ${message}`);
    return true;
  } else {
    logger.error("❌ [TCP] No DLL connection to send message.");
    return false;
  }
}

module.exports = {
  startTCPServer,
  sendMessageToDLL
};
