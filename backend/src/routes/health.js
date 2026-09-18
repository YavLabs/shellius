import { Router } from 'express';
import { createRequire } from 'module';
import prisma from '../config/db.js';
import redis from '../config/redis.js';

const require = createRequire(import.meta.url);
// Read once at module load — the version doesn't change without a restart.
const { version: APP_VERSION } = require('../../package.json');

const router = Router();

router.get('/health', async (req, res) => {
  let dbStatus = 'connected';
  let redisStatus = 'connected';

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = 'error';
  }

  try {
    await redis.ping();
  } catch {
    redisStatus = 'error';
  }

  res.json({
    success: true,
    data: {
      status: 'ok',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      db: dbStatus,
      redis: redisStatus,
    },
  });
});

// Lightweight endpoint for deploy tooling / status pages that don't want the
// DB + Redis round trips GET /health does.
router.get('/version', (req, res) => {
  res.json({ success: true, data: { version: APP_VERSION } });
});

export default router;
