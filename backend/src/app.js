import 'dotenv/config';

// Make BigInt JSON-serializable globally — Prisma returns Certificate.serial
// (and similar columns) as native BigInt, which JSON.stringify chokes on.
// Serialize as string so the frontend gets a stable representation.
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function () {
  return this.toString();
};

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config from './config/index.js';
import healthRouter from './routes/health.js';
import metricsRouter, { httpRequestCounter } from './routes/metrics.js';
import authRouter from './routes/auth.js';
import ssoRouter from './routes/sso.js';
import deviceAuthRouter from './routes/deviceAuth.js';
import usersRouter from './routes/users.js';
import groupsRouter from './routes/groups.js';
import customersRouter from './routes/customers.js';
import serversRouter from './routes/servers.js';
import certificatesRouter from './routes/certificates.js';
import caRouter from './routes/ca.js';
import policiesRouter from './routes/policies.js';
import accessRequestsRouter from './routes/accessRequests.js';
import notificationsRouter from './routes/notifications.js';
import sessionsRouter from './routes/sessions.js';
import auditRouter from './routes/audit.js';
import bootstrapRouter from './routes/bootstrap.js';
import hostsRouter from './routes/hosts.js';
import orgRouter from './routes/org.js';
import smtpRouter from './routes/smtp.js';
import cliRouter from './routes/cli.js';
import errorHandler from './middleware/errorHandler.js';
import { startAllJobs } from './jobs/index.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Prometheus HTTP request counter — runs after body parsing, before routes
app.use((req, res, next) => {
  res.on('finish', () => {
    const route = req.route?.path ?? req.path ?? 'unknown';
    httpRequestCounter.labels(req.method, route, String(res.statusCode)).inc();
  });
  next();
});

app.use('/api', healthRouter);
app.use('/api', metricsRouter);
app.use('/api/auth', authRouter);
app.use('/api/auth/sso', ssoRouter);
app.use('/api/auth/device', deviceAuthRouter);
app.use('/api/users', usersRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/servers', serversRouter);
app.use('/api/certificates', certificatesRouter);
app.use('/api/ca', caRouter);
app.use('/api/policies', policiesRouter);
app.use('/api/access-requests', accessRequestsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/bootstrap', bootstrapRouter);
app.use('/api/hosts', hostsRouter);
app.use('/api/org', orgRouter);
app.use('/api/settings/smtp', smtpRouter);
app.use('/api/cli', cliRouter);

app.use(errorHandler);

// Start background jobs (non-blocking; errors are logged internally)
startAllJobs().catch((err) => {
  console.error('[app] Failed to start background jobs:', err.message);
});

export default app;
