import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import * as sshConnect from './sshConnect.js';
import { UNSCOPED, serverScopeWhere } from '../lib/scope.js';

/**
 * Provisions a server by SSHing in and running the Shellius bootstrap script.
 *
 * @param {string} orgId
 * @param {string} serverId
 * @param {object} opts
 * @param {string} opts.privateKey     - PEM-format SSH private key (never stored)
 * @param {string} [opts.certificate]  - OpenSSH cert text paired with privateKey.
 *   Used for hosts that are already bootstrapped and therefore trust the org
 *   CA, so no stored identity is needed. See services/installCertService.js.
 * @param {string} opts.sshUser        - SSH username to connect as
 * @param {string} [opts.sudoPassword] - sudo password if needed (never stored)
 * @param {string} opts.bootstrapUrl   - full URL to the bootstrap install.sh
 * @param {object} [opts.scope]        - caller's customer scope. Provisioning
 *   SSHes into the host as root and runs the bootstrap installer, so a server
 *   outside the caller's scope must be as unreachable here as it is from
 *   GET /api/servers/:id (docs/rbac/customer-scope-spec.md §4.2 #23).
 * @param {function} opts.onOutput     - callback(line: string) for each output line
 * @param {number} [opts.installTimeoutMs] - hard ceiling on the remote run. A
 *   host that blocks with no output (a dpkg lock, an unexpected prompt) would
 *   otherwise hold its worker slot forever.
 * @param {string} [opts.mode]         - 'full' (default) or 'posture'. See the
 *   provisionStatus note below — this only changes bookkeeping/log wording,
 *   the actual install content is entirely determined by what `bootstrapUrl`
 *   points at (the mode is baked into its signed token server-side).
 * @returns {Promise<void>}
 */
/**
 * The remote command, by privilege situation:
 *   root user       → pipe curl output directly to bash
 *   sudo + password → download, then `sudo -S` with the password on stdin
 *   sudo (no pass)  → `sudo -n`, which FAILS rather than asks
 *
 * `sudo -n` is the one that matters. The command runs on a pty, so a plain
 * `sudo` with no password prints "[sudo] password for user:" and then waits.
 * Forever. Nothing errors, the stream never closes, the promise never
 * settles: the host holds its worker slot and the UI spins under a heading
 * that eventually says the install finished. That is exactly how a
 * certificate install — which by definition has no password to offer — hung
 * on a host whose sudo prompts.
 *
 * `-n` turns that infinite wait into an immediate, legible failure, which is
 * also what lets the bulk runner fall back to the credentials it was given.
 */
export function buildInstallCommand({ sshUser, sudoPassword, bootstrapUrl }) {
  if (sshUser === 'root') return `curl -fsSL '${bootstrapUrl}' | bash`;
  if (sudoPassword) {
    return [
      `curl -fsSL '${bootstrapUrl}' -o /tmp/.shellius-install.sh`,
      'sudo -S bash /tmp/.shellius-install.sh',
      'ec=$?',
      'rm -f /tmp/.shellius-install.sh',
      'exit $ec',
    ].join(' && ');
  }
  return `curl -fsSL '${bootstrapUrl}' | sudo -n bash`;
}

/**
 * Does this output show a host asking for a password nobody will type?
 * `sudo -n` makes it nearly unreachable, but a prompt can still come from
 * elsewhere in the script, and on a channel with no typist it means the run
 * is already dead.
 */
export function looksLikePasswordPrompt(text) {
  // Classic sudo: "[sudo] password for ubuntu:". sudo-rs (Ubuntu 25.10+):
  // "[sudo: authenticate] Password:".
  return /\[sudo\] password for |\[sudo: authenticate\] Password:|^Password:/im.test(String(text || ''));
}

/** `sudo -n` refusing for want of a password, as it says it. */
export function looksLikeSudoRefusal(text) {
  // The second alternative is sudo-rs's wording for the same refusal.
  return /sudo: a (?:password is required|terminal is required)|sudo: no tty present|interactive authentication is required/i.test(
    String(text || '')
  );
}

/** sudo rejecting the password it was given ("Sorry, try again."). */
export function looksLikeWrongSudoPassword(text) {
  // Classic sudo, then sudo-rs.
  return /Sorry, try again\.|\d+ incorrect password attempts?|Authentication failed, try again|incorrect authentication attempts?/i.test(
    String(text || '')
  );
}

/**
 * Remove a secret from a line of installer output.
 *
 * The install runs on a pty, and a pty's line discipline echoes whatever is
 * written to it — including the sudo password written to stdin for
 * `sudo -S`, which arrives before sudo (or anything else) could turn echo
 * off. Every line is shown to the operator and may be logged, so it is
 * scrubbed here, at the one place output leaves this module.
 */
export function redactSecret(text, secret) {
  const s = String(text ?? '');
  if (!secret) return s;
  return s.split(secret).join('••••••••');
}

/** The sudo password given was refused. Distinct from "none was given". */
export const SUDO_PASSWORD_INCORRECT = 'SUDO_PASSWORD_INCORRECT';

/**
 * The stable code the UI branches on to offer a sudo password box for this
 * one host, instead of making the whole batch a failure.
 */
export const SUDO_PASSWORD_REQUIRED = 'SUDO_PASSWORD_REQUIRED';

// Generous: a cold bootstrap installs packages over someone else's network.
// This is a deadlock backstop, not a performance budget.
const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

export async function provisionServer(
  orgId,
  serverId,
  {
    privateKey,
    passphrase,
    password,
    certificate,
    sshUser,
    sudoPassword,
    bootstrapUrl,
    mode = 'full',
    onOutput,
    scope = UNSCOPED,
    installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  }
) {
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId, ...serverScopeWhere(scope) },
  });
  if (!server) throw new ApiError(404, 'Server not found');

  // Server.provisionStatus (schema.prisma) represents ONE thing: where the
  // host is in the FULL agent bootstrap lifecycle — it's what
  // isServerOnboarded() / ServerDetail's Onboarding card / bulk-import's
  // idempotent-reonboard check all read as "CA-based cert access is ready".
  // A posture-only run installs none of that (no CA trust, no sshd config,
  // no check-principals), so it must never write to provisionStatus /
  // provisionedAt / provisionError / lastProvisionAt — doing so would either
  // falsely claim "provisioned" or, on failure, mark a fully-onboarded host
  // "failed" because an unrelated, narrower install hit an error. A
  // posture-only attempt therefore leaves the server's full-agent state
  // exactly as it found it; its own success/failure is only observable via
  // the SSE log stream (and the audit log entry on the route).
  const trackFullAgentStatus = mode !== 'posture';

  if (trackFullAgentStatus) {
    // Mark provisioning in progress. lastProvisionAt records every attempt;
    // provisionedAt is only stamped on success below. This makes re-onboarding
    // idempotent and observable from the UI / bulk-import flow.
    await prisma.server.update({
      where: { id: serverId },
      data: { provisionStatus: 'provisioning', provisionError: null, lastProvisionAt: new Date() },
    }).catch((e) => logger.warn({ err: e.message, serverId }, 'failed to set provisioning state'));
  }

  const markProvisioned = () => {
    if (!trackFullAgentStatus) return Promise.resolve();
    return prisma.server
      .update({ where: { id: serverId }, data: { provisionStatus: 'provisioned', provisionError: null, provisionedAt: new Date() } })
      .catch((e) => logger.warn({ err: e.message, serverId }, 'failed to set provisioned state'));
  };

  // The collector was (re)installed just now. A posture report older than
  // this came from the collector that was replaced; the UI waits for the
  // new one instead of presenting the old one's warnings as current.
  // 'ssh' mode installs no collector, so it records nothing.
  const markCollectorInstalled = () => {
    if (mode !== 'posture' && mode !== 'full') return Promise.resolve();
    return prisma.server
      .update({ where: { id: serverId }, data: { postureInstalledAt: new Date() } })
      .catch((e) => logger.warn({ err: e.message, serverId }, 'failed to record the collector install time'));
  };

  const markFailed = (message) => {
    if (!trackFullAgentStatus) return Promise.resolve();
    return prisma.server
      .update({ where: { id: serverId }, data: { provisionStatus: 'failed', provisionError: String(message || 'unknown error').slice(0, 500) } })
      .catch((e) => logger.warn({ err: e.message, serverId }, 'failed to set failed state'));
  };

  const emit = (line) => {
    if (onOutput) onOutput(redactSecret(line, sudoPassword));
  };

  let client;
  try {
    const result = await sshConnect.connectSsh({
      host: server.ipAddress,
      port: server.port || 22,
      username: sshUser,
      privateKey,
      passphrase,
      password,
      certificate,
      readyTimeout: 20000,
      pinContext: serverId,
    });
    client = result.client;
  } catch (err) {
    logger.error({ err: err.message, serverId }, 'SSH provision connection error');
    await markFailed(err?.message);
    throw err instanceof ApiError ? err : new ApiError(500, `SSH connection failed: ${err.message}`);
  }

  emit('[shellius] SSH connection established');
  emit(
    trackFullAgentStatus
      ? '[shellius] Installing full agent (CA trust, sshd config, check-principals, posture collector)'
      : '[shellius] Installing posture collector only (no CA trust / sshd changes)'
  );

  const cmd = buildInstallCommand({ sshUser, sudoPassword, bootstrapUrl });

  return new Promise((resolve, reject) => {
    // Nothing here may wait forever. Every settle path goes through these so
    // a late event after a timeout cannot resolve an already-rejected run.
    let settled = false;
    let timer = null;
    const done = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const settleOk = () => {
      if (settled) return;
      done();
      Promise.all([markProvisioned(), markCollectorInstalled()]).finally(() => resolve());
    };
    const settleErr = (err) => {
      if (settled) return;
      done();
      markFailed(err?.message).finally(() => reject(err));
    };

    client.exec(cmd, { pty: true }, (err, stream) => {
      if (err) {
        client.end();
        return settleErr(new ApiError(500, `SSH exec failed: ${err.message}`));
      }

      // A backstop for anything that blocks with no output at all: a package
      // manager waiting on a lock, a half-open connection, a prompt we did
      // not anticipate. Without it a single wedged host holds a worker slot
      // for the lifetime of the process.
      const abort = (message, code) => {
        emit(`[shellius] ${message}`);
        try { stream.close(); } catch { /* the stream is already gone */ }
        try { client.end(); } catch { /* ditto */ }
        settleErr(new ApiError(code ? 400 : 504, message, code ? { code } : {}));
      };
      timer = setTimeout(
        () => abort(`Install timed out after ${Math.round(installTimeoutMs / 1000)}s with no result`),
        installTimeoutMs
      );

      // sudo -S reads the password from the exec channel's stdin — never
      // placed on the command line, never logged.
      if (sudoPassword && sshUser !== 'root') {
        try { stream.write(`${sudoPassword}\n`); } catch { /* ignore */ }
      }

      // Say so now rather than after the timeout.
      const watchForPrompt = (text) => {
        if (sudoPassword) {
          // A wrong password makes sudo ask again, on a stdin that has
          // nothing more to give — a hang until the timeout, fifteen minutes
          // later, for a mistake that is known now.
          if (looksLikeWrongSudoPassword(text)) {
            abort('sudo refused the password this run gave it.', SUDO_PASSWORD_INCORRECT);
          }
          return;
        }
        if (looksLikePasswordPrompt(text)) {
          abort(
            'This host needs a sudo password, and this run had none to give.',
            SUDO_PASSWORD_REQUIRED
          );
        }
      };

      let sawSudoRefusal = false;
      const noteRefusal = (text) => {
        if (looksLikeSudoRefusal(text)) sawSudoRefusal = true;
      };

      stream.on('data', (data) => {
        const text = data.toString();
        watchForPrompt(text);
        noteRefusal(text);
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) emit(line);
        }
      });

      stream.stderr.on('data', (data) => {
        const text = data.toString();
        watchForPrompt(text);
        noteRefusal(text);
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) emit(`[stderr] ${line}`);
        }
      });

      stream.on('close', (code) => {
        client.end();
        if (code === 0 || code === null) {
          emit('[shellius] Provisioning completed successfully');
          settleOk();
        } else if (sawSudoRefusal) {
          // `sudo -n` did its job: it refused instead of hanging. Report it
          // as the one thing the operator can actually fix.
          settleErr(
            new ApiError(400, 'This host needs a sudo password, and this run had none to give.', {
              code: SUDO_PASSWORD_REQUIRED,
            })
          );
        } else {
          settleErr(new ApiError(500, `Bootstrap script exited with code ${code}`));
        }
      });
    });
  });
}
