import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the things only a browser can prove.
 *
 * This suite exists because of a specific bug: an RDP pane opened TWO
 * connections, each logging into Windows as the same account, and Windows
 * evicted the first — so the session died the moment it started. Every unit
 * test passed. The headless protocol probe passed. It took a person with a
 * browser to see it, and that is not a reliable way to find the next one.
 *
 * So these tests drive a real Chromium against the running dev instance and a
 * real Windows host. They are NOT part of `npm test`: they need the stack up
 * and an RDP target reachable, and they take seconds rather than milliseconds.
 * Run them with `scripts/e2e-browser.sh`.
 */
export default defineConfig({
  testDir: './e2e',
  // One at a time. These share one Windows account, and Windows allows one
  // interactive session per user — parallel tests would evict each other and
  // the failures would look exactly like the bug being tested for.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // An RDP desktop needs somewhere to render.
    viewport: { width: 1600, height: 1000 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
