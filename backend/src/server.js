import http from 'http';
import app from './app.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import prisma from './config/db.js';
import redis from './config/redis.js';
import { registerHealthCheckJob, startHealthCheckWorker } from './jobs/healthCheck.js';
import { attachWebSocketServer } from './services/terminalService.js';
import * as storageService from './services/storageService.js';

const httpServer = http.createServer(app);
attachWebSocketServer(httpServer);

const server = httpServer.listen(config.port, async () => {
  logger.info(`Server running on port ${config.port} [${config.nodeEnv}]`);
  try {
    await registerHealthCheckJob();
    startHealthCheckWorker();
  } catch (err) {
    logger.error('Failed to initialize health check job:', err.message);
  }
  // Best-effort MinIO bucket provisioning for session recordings.
  // Non-fatal on failure — the backend still serves other routes and the
  // web terminal falls back to silent no-op recording writer.
  if (storageService.isConfigured()) {
    try {
      await storageService.ensureBucket();
      logger.info(`Recordings bucket ready: ${storageService.recordingsBucket()}`);
    } catch (err) {
      logger.warn('storageService.ensureBucket failed (recordings disabled):', err.message);
    }
  } else {
    logger.warn('MinIO not configured — session recording will be disabled');
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
