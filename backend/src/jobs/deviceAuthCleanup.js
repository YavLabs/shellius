import prisma from '../config/db.js';
import logger from '../utils/logger.js';

export async function cleanupExpiredDeviceAuthRequests() {
  const deleted = await prisma.deviceAuthRequest.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  logger.info(`Cleaned up ${deleted.count} expired device auth requests`);
  return deleted.count;
}

export default cleanupExpiredDeviceAuthRequests;
