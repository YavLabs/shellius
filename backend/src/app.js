import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config from './config/index.js';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import ssoRouter from './routes/sso.js';
import deviceAuthRouter from './routes/deviceAuth.js';
import usersRouter from './routes/users.js';
import groupsRouter from './routes/groups.js';
import customersRouter from './routes/customers.js';
import serversRouter from './routes/servers.js';
import certificatesRouter from './routes/certificates.js';
import caRouter from './routes/ca.js';
import errorHandler from './middleware/errorHandler.js';
import { startAllJobs } from './jobs/index.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/auth/sso', ssoRouter);
app.use('/api/auth/device', deviceAuthRouter);
app.use('/api/users', usersRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/servers', serversRouter);
app.use('/api/certificates', certificatesRouter);
app.use('/api/ca', caRouter);

app.use(errorHandler);

// Start background jobs (non-blocking; errors are logged internally)
startAllJobs().catch((err) => {
  console.error('[app] Failed to start background jobs:', err.message);
});

export default app;
