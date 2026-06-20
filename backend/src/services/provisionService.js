import { Client } from 'ssh2';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

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
export async function provisionServer(orgId, serverId, { privateKey, sshUser, sudoPassword, bootstrapUrl, onOutput }) {
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

  return new Promise((resolve, reject) => {
    const conn = new Client();

    const emit = (line) => {
      if (onOutput) onOutput(line);
    };

    // Wrap resolve/reject so provisioning state is persisted before settling.
    const settleOk = () => markProvisioned().finally(() => resolve());
    const settleErr = (err) => markFailed(err?.message).finally(() => reject(err));

    conn.on('ready', () => {
      emit('[shellius] SSH connection established');

      // Build the remote command based on the privilege situation:
      //   root user       → pipe curl output directly to bash
      //   sudo + password → download script, then run with sudo -S (password via printf)
      //   sudo (no pass)  → pipe curl output to sudo bash (assumes passwordless sudo)
      let cmd;
      if (sshUser === 'root') {
        cmd = `curl -fsSL '${bootstrapUrl}' | bash`;
      } else if (sudoPassword) {
        // Single-quote-escape the sudo password for safe embedding in shell.
        const escapedPass = sudoPassword.replace(/'/g, "'\\''");
        cmd = [
          `curl -fsSL '${bootstrapUrl}' -o /tmp/.shellius-install.sh`,
          `printf '%s\\n' '${escapedPass}' | sudo -S bash /tmp/.shellius-install.sh`,
          'ec=$?',
          'rm -f /tmp/.shellius-install.sh',
          'exit $ec',
        ].join(' && ');
      } else {
        cmd = `curl -fsSL '${bootstrapUrl}' | sudo bash`;
      }

      conn.exec(cmd, { pty: true }, (err, stream) => {
        if (err) {
          conn.end();
          return settleErr(new ApiError(500, `SSH exec failed: ${err.message}`));
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
          conn.end();
          if (code === 0 || code === null) {
            emit('[shellius] Provisioning completed successfully');
            settleOk();
          } else {
            settleErr(new ApiError(500, `Bootstrap script exited with code ${code}`));
          }
        });
      });
    });

    conn.on('error', (err) => {
      // Log serverId only — never log the private key or credentials
      logger.error({ err: err.message, serverId }, 'SSH provision connection error');
      settleErr(new ApiError(500, `SSH connection failed: ${err.message}`));
    });

    conn.connect({
      host: server.ipAddress,
      port: 22,
      username: sshUser,
      privateKey,
      readyTimeout: 20000,
    });
  });
}
