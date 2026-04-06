import { PrismaClient } from '@prisma/client';
import config from './index.js';

const prisma = new PrismaClient({
  log: config.nodeEnv === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
});

if (config.nodeEnv === 'development') {
  console.log('[prisma] Connected in development mode');
}

export default prisma;
