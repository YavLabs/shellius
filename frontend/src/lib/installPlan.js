/**
 * Turning a bulk-install plan into the groups the UI shows.
 *
 * The coverage list and the installer used to answer the same question
 * differently. Coverage listed every host with no collector — including
 * Windows boxes and RDP-only hosts, which can never run one — with an
 * Install button on each and an "Install on all of them" that handed those
 * hosts to a planner that immediately refused them. The number you clicked
 * and the number that ran were never the same, and the gap could not be
 * closed by any action.
 *
 * So both surfaces read the same plan and group it the same way here. What
 * is actionable, what needs one more thing from you, and what is simply not
 * applicable are three different answers and are shown as three different
 * things.
 */

/** How a host will authenticate, in words rather than an enum. */
export const CREDENTIAL_SOURCE = {
  server: {
    label: 'Saved identity',
    hint: 'Uses the identity already bound to this server.',
  },
  certificate: {
    label: 'Certificate',
    hint: 'Already bootstrapped, so Shellius signs a 5-minute certificate — no stored password needed.',
  },
  supplied: {
    label: 'Credentials you supply',
    hint: 'Uses the identity or password you enter on the next step.',
  },
};

export function credentialSourceLabel(target) {
  const spec = CREDENTIAL_SOURCE[target?.credentialSource];
  if (!spec) return null;
  if (target.credentialSource === 'server' && target.credential?.name) {
    return `${spec.label}: ${target.credential.name}`;
  }
  return spec.label;
}

const NOT_APPLICABLE = new Set(['windows', 'rdp_only', 'inactive']);
const INSTALLED = new Set(['collector_installed', 'already_provisioned']);

/**
 * @param {object} plan  the response of POST /api/servers/bulk-install/plan
 * @returns {Array<{key, title, description, tone, rows, actionable}>}
 */
export function groupPlan(plan) {
  const targets = plan?.targets || [];
  const skipped = plan?.skipped || [];

  const installed = skipped.filter((s) => INSTALLED.has(s.reason));

  return [
    {
      key: 'ready',
      title: 'Ready to install',
      description: 'Shellius can reach these and knows how to authenticate.',
      tone: 'success',
      actionable: true,
      rows: targets,
    },
    {
      key: 'needs_credentials',
      title: 'Needs credentials',
      description:
        'No saved identity, and not bootstrapped — so there is nothing to connect with yet. Supply one identity for the batch on the next step, or store one per host.',
      tone: 'warning',
      actionable: false,
      rows: skipped.filter((s) => s.reason === 'no_credentials'),
    },
    {
      key: 'stale',
      title: 'Installed, but stopped reporting',
      description:
        'The collector is there and has gone quiet. Their exposure is unknown, not clean. Turn on “include hosts already done” to reinstall.',
      tone: 'warning',
      actionable: false,
      rows: installed.filter((s) => s.stale),
    },
    {
      key: 'installed',
      title: 'Already done',
      description: 'Nothing to do — these are reporting.',
      tone: 'success',
      actionable: false,
      rows: installed.filter((s) => !s.stale),
    },
    {
      key: 'not_applicable',
      title: 'Cannot run the collector',
      description:
        'Windows, RDP-only and inactive hosts. This is a correct end state, not a gap — they are left out of the coverage count rather than counted as missing.',
      tone: 'neutral',
      actionable: false,
      rows: skipped.filter((s) => NOT_APPLICABLE.has(s.reason)),
    },
  ];
}

/** Ready-to-install hosts, split by how each will authenticate. */
export function targetsByCredentialSource(targets = []) {
  const order = ['server', 'certificate', 'supplied'];
  return order
    .map((key) => ({ key, ...CREDENTIAL_SOURCE[key], rows: targets.filter((t) => t.credentialSource === key) }))
    .filter((g) => g.rows.length > 0);
}

/** Do any chosen hosts actually need the operator to type something? */
export function needsSuppliedCredentials(targets = []) {
  return targets.some((t) => t.credentialSource === 'supplied');
}
