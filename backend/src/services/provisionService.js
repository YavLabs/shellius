import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import * as sshConnect from './sshConnect.js';

/**
 * Provisions a server by SSHing in and running the Shellius bootstrap script.
 *
 * @param {string} orgId
 * @param {string} serverId
 * @param {object} opts
 * @param {string} opts.privateKey     - PEM-format SSH private key (never stored)
 * @param {string} opts.sshUser        - SSH username to connect as
 * @param {string} [opts.sudoPassword] - sudo password if needed (never stored)
 * @param {string} opts.bootstrapUrl   - full URL to the bootstrap install.sh
 * @param {function} opts.onOutput     - callback(line: string) for each output line
 * @returns {Promise<void>}
 */
export async function provisionServer(
  orgId,
  serverId,
  { privateKey, passphrase, password, sshUser, sudoPassword, bootstrapUrl, onOutput }
) {
  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) throw new ApiError(404, 'Server not found');

  // Mark provisioning in progress. lastProvisionAt records every attempt;
  // provisionedAt is only stamped on success below. This makes re-onboarding
  // idempotent and observable from the UI / bulk-import flow.
  await prisma.server.update({
    where: { id: serverId },
    data: { provisionStatus: 'provisioning', provisionError: null, lastProvisionAt: new Date() },
  }).catch((e) => logger.warn({ err: e.message, serverId }, 'failed to set provisioning state'));

  const markProvisioned = () =>
    prisma.server
      .update({ where: { id: serverId }, data: { provisionStatus: 'provisioned', provisionError: null, provisionedAt: new Date() } })
      .catch((e) => logger.warn({ err: e.message, serverId }, 'failed to set provisioned state'));

  const markFailed = (message) =>
    prisma.server
      .update({ where: { id: serverId }, data: { provisionStatus: 'failed', provisionError: String(message || 'unknown error').slice(0, 500) } })
      .catch((e) => logger.warn({ err: e.message, serverId }, 'failed to set failed state'));

  const emit = (line) => {
    if (onOutput) onOutput(line);
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

  // Build the remote command based on the privilege situation:
  //   root user       → pipe curl output directly to bash
  //   sudo + password → download script, then run with sudo -S (password via stdin)
  //   sudo (no pass)  → pipe curl output to sudo bash (assumes passwordless sudo)
  let cmd;
  if (sshUser === 'root') {
    cmd = `curl -fsSL '${bootstrapUrl}' | bash`;
  } else if (sudoPassword) {
    cmd = [
      `curl -fsSL '${bootstrapUrl}' -o /tmp/.shellius-install.sh`,
      `sudo -S bash /tmp/.shellius-install.sh`,
      'ec=$?',
      'rm -f /tmp/.shellius-install.sh',
      'exit $ec',
    ].join(' && ');
  } else {
    cmd = `curl -fsSL '${bootstrapUrl}' | sudo bash`;
  }

  return new Promise((resolve, reject) => {
    const settleOk = () => markProvisioned().finally(() => resolve());
    const settleErr = (err) => markFailed(err?.message).finally(() => reject(err));

    client.exec(cmd, { pty: true }, (err, stream) => {
      if (err) {
        client.end();
        return settleErr(new ApiError(500, `SSH exec failed: ${err.message}`));
      }

      // sudo -S reads the password from the exec channel's stdin — never
      // placed on the command line, never logged.
      if (sudoPassword && sshUser !== 'root') {
        try { stream.write(`${sudoPassword}\n`); } catch { /* ignore */ }
      }

      stream.on('data', (data) => {
        const lines = data.toString().split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) emit(line);
        }
      });

      stream.stderr.on('data', (data) => {
        const lines = data.toString().split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) emit(`[stderr] ${line}`);
        }
      });

      stream.on('close', (code) => {
        client.end();
        if (code === 0 || code === null) {
          emit('[shellius] Provisioning completed successfully');
          settleOk();
        } else {
          settleErr(new ApiError(500, `Bootstrap script exited with code ${code}`));
        }
      });
    });
  });
}
