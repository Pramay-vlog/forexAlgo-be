const net = require("net");
const { logger } = require("../../helpers");
const { handlePriceUpdate } = require("../strategy/strategy.service");

const TCP_PORT = 5050;
const HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds

function startTCPServer() {
  const server = net.createServer((socket) => {
    logger.info("📡 [TCP] DLL connected.");

    // ✅ Enable TCP keep-alive on socket
    socket.setKeepAlive(true, 60000); // Enable after 60 seconds of idle

    // ✅ Start heartbeat interval
    const heartbeatInterval = setInterval(() => {
      if (socket.destroyed) {
        clearInterval(heartbeatInterval);
        return;
      }

      const heartbeatMsg = JSON.stringify({ action: "HEARTBEAT", timestamp: Date.now() });
      socket.write(heartbeatMsg + "\n");
      logger.debug(`💓 [TCP] Sent heartbeat to DLL.`);
    }, HEARTBEAT_INTERVAL_MS);

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
      clearInterval(heartbeatInterval);
      logger.warn("❌ [TCP] DLL disconnected.");
    });

    socket.on("error", (err) => {
      clearInterval(heartbeatInterval);
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
