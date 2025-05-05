const { format, transports, createLogger } = require('winston');

const colors = {
    error: '\x1b[31m', // red
    warn: '\x1b[33m', // yellow
    info: '\x1b[32m', // green
    debug: '\x1b[36m', // cyan
    verbose: '\x1b[35m', // magenta
};

function customLogger(level, message) {
    const color = colors[level] || '\x1b[0m';
    const logMessage = `${color}[${level.toUpperCase()}]: ${message}\x1b[0m`;

    return logMessage;
}

const logger = createLogger({
    level: 'debug',
    format: format.combine(
        format.json(),
        format.colorize({ all: true }),
        format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss:ms Z' }),
        format.ms(),
        format.errors({ stack: true }),
        format.printf(({ level, timestamp, stack, message, ms }) => {
            return customLogger(level, `[${timestamp}] ${stack || message} [${ms}]`);
        }),
    ),
    defaultMeta: { service: 'user-service' },
    handleExceptions: true,
    handleRejections: true,
    rejectionHandlers: [
        new transports.File({ filename: 'logs/exceptions.log' }),
    ],
    exceptionHandlers: [
        new transports.File({ filename: 'logs/exceptions.log' }),
    ],
    transports: [
        new transports.Console()
    ],
});

module.exports = logger
