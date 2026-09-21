/**
 * collectorHealth.js — turn what the posture collector said about itself
 * into what a person should understand and do about it.
 *
 * The raw degraded reason ("could not run 'ss' with the privilege needed to
 * see other users' sockets (sudo grant missing or ss not on sudoers path)")
 * is accurate and useless on its own: it names a mechanism, not a next step.
 * Each reason is matched to a plain explanation, whether reinstalling the
 * collector fixes it, and — when it does not — what does.
 *
 * Pure: no React, no I/O. Tested in collectorHealth.test.js.
 */

/** Commands to run ON the host to see why the collector is unhappy. */
export const HOST_CHECK_COMMANDS = [
  { label: 'Is the timer running?', command: 'systemctl status shellius-posture.timer --no-pager' },
  {
    // --no-block: the service is a one-shot capped at 20% CPU, so a blocking
    // `start` sits silent for 20-30 s and looks hung. The report script logs
    // under its tag, which `journalctl -u` often misses.
    label: 'Run it now, then read the result (takes about 30 s)',
    command: 'sudo systemctl start --no-block shellius-posture.service; sleep 40; sudo journalctl -t shellius-posture -n 3 --no-pager',
  },
  {
    // Exactly what the service sees: its user, its sandbox. Running the
    // collector as root skips sudo entirely and proves nothing.
    label: 'Run the collector exactly as the service does, and print what it reports',
    command: [
      'sudo systemd-run --quiet --pipe --wait -p User=shellius-posture -p PrivateTmp=yes',
      '-p ProtectSystem=full -p ProtectHome=read-only /usr/local/sbin/shellius-posture-collect',
      `| python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("agentVersion"),d["collectorOk"]);print(*d.get("degradedReasons",[]),sep=chr(10))'`,
    ].join(' '),
  },
  { label: 'Does its sudo grant work?', command: 'sudo -u shellius-posture sudo -n -l' },
];

const RULES = [
  {
    key: 'privilege',
    test: /could not run 'ss'|sudo grant missing|sudoers grant missing|'sudo [^']+' failed|no new privileges/i,
    title: 'Its sudo grant is not working',
    explain:
      'The collector runs as an unprivileged account and reads root-only data (every process’s sockets, the firewall) through a narrow sudo grant. That grant is failing, so owners and reachability show as unknown.',
    fix: 'Reinstall the collector — it rewrites both the grant and its service unit. If it still fails, run the host checks below.',
    reinstallFixes: true,
  },
  {
    key: 'own_user',
    // A consequence of the one above, not a separate problem — shown under it.
    test: /listener owners limited to the collector's own user/i,
    secondary: true,
  },
  {
    key: 'nat',
    test: /could not read the NAT table/i,
    title: 'It could not read the NAT table',
    explain:
      'Docker ports published without docker-proxy exist only as NAT rules. Without reading them, those ports can be missing from this report.',
    fix: 'Reinstall the collector to refresh its sudo grant.',
    reinstallFixes: true,
  },
  {
    key: 'firewall_unparsed',
    test: /cannot evaluate|input chains|not parsed|no usable firewall data/i,
    title: 'The firewall has rules it cannot evaluate',
    explain:
      'The host firewall uses rules the collector does not interpret (a custom chain, a negated match, several nftables input chains). Ports those rules could affect are shown with reachability Unknown rather than a guess.',
    fix: 'Nothing to reinstall — this is how the host’s firewall is built. Review the affected ports by hand, or mark them expected.',
    reinstallFixes: false,
  },
  {
    key: 'firewall_read',
    test: /(ufw|firewalld|iptables|nftables) present but/i,
    title: 'It could not read the firewall',
    explain: 'The firewall tool is installed, but reading its rules through the sudo grant failed.',
    fix: 'Reinstall the collector to refresh its sudo grant.',
    reinstallFixes: true,
  },
  {
    key: 'containers',
    test: /container id could not be resolved/i,
    title: 'Containers are shown by ID, not name',
    explain:
      'By design the collector has no access to the Docker socket, so a container behind a port is identified by its ID only.',
    fix: 'Informational. Reinstalling with container scan enabled also lists stopped containers by name.',
    reinstallFixes: false,
    informational: true,
  },
  {
    key: 'truncated',
    test: /only the first \d+ .*are reported/i,
    title: 'Too many sockets to report them all',
    explain: 'This host has more listening sockets than one snapshot carries; the lowest-numbered ports are reported.',
    fix: 'Informational.',
    reinstallFixes: false,
    informational: true,
  },
  {
    key: 'ss_missing',
    test: /'ss' not found/i,
    title: '`ss` is not installed',
    explain: 'The collector lists sockets with `ss` (iproute2), which this host does not have.',
    fix: 'Install iproute2 on the host (e.g. `sudo apt-get install -y iproute2`); the next run picks it up.',
    reinstallFixes: false,
  },
];

/**
 * @param {string[]} reasons  degradedReasons from the snapshot
 * @returns {{ items: Array<{key,title,explain,fix,reinstallFixes,informational,raw}>, reinstallHelps: boolean, onlyInformational: boolean }}
 */
export function explainDegraded(reasons = []) {
  const items = [];
  const seen = new Set();
  for (const raw of reasons.filter(Boolean)) {
    const rule = RULES.find((r) => r.test.test(raw));
    if (rule?.secondary) continue;
    const key = rule?.key || `other:${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(
      rule
        ? { key, title: rule.title, explain: rule.explain, fix: rule.fix, reinstallFixes: rule.reinstallFixes, informational: !!rule.informational, raw }
        : {
            key,
            title: 'The collector reported a problem',
            explain: raw,
            fix: 'Reinstalling the collector is the first thing to try; the host checks below show what it sees.',
            reinstallFixes: true,
            informational: false,
            raw,
          }
    );
  }
  return {
    items,
    reinstallHelps: items.some((i) => i.reinstallFixes),
    onlyInformational: items.length > 0 && items.every((i) => i.informational),
  };
}

/** Compare dotted versions; null/garbage sorts lowest. */
export function isOlderVersion(current, latest) {
  if (!latest) return false;
  if (!current) return true;
  const a = String(current).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const b = String(latest).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}

/**
 * One word for the collector, from the API's `collector.state` when present
 * (1.8+) and derived from the older fields otherwise.
 */
export function collectorStateOf(collector, snapshot) {
  if (collector?.state) return collector.state;
  if (!collector?.installed) return 'not_installed';
  if (collector.stale) return 'stale';
  if (snapshot?.collectorOk === false) return 'degraded';
  return 'reporting';
}
