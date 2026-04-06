import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a notification for a user.
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.userId
 * @param {string} params.type       - NotificationType enum value
 * @param {string} params.title
 * @param {string} params.body
 * @param {object} [params.metadata]
 * @returns {Promise<object>}
 */
export async function create({ orgId, userId, type, title, body, metadata = {} }) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!userId) throw new ApiError(400, 'userId is required');
  if (!type) throw new ApiError(400, 'type is required');
  if (!title) throw new ApiError(400, 'title is required');
  if (!body) throw new ApiError(400, 'body is required');

  const notification = await prisma.notification.create({
    data: {
      orgId,
      userId,
      type,
      title,
      body,
      metadata,
    },
  });

  logger.info('notificationService.create: notification created', {
    orgId,
    userId,
    type,
    notificationId: notification.id,
  });

  return notification;
}

/**
 * List notifications for a user (paginated).
 *
 * @param {object} params
 * @param {string}  params.userId
 * @param {boolean} [params.isRead]   - Filter by read status when provided
 * @param {number}  [params.page=1]
 * @param {number}  [params.limit=25]
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export async function list({ userId, isRead, page = 1, limit = 25 }) {
  if (!userId) throw new ApiError(400, 'userId is required');

  page = parseInt(page, 10) || 1;
  limit = Math.min(parseInt(limit, 10) || 25, 100);

  const where = { userId };
  if (isRead !== undefined && isRead !== null) {
    where.isRead = isRead === true || isRead === 'true';
  }

  const [items, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.notification.count({ where }),
  ]);

  return { items, total, page, limit };
}

/**
 * Mark a single notification as read. Scoped to the owning user.
 *
 * @param {string} notificationId
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function markRead(notificationId, userId) {
  if (!notificationId) throw new ApiError(400, 'notificationId is required');
  if (!userId) throw new ApiError(400, 'userId is required');

  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
  });

  if (!notification) throw new ApiError(404, 'Notification not found');
  if (notification.isRead) return notification; // already read — no-op

  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { isRead: true, readAt: new Date() },
  });

  return updated;
}

/**
 * Mark all notifications for a user as read.
 *
 * @param {string} userId
 * @returns {Promise<{ count: number }>}
 */
export async function markAllRead(userId) {
  if (!userId) throw new ApiError(400, 'userId is required');

  const now = new Date();
  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: now },
  });

  logger.info('notificationService.markAllRead', { userId, count: result.count });
  return { count: result.count };
}

/**
 * Return the count of unread notifications for a user.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function unreadCount(userId) {
  if (!userId) throw new ApiError(400, 'userId is required');
  return prisma.notification.count({ where: { userId, isRead: false } });
}

export default { create, list, markRead, markAllRead, unreadCount };
