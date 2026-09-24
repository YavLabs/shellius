// Per-test-file setup.
//
// 1. Load .env explicitly.
//
//    It used to arrive by accident: `@prisma/client` calls dotenv on import,
//    so any test file that imported `config/db.js` got DATABASE_URL *and*
//    REDIS_URL, and any file that did not, silently did not. `config/redis.js`
//    then fell back to 127.0.0.1:6379 — where nothing listens — and because
//    the client is configured with `maxRetriesPerRequest: null`, every command
//    it issued QUEUED rather than failing. A suite that touched Redis without
//    also importing Prisma hung instead of failing, and the symptom appeared
//    in this file's afterAll rather than anywhere near the cause.
//
//    Loading it here makes the environment the same for every test file,
//    whatever it happens to import.
//
// 2. Close whatever Redis / queue / Prisma connections its imports opened
//    (src/config/handles.js), so jest can exit on its own.
import { config as loadEnv } from 'dotenv';
import { closeAll } from '../src/config/handles.js';

loadEnv();

afterAll(async () => {
  await closeAll();
});
