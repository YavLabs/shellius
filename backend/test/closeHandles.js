// After each test file: close whatever Redis / queue / Prisma connections
// its imports opened (src/config/handles.js), so jest can exit on its own.
import { closeAll } from '../src/config/handles.js';

afterAll(async () => {
  await closeAll();
});
