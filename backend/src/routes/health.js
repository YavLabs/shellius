import { Router } from 'express';
import prisma from '../config/db.js';
import redis from '../config/redis.js';

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
      timestamp: new Date().toISOString(),
      db: dbStatus,
      redis: redisStatus,
    },
  });
});

export default router;
