import { startServer } from './webhook/server.js';
import { logger } from './lib/logger.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { closeQueues } from './queue/queues.js';

async function main(): Promise<void> {
  const app = await startServer();
  logger.info({ port: env.PORT, tz: env.APP_TIMEZONE }, 'นามิ API พร้อมรับ webhook');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'กำลังปิด API...');
    await app.close();
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'API เริ่มไม่ได้');
  process.exit(1);
});
