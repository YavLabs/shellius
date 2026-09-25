import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The SSH terminal workspace, driven in a real browser against real sshd.
 *
 * Everything here is asserted on what a person would see: text on the
 * screen, which host's prompt is in which pane, whether an editor's screen
 * replaced the shell's and whether the shell's came back. The one thing the
 * screen cannot show — whether a Session row exists and what state it is in
 * — is read from the API, the same way rdp.spec.js does.
 *
 * Targets: three throwaway Debian containers (docker-compose.dev.yml,
 * profile `e2e`) with distinct hostnames, so the prompt itself says which
 * host a pane is talking to. See scripts/e2e-ssh-targets.sh and
 * backend/scripts/e2e-ssh-setup.mjs.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const auth = JSON.parse(fs.readFileSync(path.join(__dirname, '.auth.ssh.json'), 'utf8'));
const API = process.env.E2E_API_URL || 'http://localhost:3001';

const host = (name) => auth.servers.find((s) => s.hostname === name);
const ALPHA = host('ssh-alpha');
const BRAVO = host('ssh-bravo');
const CHARLIE = host('ssh-charlie');

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/**
 * Tokens from the first real sign-in, reused by every later test.
 *
 * NOT an optimisation. /api/auth/login, /login-options and /refresh share one
 * express-rate-limit bucket of 10 requests per minute PER IP, so a suite that
 * signs in through the form in every test runs out of budget partway through
 * and the login page simply never renders its password field. That is what
 * the two "flaky" failures in the RDP suite are — not flakiness, a limiter
 * doing its job. One sign-in per run stays well inside it.
 */
let session = null;

async function captureSession(page) {
  session = await page.evaluate(() => ({
    accessToken: localStorage.getItem('accessToken'),
    refreshToken: localStorage.getItem('refreshToken'),
  }));
}

async function signIn(page) {
  if (session?.accessToken) {
    await page.addInitScript(
      ([a, r]) => {
        localStorage.setItem('accessToken', a);
        if (r) localStorage.setItem('refreshToken', r);
      },
      [session.accessToken, session.refreshToken]
    );
    await page.goto('/terminals');
    // A token that outlived its welcome bounces to /login; fall through and
    // sign in properly rather than failing the test that noticed.
    if (!/\/login/.test(page.url())) return;
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.goto('/login');
    await page.locator('#email').fill(auth.email);
    await page.getByRole('button', { name: /^continue$/i }).click();
    const password = page.locator('#password');
    const limited = page.getByText(/too many requests/i);
    // Whichever arrives first. The limiter's window is 60s, so one wait is
    // always enough — and this is a documented server response, not a flake
    // being papered over: see the note on `session` above.
    await expect(password.or(limited).first()).toBeVisible({ timeout: 20_000 });
    if (await limited.count()) {
      if (attempt === 2) throw new Error('rate limited twice while signing in');
      await page.waitForTimeout(61_000);
      continue;
    }
    await password.fill(auth.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
    break;
  }
  await captureSession(page);
}

const tokenOf = (page) => page.evaluate(() => localStorage.getItem('accessToken'));

async function api(page, method, url, body) {
  const token = await tokenOf(page);
  const res = await page.request[method](`${API}${url}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(body ? { data: body } : {}),
  });
  return res;
}

/** Session rows for a server. `limit`, NOT `pageSize` — Joi drops the wrong one. */
async function sessionsFor(page, serverId, { status } = {}) {
  const qs = new URLSearchParams({ serverId, limit: '100' });
  if (status) qs.set('status', status);
  const res = await api(page, 'get', `/api/sessions?${qs}`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const items = body?.data?.items ?? body?.data?.sessions ?? [];
  return items.filter((s) => s.serverId === serverId && s.sessionType === 'SSH');
}

/** The caller's live hub sessions (what the workspace polls). */
async function liveHubSessions(page) {
  const res = await api(page, 'get', '/api/terminal/sessions');
  const body = await res.json();
  return body?.data?.sessions ?? [];
}

/** Leave nothing running between tests — a detached session lives 15 minutes. */
async function endEverything(page) {
  for (const s of await liveHubSessions(page)) {
    await api(page, 'post', `/api/terminal/sessions/${s.id}/close`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Driving a terminal
// ---------------------------------------------------------------------------

/**
 * A handle on one pane's terminal.
 *
 * `text()` reads what xterm has actually painted. The DOM renderer only ever
 * renders the visible viewport, which is exactly what we want to assert on:
 * "is this on the screen right now" is the question an alternate-screen test
 * is asking.
 */
function terminal(page, tabId) {
  const pane = tabId ? page.locator(`[data-pane-tab-id="${tabId}"]`) : page.locator('[data-pane-index="0"]');
  const screen = pane.locator('.xterm-screen');
  return {
    pane,
    screen,
    async focus() {
      // A real click, where a person would click, so xterm's own focus
      // handling runs and the workspace marks this pane focused.
      await screen.click({ position: { x: 40, y: 40 } });
    },
    async text() {
      return pane.locator('.xterm-rows').innerText();
    },
    async expectScreen(re, opts = {}) {
      await expect
        .poll(async () => (await this.text()).replace(/ /g, ' '), {
          timeout: opts.timeout ?? 20_000,
          message: opts.message || `waiting for ${re} on screen`,
        })
        .toMatch(re);
    },
    async expectGone(re, opts = {}) {
      await expect
        .poll(async () => (await this.text()).replace(/ /g, ' '), {
          timeout: opts.timeout ?? 15_000,
          message: opts.message || `waiting for ${re} to leave the screen`,
        })
        .not.toMatch(re);
    },
    /** Type a command and press Enter. Does not wait for it to finish. */
    async run(cmd) {
      await this.focus();
      await page.keyboard.type(cmd);
      await page.keyboard.press('Enter');
    },
    async prompt(hostname, opts) {
      await this.expectScreen(new RegExp(`${auth.sshUser}@${hostname}:[^$]*\\$`), {
        timeout: opts?.timeout ?? 45_000,
        message: `no shell prompt from ${hostname}`,
      });
    },
  };
}

/**
 * Open a server in a workspace tab the way a person does: the "+" button,
 * search, Connect. Deliberately NOT a URL with a request id in it — the tab
 * bar, the pane area and the intent lookup are all part of what is being
 * tested, and /terminal?requestId= skips every one of them.
 *
 * Returns the tab id (the workspace's own id, read off the tab bar).
 */
async function openTab(page, hostname) {
  const before = await page.locator('[role="tab"][data-tab-id]').evaluateAll((els) =>
    els.map((e) => e.dataset.tabId)
  );

  // The tab bar's "+" (aria-label), not the empty state's wider button — both
  // open the same dialog, but only one of them exists once a tab is open.
  await page.getByLabel('New connection').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Search servers...').fill(hostname);
  const row = dialog.locator('li', { hasText: hostname }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  // "Connect" only appears when an APPROVED, unexpired request exists. If it
  // says "Request access" the fixture is stale — say so, instead of timing
  // out on a button that is never going to be there.
  const connect = row.getByRole('button', { name: /^connect$/i });
  if (!(await connect.count())) {
    throw new Error(
      `no active access to ${hostname} — re-run: (cd backend && node scripts/e2e-ssh-setup.mjs)`
    );
  }
  await connect.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  await expect
    .poll(
      async () =>
        page.locator('[role="tab"][data-tab-id]').evaluateAll((els) => els.map((e) => e.dataset.tabId)),
      { timeout: 15_000, message: 'no new tab appeared in the tab bar' }
    )
    .not.toEqual(before);

  const ids = await page.locator('[role="tab"][data-tab-id]').evaluateAll((els) =>
    els.map((e) => e.dataset.tabId)
  );
  const tabId = ids.find((id) => !before.includes(id));
  const term = terminal(page, tabId);
  await term.prompt(hostname);
  return { tabId, term };
}

test.describe('the SSH terminal workspace', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await endEverything(page);
    await page.goto('/terminals');
  });

  test.afterEach(async ({ page }) => {
    await endEverything(page).catch(() => {});
    // The app rotates its token pair on every terminal connect (TerminalView
    // calls refresh() before opening the socket), and the old pair stops
    // working. Carrying the newest pair forward is what keeps the whole run
    // down to a single trip through the login form.
    await captureSession(page).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // 1. Connecting
  // -------------------------------------------------------------------------

  test('connects to a server and shows its shell prompt', async ({ page }) => {
    const { term } = await openTab(page, 'ssh-alpha');

    // The prompt is the host's own: `e2e@ssh-alpha:~$`. A pane that connected
    // to the wrong box, or drew nothing, cannot produce it.
    await term.prompt('ssh-alpha');

    // And the server agrees it has a session — a screen full of plausible
    // text with no Session row behind it would be a lie.
    await expect
      .poll(async () => (await sessionsFor(page, ALPHA.id, { status: 'ACTIVE' })).length, {
        timeout: 20_000,
        message: 'no ACTIVE Session row for a connected terminal',
      })
      .toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Ordinary commands
  // -------------------------------------------------------------------------

  test('runs ordinary commands and shows their real output', async ({ page }) => {
    const { term } = await openTab(page, 'ssh-alpha');

    // Every assertion below matches something the command PRINTS and not
    // something that was typed, so the echo of the command line itself can
    // never satisfy it.
    await term.run('echo "home=$(pwd)"');
    await term.expectScreen(/home=\/home\/e2e/);

    await term.run('ls /etc/ssh | head -3');
    await term.expectScreen(/moduli/);

    await term.run('echo "who=$(whoami)@$(hostname)"');
    await term.expectScreen(/who=e2e@ssh-alpha/);

    // stderr must arrive as well as stdout — the PTY merges them, and a
    // client that only pumped stdout would silently swallow every error.
    await term.run('ls /definitely-not-here');
    await term.expectScreen(/No such file or directory/);

    // Colour: the escape sequence has to survive the WebSocket and be turned
    // into a coloured cell, not printed as literal ESC[31m.
    await term.run('printf "\\033[31mSCARLET\\033[0m\\n"');
    await term.expectScreen(/SCARLET/);
    // The row that IS the word, not the row that echoed the command that
    // printed it — xterm puts a run of same-coloured cells in its own span,
    // so the output's span is exactly "SCARLET" while the echoed command
    // line's span is the whole line.
    await expect(
      term.pane.locator('.xterm-rows span').filter({ hasText: /^SCARLET$/ }).first()
    ).toHaveCSS('color', 'rgb(244, 119, 108)'); // the workspace theme's red
  });

  // -------------------------------------------------------------------------
  // 3. Full-screen programs (the interesting case)
  // -------------------------------------------------------------------------

  test('vim: enters the alternate screen, takes keystrokes, saves, and leaves it cleanly', async ({ page }) => {
    const { term } = await openTab(page, 'ssh-alpha');

    const file = `/tmp/vim-${Date.now()}.txt`;
    await term.run('echo BEFORE_EDITOR_MARKER');
    await term.expectScreen(/BEFORE_EDITOR_MARKER/);

    await term.run(`vim ${file}`);

    // Entering the alternate screen replaces the whole screen: the shell's
    // scrollback, including the marker, is no longer visible. This is what
    // "the alternate buffer was entered" looks like to a person, and it is
    // also precisely what a client that ignored the switch would get wrong —
    // it would keep painting over the old screen.
    await term.expectGone(/BEFORE_EDITOR_MARKER/, { message: 'vim never took over the screen' });
    await term.expectScreen(/~/);

    await page.keyboard.press('i');
    await page.keyboard.type('typed inside vim');
    await page.keyboard.press('Escape');
    await page.keyboard.type(':wq');
    await page.keyboard.press('Enter');

    // Leaving the alternate screen restores exactly what was on screen
    // before — the marker comes back. A client that never left it would show
    // the editor's last frame, or a blank screen.
    await term.expectScreen(/BEFORE_EDITOR_MARKER/, { message: 'the shell screen was not restored after vim' });
    await term.prompt('ssh-alpha');

    // And the keystrokes really reached the editor and the file system. The
    // command typed here does not contain the text being looked for, so only
    // the file's contents can produce it.
    await term.run(`cat ${file}`);
    await term.expectScreen(/typed inside vim/);
  });

  test('nano: takes keystrokes, saves with Ctrl+O, and exits with Ctrl+X', async ({ page }) => {
    const { term } = await openTab(page, 'ssh-alpha');

    const file = `/tmp/nano-${Date.now()}.txt`;
    await term.run('echo BEFORE_NANO_MARKER');
    await term.expectScreen(/BEFORE_NANO_MARKER/);

    await term.run(`nano ${file}`);
    await term.expectGone(/BEFORE_NANO_MARKER/, { message: 'nano never took over the screen' });
    // nano's help bar is drawn at the bottom of the alternate screen.
    await term.expectScreen(/Write Out|\^O/);

    await page.keyboard.type('typed inside nano');
    await page.keyboard.press('Control+o'); // Write Out
    await page.keyboard.press('Enter'); // confirm the filename
    await page.keyboard.press('Control+x'); // Exit

    await term.expectScreen(/BEFORE_NANO_MARKER/, { message: 'the shell screen was not restored after nano' });
    await term.run(`cat ${file}`);
    await term.expectScreen(/typed inside nano/);
  });

  /**
   * `less` uses the alternate screen; procps `top` does NOT — it clears and
   * redraws the normal screen and leaves its last frame behind on exit
   * (verified on the host: top emits ESC[?1l, never ESC[?1049h). So each is
   * asserted for what it actually does. Treating top as an alternate-screen
   * program would be a test that fails for a reason the product cannot fix.
   */
  test('less uses the alternate screen; top redraws the normal one', async ({ page }) => {
    const { term } = await openTab(page, 'ssh-alpha');

    await term.run('echo BEFORE_PAGER_MARKER');
    await term.expectScreen(/BEFORE_PAGER_MARKER/);

    await term.run('seq 1 500 | less');
    await term.expectGone(/BEFORE_PAGER_MARKER/, { message: 'less never took over the screen' });
    await term.expectScreen(/\b1\b[\s\S]*\b20\b/);
    await page.keyboard.press('q');
    await term.expectScreen(/BEFORE_PAGER_MARKER/, { message: 'the shell screen was not restored after less' });

    // top redraws on a timer, so it also proves output keeps flowing while a
    // full-screen program owns the terminal, and that its own process list
    // sees the shell it is running under.
    await term.run('top');
    await term.expectGone(/BEFORE_PAGER_MARKER/, { message: 'top never took over the screen' });
    await term.expectScreen(/load average|Tasks:/);
    await term.expectScreen(/bash[\s\S]*top|top[\s\S]*bash/);
    await page.keyboard.press('q');
    // No alternate screen to come back from — what must be true is that the
    // shell is usable again.
    await term.prompt('ssh-alpha');
    await term.run('echo "after=top"');
    await term.expectScreen(/after=top/);
  });

  // -------------------------------------------------------------------------
  // 4. Control characters
  // -------------------------------------------------------------------------

  test('Ctrl+C interrupts, Ctrl+L clears, Ctrl+D ends the session', async ({ page }) => {
    const { tabId, term } = await openTab(page, 'ssh-alpha');

    // Ctrl+C: the shell reports 130 for a command killed by SIGINT, which is
    // proof the signal reached the remote process group and not merely that
    // something redrew a prompt.
    await term.run('sleep 45');
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+c');
    await term.prompt('ssh-alpha', { timeout: 15_000 });
    await term.run('echo "rc=$?"');
    await term.expectScreen(/rc=130/);

    // Ctrl+L: the screen is cleared but the session is untouched.
    await term.run('echo CLEAR_ME_PLEASE');
    await term.expectScreen(/CLEAR_ME_PLEASE/);
    await page.keyboard.press('Control+l');
    await term.expectGone(/CLEAR_ME_PLEASE/, { message: 'Ctrl+L did not clear the screen' });
    await term.run('echo "still=alive"');
    await term.expectScreen(/still=alive/);

    // Ctrl+D at the prompt closes the shell: the tab goes to `ended` and the
    // Session row stops being ACTIVE.
    await term.focus();
    await page.keyboard.press('Control+d');

    await expect(page.locator(`[role="tab"][data-tab-id="${tabId}"]`)).toHaveAttribute(
      'data-tab-state',
      'ended',
      { timeout: 20_000 }
    );
    await expect
      .poll(async () => (await sessionsFor(page, ALPHA.id, { status: 'ACTIVE' })).length, {
        timeout: 20_000,
        message: 'the Session row stayed ACTIVE after the remote shell exited',
      })
      .toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. Resize
  // -------------------------------------------------------------------------

  test('resizing the window resizes the remote PTY', async ({ page }) => {
    const { term } = await openTab(page, 'ssh-alpha');

    const sizeNow = async () => {
      await term.run('stty size | tr " " "x"');
      let seen = null;
      await expect
        .poll(
          async () => {
            const matches = (await term.text()).match(/\b(\d{2,3})x(\d{2,3})\b/g) || [];
            seen = matches.length ? matches[matches.length - 1] : null;
            return seen;
          },
          { timeout: 15_000, message: 'stty size never printed' }
        )
        .not.toBeNull();
      const [rows, cols] = seen.split('x').map(Number);
      return { rows, cols };
    };

    const wide = await sizeNow();
    expect(wide.cols).toBeGreaterThan(40);

    await page.setViewportSize({ width: 800, height: 600 });
    // The pane refits on a ResizeObserver callback and then sends a resize
    // frame; poll for the remote side to agree rather than guessing a delay.
    await expect
      .poll(
        async () => {
          const { cols } = await sizeNow();
          return cols;
        },
        { timeout: 30_000, message: 'the remote PTY never narrowed with the window' }
      )
      .toBeLessThan(wide.cols);

    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect
      .poll(
        async () => {
          const { cols } = await sizeNow();
          return cols;
        },
        { timeout: 30_000, message: 'the remote PTY never widened again' }
      )
      .toBeGreaterThanOrEqual(wide.cols - 2);
  });

  // -------------------------------------------------------------------------
  // 6. Two panes at once — the most valuable test here
  // -------------------------------------------------------------------------

  test('two servers side by side: keystrokes go only to the focused pane', async ({ page }) => {
    const a = await openTab(page, 'ssh-alpha');
    const b = await openTab(page, 'ssh-bravo');

    // Put them on screen together, the way the UI does it: splitting a tab
    // opens an empty pane beside it, and clicking a tab in the bar fills the
    // focused empty pane.
    await page.locator(`[role="tab"][data-tab-id="${b.tabId}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /split right/i }).click();
    // Click the empty pane before filling it. The tab bar only redirects a
    // click into an empty pane when that pane is the FOCUSED one, and focus
    // follows the mouse-down a person would make; without it, selecting a tab
    // that is not in the split dissolves the split instead of joining it.
    const empty = page.locator('[data-pane-index="1"]');
    await expect(empty).toBeVisible();
    await empty.click({ position: { x: 40, y: 40 } });
    await page.locator(`[role="tab"][data-tab-id="${a.tabId}"]`).click();

    const alpha = terminal(page, a.tabId);
    const bravo = terminal(page, b.tabId);
    await expect(alpha.screen).toBeVisible();
    await expect(bravo.screen).toBeVisible();

    // Each pane is a different host, and says so.
    await alpha.prompt('ssh-alpha');
    await bravo.prompt('ssh-bravo');

    // Type into alpha. Bravo must not see a character of it — this is the SSH
    // analogue of a keyboard handler bound to the document instead of the
    // pane, where every pane receives every keystroke.
    await alpha.run('echo ONLY_FOR_ALPHA');
    await alpha.expectScreen(/ONLY_FOR_ALPHA/);
    await bravo.expectGone(/ONLY_FOR_ALPHA/, { message: 'a keystroke aimed at one pane reached the other' });

    // Bravo's command leaves a mark on bravo's filesystem, under a name
    // unique to this run.
    const witness = `/tmp/bravo-only-${Date.now()}`;
    await bravo.run(`echo ONLY_FOR_BRAVO | tee ${witness}`);
    await bravo.expectScreen(/ONLY_FOR_BRAVO/);
    await alpha.expectGone(/ONLY_FOR_BRAVO/, { message: 'a keystroke aimed at one pane reached the other' });

    // Asked of the host, not the screen: if a single one of bravo's
    // keystrokes had also reached alpha's shell, alpha would have run the
    // same command and the file would be here too.
    // The answer is computed on the host, so it cannot be satisfied by the
    // echo of the command that asked for it: `witness=0` is printed, never
    // typed.
    await alpha.run(`echo "witness=$(ls ${witness} 2>/dev/null | wc -l)"`);
    await alpha.expectScreen(/witness=0/, { message: "alpha ran bravo's command" });
    await bravo.run(`echo "witness=$(ls ${witness} 2>/dev/null | wc -l)"`);
    await bravo.expectScreen(/witness=1/, { message: "bravo never ran its own command" });

    // And there are exactly two sessions, one per server.
    expect(await sessionsFor(page, ALPHA.id, { status: 'ACTIVE' })).toHaveLength(1);
    expect(await sessionsFor(page, BRAVO.id, { status: 'ACTIVE' })).toHaveLength(1);
  });

  test('switching tabs shows the other host without reconnecting either', async ({ page }) => {
    const a = await openTab(page, 'ssh-alpha');
    const b = await openTab(page, 'ssh-bravo');

    const before = (await liveHubSessions(page)).map((s) => s.id).sort();
    expect(before).toHaveLength(2);

    // Bravo is on screen (it was opened last); alpha is parked hidden.
    await terminal(page, b.tabId).prompt('ssh-bravo');

    await page.locator(`[role="tab"][data-tab-id="${a.tabId}"]`).click();
    const alpha = terminal(page, a.tabId);
    await expect(alpha.screen).toBeVisible();
    await alpha.prompt('ssh-alpha');
    // It is the SAME session, still holding its scrollback — not a new one.
    await alpha.run('echo STILL_THE_SAME_SHELL');
    await alpha.expectScreen(/STILL_THE_SAME_SHELL/);

    await page.locator(`[role="tab"][data-tab-id="${b.tabId}"]`).click();
    await terminal(page, b.tabId).prompt('ssh-bravo');

    expect(
      (await liveHubSessions(page)).map((s) => s.id).sort(),
      'switching tabs must not open or close a session'
    ).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // 7. Lifecycle: close, reattach, end
  // -------------------------------------------------------------------------

  test('closing a tab detaches; the session survives and can be reattached', async ({ page }) => {
    const { tabId, term } = await openTab(page, 'ssh-alpha');
    await term.run('echo REATTACH_WITNESS');
    await term.expectScreen(/REATTACH_WITNESS/);

    const [live] = await liveHubSessions(page);
    expect(live).toBeTruthy();

    // The × is documented as "Close (the session keeps running)".
    await page.locator(`[role="tab"][data-tab-id="${tabId}"]`).hover();
    await page.getByRole('button', { name: /^Close / }).first().click();
    await expect(page.locator(`[role="tab"][data-tab-id="${tabId}"]`)).toHaveCount(0);

    // Still running server-side, and still ACTIVE.
    await expect
      .poll(async () => (await liveHubSessions(page)).map((s) => s.id), { timeout: 15_000 })
      .toContain(live.id);
    expect(await sessionsFor(page, ALPHA.id, { status: 'ACTIVE' })).toHaveLength(1);

    // Reattach from the empty workspace's running-sessions list.
    await page.getByRole('button', { name: /^attach$/i }).first().click();
    const back = terminal(page, null);
    await back.prompt('ssh-alpha');
    // The hub replays its recent output, so the earlier line is there — this
    // is the same shell, not a fresh login.
    await back.expectScreen(/REATTACH_WITNESS/);
    expect((await liveHubSessions(page)).map((s) => s.id)).toEqual([live.id]);
  });

  test('"End session" ends the session, and the Sessions page shows it', async ({ page }) => {
    const { tabId, term } = await openTab(page, 'ssh-alpha');
    await term.prompt('ssh-alpha');
    const [live] = await liveHubSessions(page);

    await page.locator(`[role="tab"][data-tab-id="${tabId}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /end session/i }).click();
    await page.getByRole('button', { name: /^end session$/i }).click();

    await expect
      .poll(async () => (await sessionsFor(page, ALPHA.id, { status: 'ACTIVE' })).length, {
        timeout: 20_000,
        message: 'the session stayed ACTIVE after "End session"',
      })
      .toBe(0);

    const ended = (await sessionsFor(page, ALPHA.id)).find((s) => s.id === live.id);
    expect(ended?.status, 'an ended SSH session should be ENDED').toBe('ENDED');

    // And it is visible where a person would look for it.
    await page.goto('/sessions');
    await expect(page.getByText('ssh-alpha').first()).toBeVisible({ timeout: 20_000 });
  });

  // -------------------------------------------------------------------------
  // 8. Paste and a flood of output
  // -------------------------------------------------------------------------

  test('pasted text is sent to the shell', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { term } = await openTab(page, 'ssh-alpha');

    await term.focus();
    // A real `paste` event on the focused terminal — which is what the
    // browser delivers for a right-click paste, a middle-click paste or
    // Ctrl+Shift+V, and what xterm listens for.
    //
    // NOT Ctrl+V: in a terminal that is `quoted-insert` (^V), and pressing it
    // here does exactly that — readline swallows the next key and the
    // following Return shows up as a literal ^M. Correct behaviour, and
    // nothing to do with pasting.
    await page.evaluate(() => {
      const target = document.querySelector('.xterm-helper-textarea') || document.activeElement;
      const data = new DataTransfer();
      data.setData('text/plain', 'echo PASTED_FROM_CLIPBOARD');
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.keyboard.press('Enter');

    await term.expectScreen(/PASTED_FROM_CLIPBOARD/);
    await term.prompt('ssh-alpha');
  });

  test('a flood of output does not wedge the terminal', async ({ page }) => {
    test.setTimeout(180_000);
    const { term } = await openTab(page, 'ssh-alpha');

    // 100k lines at the terminal, not into a pipe: the point is what xterm
    // does with them.
    await term.run('yes shellius | head -100000; echo FLOOD_DONE');
    await term.expectScreen(/FLOOD_DONE/, { timeout: 120_000, message: 'the 100k-line burst never finished' });

    // Still interactive afterwards.
    await term.run('echo "after=flood"');
    await term.expectScreen(/after=flood/);
    expect(await sessionsFor(page, ALPHA.id, { status: 'ACTIVE' })).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 9. Expiry / revocation
  //
  // There is no idle timeout on an attached session — a shell nobody types in
  // stays open. What the product does have is (a) a 15 minute detach TTL
  // (TERMINAL_DETACH_TTL_SECONDS) and (b) a watcher that ends live sessions
  // whose access request has expired, been denied or been revoked, checked
  // every 30 seconds (terminalHub AR_CHECK_INTERVAL_MS). (b) is the one that
  // matters for "no permanent access", and the one that can be tested in
  // under a minute. Uses ssh-charlie so it cannot disturb the tests above.
  //
  // It is the only DESTRUCTIVE test here: revoking consumes the access it was
  // given, so it re-grants at the end. Without that the suite passes once and
  // then fails on every later run with "no active access", which looks like a
  // regression and is really just the previous run's success.
  // -------------------------------------------------------------------------

  test('revoking the access request ends the live session', async ({ page }) => {
    test.setTimeout(150_000);
    const { tabId, term } = await openTab(page, 'ssh-charlie');
    await term.prompt('ssh-charlie');
    expect(await sessionsFor(page, CHARLIE.id, { status: 'ACTIVE' })).toHaveLength(1);

    // Revoke whichever grant is CURRENTLY live, not the id recorded when the
    // fixture was written. This test restores access at the end by creating a
    // fresh request, so on the second run the recorded id is an already-revoked
    // one and revoking it again is a 409.
    const mine = await api(
      page,
      'get',
      '/api/access-requests?tab=mine&status=APPROVED&limit=100'
    );
    expect(mine.ok(), 'could not list my access requests').toBeTruthy();
    const listed = (await mine.json())?.data;
    const items = listed?.items ?? listed?.accessRequests ?? [];
    const live = items.find((r) => r.serverId === CHARLIE.id);
    expect(live, 'no live access request for ssh-charlie to revoke').toBeTruthy();

    const res = await api(page, 'post', `/api/access-requests/${live.id}/revoke`, {
      reason: 'browser end-to-end test',
    });
    expect(res.ok(), `revoke failed: ${res.status()}`).toBeTruthy();

    await expect(page.locator(`[role="tab"][data-tab-id="${tabId}"]`)).toHaveAttribute(
      'data-tab-state',
      /ended|lost/,
      { timeout: 90_000 }
    );
    await expect
      .poll(async () => (await sessionsFor(page, CHARLIE.id, { status: 'ACTIVE' })).length, {
        timeout: 30_000,
        message: 'a revoked access request left its session running',
      })
      .toBe(0);

    // Put back what this test consumed, so the suite is re-runnable without
    // re-running the setup script. Done here rather than in an afterEach
    // because it is this test alone that spends the grant.
    const regranted = await api(page, 'post', '/api/access-requests', {
      serverId: CHARLIE.id,
      reason: 'restoring access consumed by the revoke end-to-end test',
      requestedDuration: 3600,
      requestedPrincipal: auth.sshUser,
      protocol: 'SSH',
    });
    expect(
      regranted.ok(),
      'could not restore access to ssh-charlie — the next run will need the setup script'
    ).toBeTruthy();

    // Restoring only counts if the request came back usable. ssh-charlie is a
    // dev-environment host, so the org's dev policy auto-approves it — but if
    // that policy ever changes this must fail here, loudly, rather than two
    // runs later as a mystery "no active access".
    const body = await regranted.json();
    expect(
      body?.data?.accessRequest?.status ?? body?.data?.status,
      'the restored request is not APPROVED, so the next run will have no access'
    ).toBe('APPROVED');
  });
});
