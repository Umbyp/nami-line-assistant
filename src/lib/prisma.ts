import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

export const prisma = new PrismaClient({
  log: env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace' ? ['warn', 'error'] : ['error'],
});
