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
import storageRouter from './routes/storage.js';
import approvalsRouter from './routes/approvals.js';
import importRouter from './routes/import.js';
import mfaRouter, { configRouter as mfaConfigRouter } from './routes/mfa.js';
import cliRouter from './routes/cli.js';
import errorHandler from './middleware/errorHandler.js';
import { startAllJobs } from './jobs/index.js';

const app = express();

// Behind reverse proxies (internal nginx + any external proxy/load balancer),
// so honor X-Forwarded-* headers for real client IP + rate limiting. Configure
// the hop count via TRUST_PROXY (a number is safest; e.g. 2 for proxy-manager →
// internal nginx). Defaults to 1 in production, off in dev.
{
  const tp = process.env.TRUST_PROXY;
  if (tp !== undefined && tp !== '') {
    const n = Number(tp);
    app.set('trust proxy', Number.isNaN(n) ? tp : n);
  } else {
    app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);
  }
}

// 'same-origin-allow-popups' lets the SSO popup keep its window.opener after the
// cross-origin round-trip to the IdP (default 'same-origin' severs it, which
// breaks the popup → opener handoff and loads the app inside the popup).
app.use(helmet({ crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } }));
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
app.use('/api/settings/storage', storageRouter);
app.use('/api/approvals', approvalsRouter);
app.use('/api/import', importRouter);
app.use('/api/mfa', mfaRouter);
app.use('/api/settings/mfa', mfaConfigRouter);
app.use('/api/cli', cliRouter);

app.use(errorHandler);

// Start background jobs (non-blocking; errors are logged internally)
startAllJobs().catch((err) => {
  console.error('[app] Failed to start background jobs:', err.message);
});

export default app;
