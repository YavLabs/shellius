import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(
  process.env.REDIS_URL || {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  { maxRetriesPerRequest: null }
);

connection.on('error', (err) => {
  console.error('[queue/redis] Connection error:', err.message);
});

export function createQueue(name) {
  return new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 86400 * 7 },
    },
  });
}

export function createWorker(name, processor) {
  return new Worker(name, processor, { connection, concurrency: 1 });
}

export { connection };
