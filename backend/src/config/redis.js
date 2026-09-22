import Redis from 'ioredis';
import config from './index.js';
import { trackHandle } from './handles.js';

const options = {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
};

// REDIS_URL wins (matches config/queue.js); fall back to host/port/password.
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, options)
  : new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      ...options,
    });

redis.on('error', (err) => {
  console.error('[redis] Connection error:', err.message);
});

redis.on('connect', () => {
  if (config.nodeEnv === 'development') {
    console.log('[redis] Connected');
  }
});

trackHandle(() => redis.quit().catch(() => redis.disconnect()));

export default redis;
