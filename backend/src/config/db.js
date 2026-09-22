import { PrismaClient } from '@prisma/client';
import config from './index.js';
import { trackHandle } from './handles.js';

const prisma = new PrismaClient({
  log: config.nodeEnv === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
});

if (config.nodeEnv === 'development') {
  console.log('[prisma] Connected in development mode');
}

trackHandle(() => prisma.$disconnect());

export default prisma;
