const winston = require('winston');

const { combine, timestamp, errors, printf, colorize, simple } = winston.format;

const logFormat = printf(({ timestamp: ts, level, message, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${level.toUpperCase()}] ${stack || message}${metaStr}`;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    logFormat,
  ),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), simple()),
    }),
  ],
});

// In production you might add a file transport:
// if (process.env.NODE_ENV === 'production') {
//   logger.add(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }));
//   logger.add(new winston.transports.File({ filename: 'logs/combined.log' }));
// }

module.exports = logger;
