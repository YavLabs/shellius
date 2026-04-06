import express from 'express';
import Joi from 'joi';
import fs from 'fs';
import path from 'path';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import logger from '../utils/logger.js';
import * as sessionService from '../services/sessionService.js';
import { terminateSession } from '../services/terminalService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const validateQuery = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.query, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.query = value;
  next();
};

const SESSION_STATUSES = ['ACTIVE', 'ENDED', 'TERMINATED'];

const listQuerySchema = Joi.object({
  userId: Joi.string(),
  serverId: Joi.string(),
  status: Joi.string().valid(...SESSION_STATUSES),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// All routes require JWT auth + tenant context
// ---------------------------------------------------------------------------

router.use(authenticate, tenant);

// ---------------------------------------------------------------------------
// GET /api/sessions — operator+; list with filters
// ---------------------------------------------------------------------------

router.get(
  '/',
  requireRole('super_admin', 'admin', 'operator'),
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const result = await sessionService.list({
      orgId: req.orgId,
      userId: req.query.userId,
      serverId: req.query.serverId,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// GET /api/sessions/active — operator+; all currently active sessions
// ---------------------------------------------------------------------------

router.get(
  '/active',
  requireRole('super_admin', 'admin', 'operator'),
  asyncHandler(async (req, res) => {
    const sessions = await sessionService.listActive(req.orgId);
    res.json({ success: true, data: { sessions, total: sessions.length } });
  })
);

// ---------------------------------------------------------------------------
// GET /api/sessions/:id — operator+; session detail
// ---------------------------------------------------------------------------

router.get(
  '/:id',
  requireRole('super_admin', 'admin', 'operator'),
  asyncHandler(async (req, res) => {
    const session = await sessionService.getById(req.orgId, req.params.id);
    res.json({ success: true, data: { session } });
  })
);

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/recording — operator+; stream the .cast file
// ---------------------------------------------------------------------------

router.get(
  '/:id/recording',
  requireRole('super_admin', 'admin', 'operator'),
  asyncHandler(async (req, res) => {
    const session = await sessionService.getById(req.orgId, req.params.id);

    if (!session.recordingPath) {
      throw new ApiError(404, 'No recording available for this session');
    }

    const absPath = path.resolve(session.recordingPath);

    // Verify the file exists on disk
    try {
      await fs.promises.access(absPath, fs.constants.R_OK);
    } catch {
      throw new ApiError(404, 'Recording file not found on disk');
    }

    const filename = `session-${session.id}.cast`;
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);

    const fileStream = fs.createReadStream(absPath);
    fileStream.on('error', (err) => {
      // Headers may already be sent; log and destroy
      logger.warn('sessions: recording stream error', { sessionId: session.id, error: err.message });
      res.destroy(err);
    });
    fileStream.pipe(res);
  })
);

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/terminate — admin+; force disconnect
// ---------------------------------------------------------------------------

router.post(
  '/:id/terminate',
  requireRole('super_admin', 'admin'),
  audit('session.terminate', 'Session'),
  asyncHandler(async (req, res) => {
    // terminateSession updates DB and force-closes in-memory WS/SSH handles
    const session = await terminateSession(req.params.id, req.user.userId);
    res.json({ success: true, data: { session } });
  })
);

export default router;
