/**
 * Who should be prompted to bootstrap, and why.
 *
 * One place, because the answer is needed in three: right after a server is
 * created, on every visit to Server Details, and when deciding whether to
 * show the install affordances at all. Three copies of this predicate would
 * drift, and the failure mode is nagging someone to install an agent on a
 * Windows box that can never run one.
 */

/** Can this host run the bootstrap at all? */
export function canBootstrapHost(server) {
  if (!server) return false;
  // Windows targets get nothing from the Linux bootstrap; RDP-only hosts have
  // no SSH channel to run it over. Both are correct end states, not gaps.
  if (server.osType === 'windows') return false;
  return server.protocol === 'ssh' || server.protocol === 'both';
}

/** Has it already been bootstrapped? */
export function isBootstrapped(server) {
  if (!server) return false;
  return server.provisionStatus === 'provisioned' || !!server.agentId;
}

/**
 * Should we actively prompt for this host?
 *
 * Deliberately narrower than `canBootstrapHost`. A credential-mode host
 * already works — Shellius connects with the stored identity — so bootstrap
 * is an upgrade it can be *offered*, never a thing to interrupt someone
 * about. Prompting is for certificate-mode hosts, which cannot be reached
 * until the bootstrap has run.
 */
export function shouldPromptBootstrap(server, { canOnboard = false } = {}) {
  if (!canOnboard) return false;
  if (!canBootstrapHost(server)) return false;
  if (isBootstrapped(server)) return false;
  return server.authMode !== 'credential';
}

/**
 * Why a host is not being prompted — used to explain the absence rather than
 * silently showing nothing. Returns null when it IS eligible.
 */
export function bootstrapIneligibleReason(server) {
  if (!server) return null;
  if (server.osType === 'windows') {
    return 'Windows hosts do not run the Shellius agent. Access is by stored credentials over RDP or SSH.';
  }
  if (server.protocol === 'rdp') {
    return 'RDP-only hosts need no agent — Shellius injects credentials through the gateway at connect time.';
  }
  if (isBootstrapped(server)) return null;
  if (server.authMode === 'credential') {
    return 'This host connects with a stored identity, so it already works. Bootstrapping is optional — it adds the posture collector, or upgrades the host to certificate authentication.';
  }
  return null;
}

export default { canBootstrapHost, isBootstrapped, shouldPromptBootstrap, bootstrapIneligibleReason };
