import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import ApiError from '../utils/ApiError.js';
import * as caService from './caService.js';

/**
 * Short-lived certificates for installing on a host we already bootstrapped.
 *
 * A bootstrapped host trusts the org CA. That is the whole point of
 * bootstrapping — and yet the bulk installer used to skip those hosts for
 * "no saved identity", which is the exact inverse of the truth: the hosts
 * most ready to be installed on were the only ones being refused.
 *
 * The subtlety that makes this a service rather than three inline lines:
 * signing a cert is NOT enough. A bootstrapped host runs check-principals as
 * sshd's AuthorizedPrincipalsCommand, which calls
 * POST /api/certificates/verify, and certificateService.verify() looks the
 * serial up in the DB and requires `issuedForId` to be THIS host. A cert
 * signed by caService.signCertificate() alone has no row, so verify answers
 * "certificate not found" and sshd rejects the login. Every install cert
 * must therefore be persisted and bound to its server.
 *
 * Why not certificateService.issue()? That is the human access path: it
 * evaluates policy per principal and refuses prod outright. This is not a
 * user session — it is the platform running an installer on a host the
 * caller already administers, the same act that bulk install performs with a
 * stored password today under `servers.onboard`. It is gated by that
 * permission, audited by the calling route, and deliberately narrow:
 *
 *   - 300 seconds, minted at the moment of connection
 *   - one principal, the host's own sshUser
 *   - permit-pty only (the installer runs over an exec channel with a pty);
 *     no port forwarding, no agent forwarding, no X11
 *   - REVOKED in the DB as soon as the install finishes, so the window is
 *     the install itself and not the full TTL
 *   - the private key never touches disk outside a 0700 temp dir that is
 *     removed in a finally, and the buffer is zeroed
 */

const VALIDITY_SECONDS = 300;

/**
 * Mint an ephemeral key + certificate for installing on `server`.
 *
 * @returns {Promise<{privateKey: string, certificate: string, certId: string,
 *   principal: string, dispose: () => Promise<void>}>}
 */
export async function mintInstallCertificate({ orgId, server, principal, actorId = null }) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!server?.id) throw new ApiError(400, 'server is required');
  if (!principal) throw new ApiError(400, 'principal is required');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellius-install-'));
  let privateKeyBuf;
  try {
    const keyPath = path.join(tmpDir, 'id_ed25519');
    await new Promise((resolve, reject) => {
      const p = spawn('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q']);
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ssh-keygen exited ${code}`))));
    });
    const [privateKey, publicKey] = await Promise.all([
      fs.readFile(keyPath, 'utf8'),
      fs.readFile(`${keyPath}.pub`, 'utf8'),
    ]);
    privateKeyBuf = Buffer.from(privateKey, 'utf8');

    const keyId = `install-${server.id}-${Date.now()}`;
    const validAfter = new Date();
    const { signedCert, serial, caKeyPairId } = await caService.signCertificate({
      orgId,
      publicKey: publicKey.trim(),
      principals: [principal],
      validitySeconds: VALIDITY_SECONDS,
      certType: 'USER',
      keyId,
      extensions: { 'permit-pty': '' },
    });

    // The row check-principals will look up. Without it the host refuses the
    // cert it just helped us sign.
    const record = await prisma.certificate.create({
      data: {
        orgId,
        caKeyPairId,
        serial,
        type: 'USER',
        keyId,
        principals: [principal],
        publicKey: publicKey.trim(),
        signedCert,
        validAfter,
        validBefore: new Date(validAfter.getTime() + VALIDITY_SECONDS * 1000),
        extensions: { 'permit-pty': '' },
        status: 'ACTIVE',
        issuedToId: actorId,
        issuedForId: server.id,
        issuedVia: 'install',
      },
      select: { id: true },
    });

    return {
      privateKey,
      certificate: signedCert,
      certId: record.id,
      principal,
      dispose: () => revokeInstallCertificate(record.id),
    };
  } finally {
    if (privateKeyBuf) privateKeyBuf.fill(0);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Close the window early. Best-effort: the cert expires on its own in five
 * minutes regardless, so a failure here is logged, never surfaced as an
 * install failure.
 */
export async function revokeInstallCertificate(certId) {
  if (!certId) return;
  try {
    await prisma.certificate.update({
      where: { id: certId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
  } catch (err) {
    logger.warn('installCertService: could not revoke install certificate', {
      certId,
      error: err.message,
    });
  }
}

export default { mintInstallCertificate, revokeInstallCertificate, VALIDITY_SECONDS };
