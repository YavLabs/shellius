import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import * as notificationService from '../services/notificationService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const validateQuery = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.query, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.query = value;
  next();
};

// ---------------------------------------------------------------------------
// Joi schemas
// ---------------------------------------------------------------------------

const listQuerySchema = Joi.object({
  isRead: Joi.boolean(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// All routes require JWT auth + tenant extraction
// ---------------------------------------------------------------------------

router.use(authenticate, tenant);

// ---------------------------------------------------------------------------
// PATCH /api/notifications/read-all — any authenticated user
// Registered BEFORE /:id to avoid matching "read-all" as an id param
// ---------------------------------------------------------------------------

router.patch(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await notificationService.markAllRead(req.user.userId);
    res.json({ success: true, data: { markedRead: result.count } });
  })
);

// ---------------------------------------------------------------------------
// GET /api/notifications — any authenticated user; own notifications only
// ---------------------------------------------------------------------------

router.get(
  '/',
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const [result, unread] = await Promise.all([
      notificationService.list({
        userId: req.user.userId,
        isRead: req.query.isRead,
        page: req.query.page,
        limit: req.query.limit,
      }),
      notificationService.unreadCount(req.user.userId),
    ]);

    res.json({
      success: true,
      data: { notifications: result.items, unreadCount: unread },
      meta: { page: result.page, limit: result.limit, total: result.total },
    });
  })
);

// ---------------------------------------------------------------------------
// PATCH /api/notifications/:id/read — any authenticated user; own only
// ---------------------------------------------------------------------------

router.patch(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const notification = await notificationService.markRead(req.params.id, req.user.userId);
    res.json({ success: true, data: { notification } });
  })
);

export default router;
