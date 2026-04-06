import app from './app.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import prisma from './config/db.js';
import redis from './config/redis.js';
import { registerHealthCheckJob, startHealthCheckWorker } from './jobs/healthCheck.js';

const server = app.listen(config.port, async () => {
  logger.info(`Server running on port ${config.port} [${config.nodeEnv}]`);
  try {
    await registerHealthCheckJob();
    startHealthCheckWorker();
  } catch (err) {
    logger.error('Failed to initialize health check job:', err.message);
  }
});

const shutdown = async (signal) => {
  logger.info(`${signal} received — shutting down gracefully`);

  server.close(async () => {
    await prisma.$disconnect();
    redis.disconnect();
    logger.info('All connections closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
