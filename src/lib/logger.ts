import pino from 'pino';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'nami' },
  // อย่า log ของที่ระบุตัวบุคคล/ความลับลงไปเต็มๆ
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-line-signature"]',
      'LINE_CHANNEL_ACCESS_TOKEN',
      'LINE_CHANNEL_SECRET',
      'ANTHROPIC_API_KEY',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
