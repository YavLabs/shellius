import { Router } from 'express';
import client from 'prom-client';

const router = Router();

// Collect default Node.js metrics (event loop lag, heap, GC, etc.)
client.collectDefaultMetrics({ prefix: 'shellius_' });

// Counter: total HTTP requests labelled by method, route, and status code
export const httpRequestCounter = new client.Counter({
  name: 'shellius_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
});

/**
 * GET /api/metrics
 *
 * Returns Prometheus text-format metrics.  Access is controlled by the
 * METRICS_TOKEN environment variable:
 *   - If METRICS_TOKEN is set, the request must carry an Authorization header
 *     of the form "Bearer <token>".
 *   - If METRICS_TOKEN is not set the endpoint responds with 404 so it is not
 *     accidentally discoverable in environments that skipped the env var.
 */
router.get('/metrics', async (req, res) => {
  const metricsToken = process.env.METRICS_TOKEN;

  // Endpoint is disabled when no token is configured
  if (!metricsToken) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
  }

  const authHeader = req.headers['authorization'] ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (provided !== metricsToken) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing metrics token' } });
  }

  try {
    const metrics = await client.register.metrics();
    res.set('Content-Type', client.register.contentType);
    res.status(200).send(metrics);
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'METRICS_ERROR', message: 'Failed to collect metrics' } });
  }
});

export default router;
