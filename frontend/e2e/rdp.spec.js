import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const auth = JSON.parse(fs.readFileSync(path.join(__dirname, '.auth.json'), 'utf8'));
const API = process.env.E2E_API_URL || 'http://localhost:3001';

/**
 * Sign in through the real form. The password comes from the file the setup
 * script wrote; it is never a literal here and never reaches a log.
 */
async function signIn(page) {
  await page.goto('/login');

  // Two steps: the email is submitted first so the server can say whether
  // this account uses a password, SSO or a magic link, and only then is the
  // password field rendered.
  await page.locator('#email').fill(auth.email);
  await page.getByRole('button', { name: /^continue$/i }).click();

  const password = page.locator('#password');
  await expect(password).toBeVisible({ timeout: 20_000 });
  await password.fill(auth.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

/** The access token the app just stored, for talking to the API directly. */
async function tokenOf(page) {
  return page.evaluate(() => localStorage.getItem('accessToken'));
}

/**
 * How many sessions exist for our RDP server, by status.
 *
 * This is the load-bearing observation in this file. "One connection per
 * mount" is not something the DOM can show you — two tunnels render exactly
 * like one — so it is counted on the server instead.
 */
async function sessionsForServer(page, { status } = {}) {
  const token = await tokenOf(page);
  // `limit`, not `pageSize` — /api/sessions and /api/servers do not agree on
  // the name, and Joi silently drops the wrong one and applies its default of
  // 25. Filtering server-side rather than fetching everything and filtering
  // here keeps this correct as the session history grows past a page.
  const qs = new URLSearchParams({ serverId: auth.serverId, limit: '100' });
  if (status) qs.set('status', status);
  const res = await page.request.get(`${API}/api/sessions?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const items = body?.data?.items ?? body?.data?.sessions ?? [];
  return items.filter((s) => s.serverId === auth.serverId && s.sessionType === 'RDP');
}

/** Sessions currently live on the RDP server. */
const liveSessions = (page) => sessionsForServer(page, { status: 'ACTIVE' });

/**
 * Wait until the Guacamole display has actually drawn something.
 *
 * Retries through a refused connection. Windows is running one interactive
 * session for one account across this whole suite, and a logon arriving while
 * the previous session is still tearing down is simply refused — the pane
 * shows "Disconnected" with a Reconnect button. That is a property of the
 * target, not of the client, and a person hitting it would press Reconnect.
 *
 * The retry cannot hide the bug this suite exists for: "exactly one session
 * per mount" is counted server-side in its own test, and a retry there would
 * show up as an extra session rather than be smoothed over.
 */
async function waitForDesktop(page, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const reconnect = page.getByRole('button', { name: /reconnect/i });
    if (attempt > 1 && (await reconnect.count())) {
      await reconnect.click();
      await page.waitForTimeout(3_000);
    }
    try {
      await drawnSomething(page);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      // Give the remote side time to finish logging the last session off.
      await page.waitForTimeout(8_000);
    }
  }
}

async function drawnSomething(page) {
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // A canvas that exists but is entirely one colour is a connection that
  // opened and drew nothing — which is what a black "connected" screen is.
  await expect
    .poll(
      async () =>
        canvas.evaluate((el) => {
          const ctx = el.getContext('2d');
          if (!ctx || !el.width || !el.height) return 0;
          const { data } = ctx.getImageData(0, 0, Math.min(el.width, 300), Math.min(el.height, 300));
          const seen = new Set();
          for (let i = 0; i < data.length; i += 4) {
            seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
            if (seen.size > 12) break;
          }
          return seen.size;
        }),
      { timeout: 30_000, message: 'the RDP desktop never drew more than a flat colour' }
    )
    .toBeGreaterThan(3);
}

test.describe('RDP in a real browser', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    // Start from a clean slate: end anything still ACTIVE on this server, so a
    // previous run cannot make this one look like a double connection.
    const token = await tokenOf(page);
    let terminated = 0;
    for (const s of await liveSessions(page)) {
      if (s.status === 'ACTIVE') {
        terminated += 1;
        await page.request
          .post(`${API}/api/sessions/${s.id}/terminate`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          .catch(() => {});
      }
    }

    // Wait for the session to be gone on BOTH sides. Windows allows one
    // interactive session per user, so starting the next test while the last
    // one is still logged in means the new connection evicts the old — and
    // the failure looks exactly like the double-connection bug these tests
    // exist to detect. Asking for termination is not the same as it having
    // happened.
    await expect
      .poll(async () => (await liveSessions(page)).length, {
        timeout: 30_000,
        message: 'a previous session was still ACTIVE',
      })
      .toBe(0);
    // Windows takes noticeably longer to release a session that was cut off
    // than one the client closed politely, and a logon arriving too early is
    // simply refused. Terminating something here means the previous run left
    // a session behind, so wait properly; otherwise a short settle is enough.
    //
    // This is measured, not guessed: the first test in a run was the only one
    // that ever failed, and only when it had leftovers to clear.
    await page.waitForTimeout(terminated > 0 ? 20_000 : 3_000);
  });

  /**
   * THE regression test for commit 5acbd45.
   *
   * `connect()` is async and nothing cancelled an in-flight run, so React's
   * double mount opened two tunnels a second apart. Both logged into Windows
   * as the same account; Windows permits one interactive session per user, so
   * the second evicted the first and the tab the user was looking at died with
   * "Disconnected by other connection".
   *
   * One mount must produce exactly ONE session row.
   */
  test('mounting the RDP client opens exactly one connection', async ({ page }) => {
    // beforeEach guarantees nothing is live on this server, so anything here
    // was opened by this mount. Counting live sessions rather than diffing the
    // whole history keeps the assertion exact however long the history gets.
    expect(await liveSessions(page)).toHaveLength(0);

    await page.goto(`/terminal?requestId=${auth.requestId}`);

    // Deliberately NOT waitForDesktop: that retries by pressing Reconnect,
    // which opens a second connection on purpose and would fail this count for
    // the wrong reason. What is counted is how many connections one MOUNT
    // produces, which does not depend on Windows agreeing to draw.
    //
    // Waiting on the canvas is not enough either — the element exists whether
    // or not anything connected, so a refused logon would read as "one mount,
    // zero connections" and quietly look like a pass.
    await expect
      .poll(async () => (await liveSessions(page)).length, {
        timeout: 60_000,
        message:
          'no RDP session was created at all — the host refused the connection, ' +
          'which is an environment failure rather than a double-connection bug',
      })
      .toBeGreaterThanOrEqual(1);

    // Now give a second tunnel every chance to show up before counting.
    await page.waitForTimeout(6_000);

    expect(
      (await liveSessions(page)).length,
      'one mount must open exactly one connection — two would evict each other on Windows'
    ).toBe(1);
  });

  /**
   * The desktop is genuinely rendering, not merely connected. A black screen
   * with a moving cursor is what a broken H.264 build looks like, and it
   * reports as a healthy connection everywhere else.
   */
  test('the remote desktop actually renders', async ({ page }) => {
    await page.goto(`/terminal?requestId=${auth.requestId}`);
    await waitForDesktop(page);
    await expect(page.getByText(/disconnected by other connection/i)).toHaveCount(0);
  });

  /**
   * The keyboard fix, asserted precisely.
   *
   * `new Guacamole.Keyboard(document)` installed capture-phase listeners on
   * the whole document, so every keystroke anywhere on the page was consumed
   * by the remote desktop. Bound to the pane instead, a key event dispatched
   * outside it must be left alone.
   *
   * Events bubble upwards, so one dispatched on `document.body` cannot reach
   * a listener on a descendant — but it WOULD have reached a document-level
   * capture listener. `defaultPrevented` is therefore a direct read of which
   * of the two is installed.
   */
  test('the keyboard is bound to the pane, not to the document', async ({ page }) => {
    await page.goto(`/terminal?requestId=${auth.requestId}`);
    await waitForDesktop(page);

    // A listener on `document` in the BUBBLE phase runs after any handler on
    // the pane, so `defaultPrevented` tells us whether the keystroke was
    // taken — and by what. Real key presses, not synthesised events:
    // Guacamole's keyboard runs a small state machine over keydown/keypress
    // and an untrusted event does not drive it the same way, so a synthetic
    // one proves nothing either way.
    //
    // ArrowLeft rather than a letter, because Guacamole cannot know a
    // printable character's keysym until `keypress` and so does not decide at
    // `keydown`. A cursor key has a fixed keysym and is settled immediately,
    // which is what makes this assertion deterministic.
    await page.evaluate(() => {
      window.__keys = [];
      document.addEventListener('keydown', (e) => window.__keys.push(e.defaultPrevented), false);
    });

    const surface = page.locator('[role="application"]').first();
    await expect(surface).toBeVisible();
    await surface.focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);

    const onPane = await page.evaluate(() => {
      const seen = window.__keys;
      window.__keys = [];
      return seen;
    });
    expect(onPane.length, 'the keypress should have reached the page').toBeGreaterThan(0);
    expect(onPane.some(Boolean), 'a keystroke on the focused pane must be taken by the remote desktop').toBe(true);

    // Now with the pane not focused. Under the old `Guacamole.Keyboard(document)`
    // this was captured just the same, which is the bug.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);

    const offPane = await page.evaluate(() => window.__keys);
    expect(offPane.length, 'the keypress should have reached the page').toBeGreaterThan(0);
    expect(offPane.some(Boolean), 'a keystroke outside the pane must not be swallowed').toBe(false);
  });

  /**
   * The pane must be focusable at all — a plain div cannot hold focus, and
   * without focus the keyboard listener never fires.
   */
  test('the pane can hold focus', async ({ page }) => {
    await page.goto(`/terminal?requestId=${auth.requestId}`);

    // Deliberately does NOT wait for a drawn desktop: focusability is a
    // property of the mounted pane, and tying it to a live Windows logon
    // would make this assertion fail for reasons that have nothing to do
    // with what it is testing.
    const surface = page.locator('[role="application"]').first();
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(surface).toHaveAttribute('tabindex', '0');
    await surface.focus();
    await expect(surface).toBeFocused();
  });

  /**
   * Closing the tab must end the session rather than leaving it ACTIVE for the
   * reaper — a stale ACTIVE row blocks the next connection by looking like a
   * live one.
   */
  test('navigating away ends the session', async ({ page }) => {
    await page.goto(`/terminal?requestId=${auth.requestId}`);
    await waitForDesktop(page);

    await page.goto('/dashboard');

    await expect
      .poll(async () => (await liveSessions(page)).length, {
        timeout: 30_000,
        message: 'the session stayed ACTIVE after the client went away',
      })
      .toBe(0);
  });

  /**
   * Reloading is the other way a user produces two logins in quick succession
   * — and the one that is not StrictMode's fault, so it must hold in
   * production too.
   */
  test('a reload does not leave two live sessions behind', async ({ page }) => {
    await page.goto(`/terminal?requestId=${auth.requestId}`);
    await waitForDesktop(page);

    await page.reload();
    await waitForDesktop(page);
    await page.waitForTimeout(5_000);

    expect(
      (await liveSessions(page)).length,
      'a reload must replace the session, not duplicate it'
    ).toBe(1);
  });
});
