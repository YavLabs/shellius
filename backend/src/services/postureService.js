/**
 * postureService.js — posture ingest + the exposure findings engine.
 *
 * See docs/posture/posture-spec.md (§2, §3, §5, §9) and
 * .posture-wip/posture-design.md §3 for the full specification. The
 * reference collector (`.posture-wip/shellius-posture-scan.sh`) computes its
 * own reachability/finding verdicts on the host and ships them in its JSON
 * output, but THIS SERVICE NEVER TRUSTS THOSE — the snapshot is
 * attacker-controlled input from a host that may already be compromised, and
 * a compromised host that gets to self-report "clean" defeats the entire
 * product. Only raw, directly-observable facts are accepted from the agent
 * (bind address, port, container port, process/owner evidence, raw firewall
 * rules); reachability, service identification and findings are always
 * recomputed here from those raw facts.
 *
 * Firewall engines: ufw and firewalld are both normalized, at ingest, into
 * one shape — `{ engine, active, defaultIncoming, rules: [{port, proto,
 * action, from, family}] }` — because both reduce to the same "is there a
 * rule that allows/denies this port, and what is the default policy" verdict
 * (spec §5: "firewall-cmd --list-all ... feeds the same ALLOW/DENY/
 * default-deny verdict logic"). Engines we cannot reason about precisely
 * (nftables/iptables/unknown) are never used to derive a verdict — ports
 * behind them get FIREWALL_STATE_UNKNOWN rather than a guessed FIREWALLED.
 */

import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import * as postureAlertService from './postureAlertService.js';

// ---------------------------------------------------------------------------
// Port / service knowledge base (mirrors shellius-posture-scan.sh exactly —
// see .posture-wip/posture-design.md §3.4/§3.5).
// ---------------------------------------------------------------------------

const SENSITIVE_PORTS = {
  5432: 'PostgreSQL', 3306: 'MySQL/MariaDB', 1433: 'MSSQL',
  27017: 'MongoDB', 27018: 'MongoDB', 6379: 'Redis',
  11211: 'Memcached', 9200: 'Elasticsearch', 9300: 'Elasticsearch cluster',
  5984: 'CouchDB', 8086: 'InfluxDB', 9042: 'Cassandra',
  2375: 'Docker API (plaintext)', 2376: 'Docker API (TLS)',
  2379: 'etcd', 8500: 'Consul', 4646: 'Nomad',
  5672: 'RabbitMQ AMQP', 15672: 'RabbitMQ mgmt',
  9090: 'Prometheus', 9093: 'Alertmanager', 9100: 'node_exporter',
  5601: 'Kibana', 3389: 'RDP', 5900: 'VNC',
  2049: 'NFS', 445: 'SMB', 139: 'NetBIOS',
  25: 'SMTP', 10250: 'kubelet', 6443: 'Kubernetes API',
  7474: 'Neo4j', 8009: 'AJP', 50070: 'Hadoop NN',
};

const EXPECTED_PUBLIC_BUILTIN = { 22: 'SSH', 80: 'HTTP', 443: 'HTTPS' };

// Evidence order 3-5 of §3.4 — identify a remapped service from image / unit
// / process name when the port number alone doesn't tell us anything.
const NAME_SENSITIVE_RULES = [
  [/postgres|timescale|pgvector|postgis/i, 'PostgreSQL'],
  [/redis|valkey/i, 'Redis'],
  [/mongo/i, 'MongoDB'],
  [/mysql|mariadb|percona/i, 'MySQL/MariaDB'],
  [/elasticsearch|opensearch/i, 'Elasticsearch'],
  [/clickhouse/i, 'ClickHouse'],
  [/rabbitmq/i, 'RabbitMQ'],
  [/memcached/i, 'Memcached'],
  [/cassandra/i, 'Cassandra'],
  [/influxdb/i, 'InfluxDB'],
  [/neo4j/i, 'Neo4j'],
  [/couchdb/i, 'CouchDB'],
  [/minio/i, 'MinIO'],
  [/etcd/i, 'etcd'],
  [/mssql|sqlserver/i, 'MSSQL'],
];

const SEVERITY_RANK = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

const SEVERITY = {
  DOCKER_FIREWALL_BYPASS: 'CRITICAL',
  SENSITIVE_PORT_EXPOSED: 'CRITICAL',
  PORT_EXPOSED: 'HIGH',
  NO_HOST_FIREWALL: 'HIGH',
  FIREWALL_INACTIVE: 'HIGH',
  SENSITIVE_PORT_WILDCARD_BIND: 'MEDIUM',
  SENSITIVE_PORT_LAN: 'LOW',
  STALE_FIREWALL_RULE: 'LOW',
  // A port that is closed only because the thing behind it happens to be
  // stopped. MEDIUM, not HIGH: it is not reachable right now — but nothing
  // stands between it and being reachable except a `docker start`.
  STOPPED_SERVICE_PORT_OPEN: 'MEDIUM',
  UNATTRIBUTED_LISTENER: 'LOW',
  EXPECTED_PUBLIC: 'INFO',
  FIREWALL_STATE_UNKNOWN: 'INFO',
};

// Engines we trust to say ALLOW/DENY for an individual port. Everything else
// (nftables, iptables, unrecognized) withholds a verdict rather than guesses
// one — see decision #8 in docs/posture/posture-spec.md.
const VERDICT_CAPABLE_ENGINES = new Set(['ufw', 'firewalld', 'none']);

const REACH_RANK = { INTERNET: 5, LAN: 4, FIREWALLED: 3, UNKNOWN: 2, LOOPBACK: 1 };

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function normalizeBind(bind) {
  let b = String(bind ?? '').trim();
  b = b.replace(/%.*$/, ''); // strip %iface suffix
  if (b.startsWith('[') && b.endsWith(']')) b = b.slice(1, -1);
  if (b === '*' || b === '') b = '0.0.0.0';
  return b;
}

function bindClass(bind) {
  const b = normalizeBind(bind);
  if (b === '0.0.0.0' || b === '::') return 'wildcard';
  if (b === '127.0.0.1' || b.startsWith('127.') || b === '::1') return 'loopback';
  if (
    /^10\./.test(b) ||
    /^192\.168\./.test(b) ||
    /^169\.254\./.test(b) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(b) ||
    /^(fe80:|fc|fd)/i.test(b)
  ) {
    return 'private';
  }
  return 'specific';
}

function nameSensitive(str) {
  if (!str) return '';
  for (const [re, label] of NAME_SENSITIVE_RULES) {
    if (re.test(str)) return label;
  }
  return '';
}

function portLabel(port) {
  return SENSITIVE_PORTS[port] || '';
}

// Evidence order per §3.4: container port is authoritative when present
// (never fall back to the host port lookup in that case — a WordPress
// container published on host port 8086 must not become "InfluxDB exposed"
// just because 8086 happens to be InfluxDB's default).
function serviceIdentity({ hostPort, containerPort, ownerDetail, ownerName, processName }) {
  let s;
  if (containerPort) {
    s = portLabel(containerPort);
    if (s) return s;
  } else {
    s = portLabel(hostPort);
    if (s) return s;
  }
  s = nameSensitive(ownerDetail);
  if (s) return s;
  s = nameSensitive(ownerName);
  if (s) return s;
  s = nameSensitive(processName);
  if (s) return s;
  return '';
}

function ownerLabelFor(l) {
  const name = l.ownerName || 'unknown';
  switch (l.ownerKind) {
    case 'docker': return `docker/${name}`;
    case 'docker-rootless': return `docker*/${name}`;
    case 'podman': return `podman/${name}`;
    case 'podman-rootless': return `podman*/${name}`;
    case 'container': return name;
    case 'docker-proxy': return `docker/(proxy ${l.ownerDetail || '?'})`;
    case 'pm2': return `pm2/${name}`;
    case 'systemd': return `systemd/${name}`;
    case 'systemd-user': return `systemd*/${name}`;
    case 'unknown':
    case undefined:
    case null:
    case '':
      return `unknown(${name})`;
    default:
      return name;
  }
}

function isPlaceholderOwnerLabel(label) {
  return !label || label.startsWith('unknown(') || label.startsWith('docker/(proxy');
}

function firstPid(pidsStr) {
  if (!pidsStr) return null;
  const first = String(pidsStr).split(',')[0].trim();
  const n = Number.parseInt(first, 10);
  return Number.isFinite(n) ? n : null;
}

function portSpecMatches(spec, port) {
  if (spec == null) return false;
  const s = String(spec).trim();
  if (!/^[0-9,:]+$/.test(s)) return false;
  if (s.includes(':')) {
    const [lo, hi] = s.split(':').map(Number);
    return Number.isFinite(lo) && Number.isFinite(hi) && port >= lo && port <= hi;
  }
  if (s.includes(',')) {
    return s.split(',').map(Number).includes(port);
  }
  return Number(s) === port;
}

/**
 * Build a firewall verdict context from the normalized `firewall` block.
 * Both ufw and firewalld rules are expected in the same `rules` shape by the
 * time they reach here (§5) — this function does not need to know which
 * engine produced them, only whether the engine is one we trust at all.
 */
function buildFirewallContext(firewall) {
  const engine = firewall?.engine || 'unknown';
  const usable = VERDICT_CAPABLE_ENGINES.has(engine);
  const active = !!firewall?.active;
  const defaultIncoming = firewall?.defaultIncoming || 'unknown';
  const rules = Array.isArray(firewall?.rules) ? firewall.rules : [];

  function matchPort(port, proto, familyFilter) {
    for (const rule of rules) {
      if (!rule) continue;
      const ruleProto = rule.proto || 'any';
      if (ruleProto !== 'any' && ruleProto !== proto) continue;
      const ruleFamily = rule.family || 'any';
      if (familyFilter) {
        if (ruleFamily !== familyFilter) continue;
      }
      if (!portSpecMatches(rule.port, port)) continue;
      if (rule.action === 'ALLOW' || rule.action === 'LIMIT') return 'ALLOW';
      if (rule.action === 'DENY' || rule.action === 'REJECT') return 'DENY';
    }
    return 'NONE';
  }

  return {
    engine,
    usable,
    active,
    defaultIncoming,
    rules,
    // Overall verdict, considering every rule regardless of address family.
    matchPort: (port, proto) => matchPort(port, proto, null),
    // Edge case #5 (spec §9.5): asymmetric v4/v6 policy. Only meaningful
    // when the payload actually tags rules with a family — the common case
    // (ufw with no v4/v6 split reported) never trips this.
    isAsymmetric: (port, proto) => {
      const v4 = matchPort(port, proto, 'v4');
      const v6 = matchPort(port, proto, 'v6');
      return v4 !== 'NONE' && v6 !== 'NONE' && v4 !== v6;
    },
  };
}

function reachabilityFor(listener, fwCtx) {
  const bind = normalizeBind(listener.bind);
  const bc = bindClass(bind);
  const isDockerPublish = listener.source === 'docker' || listener.ownerKind === 'docker-proxy';

  if (bc === 'loopback') {
    return { reachability: 'LOOPBACK', bindClass: bc, bind, dockerBypass: false };
  }

  if (isDockerPublish) {
    // Docker's published-port traffic is DNAT'd in nat/PREROUTING and
    // traverses FORWARD — it never enters INPUT/the host's own zone rules,
    // so it is reachable regardless of what those rules say. This is
    // certain, not a guess, so it never yields FIREWALL_STATE_UNKNOWN.
    let dockerBypass = false;
    if (fwCtx.usable) {
      const verdict = fwCtx.matchPort(listener.port, listener.proto);
      if (verdict === 'DENY' || (fwCtx.active && verdict === 'NONE' && fwCtx.defaultIncoming === 'deny')) {
        dockerBypass = true;
      }
    }
    return { reachability: 'INTERNET', bindClass: bc, bind, dockerBypass };
  }

  if (bc === 'private') {
    return { reachability: 'LAN', bindClass: bc, bind, dockerBypass: false };
  }

  // wildcard or specific public bind, native (non-Docker) listener.
  if (!fwCtx.usable) {
    return { reachability: 'UNKNOWN', bindClass: bc, bind, dockerBypass: false };
  }
  if (fwCtx.isAsymmetric(listener.port, listener.proto)) {
    return { reachability: 'UNKNOWN', bindClass: bc, bind, dockerBypass: false };
  }

  const verdict = fwCtx.matchPort(listener.port, listener.proto);
  let reachability;
  if (verdict === 'ALLOW') reachability = 'INTERNET';
  else if (verdict === 'DENY') reachability = 'FIREWALLED';
  else if (fwCtx.active && fwCtx.defaultIncoming === 'deny') reachability = 'FIREWALLED';
  else reachability = 'INTERNET';

  return { reachability, bindClass: bc, bind, dockerBypass: false };
}

/**
 * Is this port expected to be public?
 *
 * Three sources, most specific first. A per-server entry is checked before
 * the org list so "8080 is expected on this demo box" never has to be
 * expressed as "8080 is expected everywhere" — which is what the org list
 * alone forced, and why a database host could be silenced by a decision
 * someone made about a web server.
 */
function isExpectedPublic(port, proto, expectedPublicPorts) {
  for (const rule of expectedPublicPorts || []) {
    if (!rule) continue;
    if (Number(rule.port) !== port) continue;
    const ruleProto = rule.proto || 'any';
    if (ruleProto !== 'any' && ruleProto !== proto) continue;
    return {
      matched: true,
      source: rule.scope === 'server' ? 'server' : 'setting',
      label: rule.label || rule.note || EXPECTED_PUBLIC_BUILTIN[port] || `port ${port}`,
    };
  }
  if (EXPECTED_PUBLIC_BUILTIN[port]) {
    return { matched: true, source: 'builtin', label: EXPECTED_PUBLIC_BUILTIN[port] };
  }
  return { matched: false };
}

function mkFinding(code, proto, port, ownerLabel, service, message, detail) {
  return {
    code,
    severity: SEVERITY[code],
    proto: proto ?? null,
    port: port ?? null,
    ownerLabel: ownerLabel ?? null,
    service: service ?? null,
    message,
    detail: detail || {},
  };
}

/**
 * computeFindings(snapshot, settings) — pure. No DB, no I/O.
 *
 * @param {object} snapshot
 * @param {object} snapshot.firewall  { engine, active, defaultIncoming, rules }
 * @param {Array}  snapshot.listeners raw listener facts (see routes/hosts.js
 *                 for the accepted shape) — proto, bind, port, containerPort,
 *                 pids, process, ownerKind, ownerName, ownerDetail, ownerRef,
 *                 ownerUser, sourcePath, source.
 * @param {object} settings
 * @param {Array}  settings.expectedPublicPorts [{ port, proto, label }]
 * @returns {{ listeners: Array, findings: Array }}
 *   `listeners` are enriched with bindClass/reachability/service/ownerLabel —
 *   this is what gets persisted to HostListener. `findings` are plain
 *   objects (code/severity/proto/port/ownerLabel/service/message/detail);
 *   identity/diffing against stored ExposureFinding rows happens in ingest().
 */
export function computeFindings(snapshot, settings = {}) {
  const firewall = snapshot?.firewall || { engine: 'unknown', active: false, defaultIncoming: 'unknown', rules: [] };
  const rawListeners = Array.isArray(snapshot?.listeners) ? snapshot.listeners : [];
  // Installed-but-not-running services. `ss` cannot see these at all, so
  // without them a firewall rule for a stopped container's port looks like
  // an abandoned rule rather than a service waiting to re-open it.
  const stoppedServices = (Array.isArray(snapshot?.services) ? snapshot.services : []).filter(
    (svc) => svc && svc.running === false
  );

  /** The stopped service that declares this port, if any. */
  const stoppedOwnerOf = (proto, port) =>
    stoppedServices.find((svc) =>
      (Array.isArray(svc.ports) ? svc.ports : []).some(
        (dp) => Number(dp.port) === Number(port) && (!proto || proto === 'any' || dp.proto === proto)
      )
    ) || null;

  /** How to name a service in a finding message. */
  const svcLabel = (svc) => {
    if (!svc) return 'a service';
    if (svc.kind === 'docker' || svc.kind === 'podman') return `the ${svc.kind} container “${svc.name}”`;
    if (svc.kind === 'systemd') return `the unit ${svc.name}`;
    if (svc.kind === 'pm2') return `the pm2 app “${svc.name}”`;
    return `“${svc.name}”`;
  };
  // Per-server entries first so the most specific rule wins the match.
  const serverExpected = Array.isArray(settings?.serverExpectedPorts) ? settings.serverExpectedPorts : [];
  const expectedPublicPorts = [
    ...serverExpected.map((r) => ({ ...r, scope: 'server' })),
    ...(Array.isArray(settings?.expectedPublicPorts) ? settings.expectedPublicPorts : []),
  ];

  const fwCtx = buildFirewallContext(firewall);

  const enriched = rawListeners.map((l) => {
    const { reachability, bindClass: bc, bind, dockerBypass } = reachabilityFor(l, fwCtx);
    const service = serviceIdentity({
      hostPort: l.port,
      containerPort: l.containerPort || null,
      ownerDetail: l.ownerDetail,
      ownerName: l.ownerName,
      processName: l.process,
    });
    return {
      proto: l.proto,
      bind,
      port: l.port,
      containerPort: l.containerPort || null,
      bindClass: bc,
      reachability,
      service: service || null,
      ownerKind: l.ownerKind || 'unknown',
      ownerName: l.ownerName || 'unknown',
      ownerDetail: l.ownerDetail || null,
      ownerRef: l.ownerRef || null,
      ownerUser: l.ownerUser || null,
      sourcePath: l.sourcePath || null,
      pid: firstPid(l.pids),
      ownerLabel: ownerLabelFor(l),
      dockerBypass,
      source: l.source || 'ss',
    };
  });

  // Roll up per proto:port — worst bind wins for reachability (matches the
  // reference collector: a port that's INTERNET on one bind and LOOPBACK on
  // another is reported as INTERNET), richest owner/service info wins
  // regardless of which bind produced it.
  const agg = new Map();
  const seenPorts = new Set();

  for (const l of enriched) {
    const key = `${l.proto}:${l.port}`;
    seenPorts.add(key);
    let a = agg.get(key);
    if (!a) {
      a = {
        proto: l.proto,
        port: l.port,
        reachability: l.reachability,
        bind: l.bind,
        ownerLabel: l.ownerLabel,
        service: l.service,
        dockerBypass: false,
      };
      agg.set(key, a);
    }
    if (REACH_RANK[l.reachability] > REACH_RANK[a.reachability]) {
      a.reachability = l.reachability;
      a.bind = l.bind;
    }
    if (isPlaceholderOwnerLabel(a.ownerLabel) && !isPlaceholderOwnerLabel(l.ownerLabel)) {
      a.ownerLabel = l.ownerLabel;
    }
    if (!a.service && l.service) a.service = l.service;
    if (l.dockerBypass) a.dockerBypass = true;
  }

  const findings = [];

  for (const a of agg.values()) {
    const { proto, port, reachability, bind, ownerLabel, service, dockerBypass } = a;

    if (dockerBypass) {
      findings.push(mkFinding(
        'DOCKER_FIREWALL_BYPASS', proto, port, ownerLabel, service,
        `${service ? `${service} — ` : ''}Docker publishes this port; the DNAT rule bypasses the host firewall's input rules, so the rule covering it is NOT enforced. Bind to 127.0.0.1, or use a Docker-aware firewall integration (ufw-docker / firewalld's docker zone).`,
        { bind, firewallEngine: firewall.engine },
      ));
      continue;
    }

    if (reachability === 'INTERNET') {
      if (service) {
        findings.push(mkFinding(
          'SENSITIVE_PORT_EXPOSED', proto, port, ownerLabel, service,
          `${service} is reachable from any source address.`,
          { bind },
        ));
      } else {
        const expected = isExpectedPublic(port, proto, expectedPublicPorts);
        if (expected.matched) {
          findings.push(mkFinding(
            'EXPECTED_PUBLIC', proto, port, ownerLabel, expected.label,
            `${expected.label} — public exposure is expected here.`,
            { bind, matchedBy: expected.source },
          ));
        } else {
          findings.push(mkFinding(
            'PORT_EXPOSED', proto, port, ownerLabel, service,
            'Reachable from any source address and not a known-public service. Confirm this is intended.',
            { bind },
          ));
        }
      }
    } else if (reachability === 'FIREWALLED') {
      if (service) {
        findings.push(mkFinding(
          'SENSITIVE_PORT_WILDCARD_BIND', proto, port, ownerLabel, service,
          `${service} binds ${bind} and is protected only by a firewall rule. Bind it to 127.0.0.1 so it is safe by construction, not by one firewall rule.`,
          { bind },
        ));
      }
    } else if (reachability === 'LAN') {
      if (service) {
        findings.push(mkFinding(
          'SENSITIVE_PORT_LAN', proto, port, ownerLabel, service,
          `${service} is reachable from the local network.`,
          { bind },
        ));
      }
    } else if (reachability === 'UNKNOWN') {
      findings.push(mkFinding(
        'FIREWALL_STATE_UNKNOWN', proto, port, ownerLabel, service,
        'The firewall state for this host could not be evaluated with confidence (unsupported engine, or asymmetric IPv4/IPv6 policy), so reachability for this port is unknown rather than assumed safe.',
        { bind, firewallEngine: firewall.engine },
      ));
    }
    // LOOPBACK: no finding.

    if (isPlaceholderOwnerLabel(ownerLabel) && ownerLabel.startsWith('unknown(')) {
      findings.push(mkFinding(
        'UNATTRIBUTED_LISTENER', proto, port, ownerLabel, service,
        'Could not attribute this listener to a container, pm2 app or systemd unit.',
        { bind },
      ));
    }
  }

  // Stale rules — an ALLOW for a port nothing listens on. Only meaningful
  // for engines whose rules we trust; ranges are skipped (too noisy, matches
  // the reference collector).
  if (fwCtx.usable) {
    for (const rule of fwCtx.rules) {
      if (!rule || (rule.action !== 'ALLOW' && rule.action !== 'LIMIT')) continue;
      const spec = String(rule.port || '').trim();
      if (spec.includes(':')) continue;
      const ports = spec.split(',').map(Number).filter(Number.isFinite);
      for (const p of ports) {
        const hit = seenPorts.has(`tcp:${p}`) || seenPorts.has(`udp:${p}`);
        if (hit) continue;

        // "Nothing is listening" and "the thing that listens here is
        // stopped" look identical from a socket table and mean opposite
        // things: one rule should be deleted, the other is a service that
        // re-opens this port the moment it starts.
        const owner = stoppedOwnerOf(rule.proto, p);
        if (owner) {
          findings.push(mkFinding(
            'STOPPED_SERVICE_PORT_OPEN', rule.proto || 'any', p,
            `${owner.kind}/${owner.name}`, null,
            `${svcLabel(owner)} is ${owner.state} but the firewall still allows this port from ${rule.from || 'Anywhere'}. ` +
              'It becomes reachable again the moment the service starts — either start it deliberately or remove the rule.',
            {
              from: rule.from || 'Anywhere',
              serviceKind: owner.kind,
              serviceName: owner.name,
              serviceState: owner.state,
              serviceStatus: owner.statusText || null,
              exitCode: Number.isInteger(owner.exitCode) ? owner.exitCode : null,
            },
          ));
          continue;
        }

        findings.push(mkFinding(
          'STALE_FIREWALL_RULE', rule.proto || 'any', p, null, null,
          `The firewall allows this port from ${rule.from || 'Anywhere'}, but nothing is listening on it. The rule can likely be removed.`,
          { from: rule.from || 'Anywhere' },
        ));
      }
    }
  }

  if (firewall.engine === 'none') {
    findings.push(mkFinding(
      'NO_HOST_FIREWALL', null, null, null, null,
      'No host firewall detected — every listening port is reachable unless something upstream blocks it.',
      {},
    ));
  } else if ((firewall.engine === 'ufw' || firewall.engine === 'firewalld') && !firewall.active) {
    findings.push(mkFinding(
      'FIREWALL_INACTIVE', null, null, null, null,
      `${firewall.engine} is installed but inactive. Its rules are not being enforced.`,
      { firewallEngine: firewall.engine },
    ));
  }

  return { listeners: enriched, findings };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

function findingKey(code, proto, port) {
  return `${code}::${proto ?? ''}::${port ?? ''}`;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hasAnyMetric(metrics) {
  if (!metrics) return false;
  return [metrics.cpuPct, metrics.memPct, metrics.diskPct, metrics.load1].some(
    (v) => typeof v === 'number' && Number.isFinite(v),
  );
}

async function getSettings(orgId) {
  const row = await prisma.postureSettings.findUnique({ where: { orgId } });
  const expectedPublicPorts = Array.isArray(row?.expectedPublicPorts) ? row.expectedPublicPorts : [];
  return { expectedPublicPorts };
}

/**
 * ingest(orgId, serverId, payload) — orgId/serverId MUST come from the
 * agent's per-host token identity (agentAuth), never from the request body.
 * `payload` is the Joi-validated posture snapshot from routes/hosts.js.
 */
export async function ingest(orgId, serverId, payload) {
  const [settings, serverExpectedPorts] = await Promise.all([
    getSettings(orgId),
    prisma.serverExpectedPort.findMany({
      where: { orgId, serverId },
      select: { port: true, proto: true, note: true },
    }),
  ]);
  const collectedAt = payload.collectedAt instanceof Date ? payload.collectedAt : new Date(payload.collectedAt);

  const latest = await prisma.hostSnapshot.findFirst({
    where: { orgId, serverId },
    orderBy: { collectedAt: 'desc' },
    select: { collectedAt: true },
  });
  // Clock skew / idempotency (spec §3): a snapshot no newer than the newest
  // one we already have is kept for history but must never move finding
  // state — otherwise a late retry (or a replayed old payload) could
  // resurrect a finding that a more recent snapshot already resolved.
  const outOfOrder = !!(latest && collectedAt.getTime() <= latest.collectedAt.getTime());

  const firewallSummary = {
    engine: payload.firewall.engine,
    active: !!payload.firewall.active,
    defaultIncoming: payload.firewall.defaultIncoming,
  };

  const snapshot = await prisma.hostSnapshot.create({
    data: {
      orgId,
      serverId,
      collectedAt,
      agentVersion: payload.agentVersion || null,
      collectorOk: payload.collectorOk !== false,
      degradedReason: payload.degradedReason || null,
      firewall: firewallSummary,
      raw: payload,
    },
  });

  if (hasAnyMetric(payload.metrics)) {
    try {
      await prisma.hostMetricSample.create({
        data: {
          orgId,
          serverId,
          at: collectedAt,
          cpuPct: numOrNull(payload.metrics.cpuPct),
          memPct: numOrNull(payload.metrics.memPct),
          diskPct: numOrNull(payload.metrics.diskPct),
          load1: numOrNull(payload.metrics.load1),
        },
      });
    } catch (err) {
      logger.warn('postureService.ingest: failed to store metric sample', { serverId, error: err.message });
    }
  }

  if (outOfOrder) {
    logger.info('postureService.ingest: snapshot not newer than latest known — kept for history, finding state unchanged', {
      orgId, serverId, snapshotId: snapshot.id,
    });
    return {
      snapshotId: snapshot.id,
      outOfOrder: true,
      listenersReplaced: false,
      servicesReplaced: false,
      findings: { opened: 0, continuing: 0, reopened: 0, resolved: 0 },
    };
  }

  const services = Array.isArray(payload.services) ? payload.services : [];

  const { listeners, findings } = computeFindings(
    { firewall: payload.firewall, listeners: payload.listeners, services },
    { ...settings, serverExpectedPorts },
  );

  // The (org, server, code, proto, port) unique constraint has no "open vs
  // resolved" dimension, so a RESOLVED row for a key still occupies it — a
  // finding that reappears after resolving must UPDATE that row (clearing
  // resolvedAt) rather than create(), which would collide. Fetch every row
  // for this server, not just the currently-open ones, so we can tell
  // "never existed" (create) apart from "existed but resolved" (reopen).
  const existingAll = await prisma.exposureFinding.findMany({ where: { orgId, serverId } });
  const existingByKey = new Map(existingAll.map((f) => [findingKey(f.code, f.proto, f.port), f]));
  const newByKey = new Map(findings.map((f) => [findingKey(f.code, f.proto, f.port), f]));

  const summary = { opened: 0, continuing: 0, reopened: 0, resolved: 0 };
  // Which findings actually transitioned, not just how many — the alert
  // dispatcher routes on transitions (spec §6: "transitions notify, scans do
  // not"), so it needs the rows, and a severity increase counts as one too.
  const events = [];
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.hostListener.deleteMany({ where: { serverId } });
    // Same replace-wholesale contract as listeners: this table is the host's
    // CURRENT state, never its history. postureInventoryService reads it
    // directly on that basis.
    await tx.hostService.deleteMany({ where: { serverId } });
    if (services.length) {
      await tx.hostService.createMany({
        data: services.map((svc) => ({
          orgId,
          serverId,
          snapshotId: snapshot.id,
          kind: svc.kind || 'unknown',
          name: svc.name || svc.ref || 'unknown',
          ref: svc.ref || null,
          state: svc.state || 'unknown',
          running: !!svc.running,
          statusText: svc.statusText || null,
          detail: svc.detail || null,
          sourcePath: svc.sourcePath || null,
          ports: Array.isArray(svc.ports) ? svc.ports : [],
          exitCode: Number.isInteger(svc.exitCode) ? svc.exitCode : null,
        })),
      });
    }
    if (listeners.length) {
      await tx.hostListener.createMany({
        data: listeners.map((l) => ({
          orgId,
          serverId,
          snapshotId: snapshot.id,
          proto: l.proto,
          bind: l.bind,
          port: l.port,
          containerPort: l.containerPort,
          bindClass: l.bindClass,
          reachability: l.reachability,
          service: l.service,
          ownerKind: l.ownerKind,
          ownerName: l.ownerName,
          ownerDetail: l.ownerDetail,
          ownerRef: l.ownerRef,
          ownerUser: l.ownerUser,
          sourcePath: l.sourcePath,
          pid: l.pid,
        })),
      });
    }

    const createFinding = (incoming) => tx.exposureFinding.create({
      data: {
        orgId,
        serverId,
        code: incoming.code,
        severity: incoming.severity,
        proto: incoming.proto,
        port: incoming.port,
        service: incoming.service,
        ownerLabel: incoming.ownerLabel,
        message: incoming.message,
        detail: incoming.detail,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });

    for (const [key, incoming] of newByKey) {
      const existing = existingByKey.get(key);

      if (!existing) {
        await createFinding(incoming);
        summary.opened += 1;
        events.push({ type: 'opened', finding: incoming });
        continue;
      }

      if (existing.resolvedAt) {
        // A row already occupies this (code, proto, port) but it was
        // resolved — the finding is reappearing. UPDATE it (clearing
        // resolvedAt), never create(): the unique constraint has no
        // open/resolved dimension, so a second row for the same key would
        // collide. This still counts as a fresh occurrence for the caller.
        await tx.exposureFinding.update({
          where: { id: existing.id },
          data: {
            severity: incoming.severity,
            service: incoming.service,
            ownerLabel: incoming.ownerLabel,
            message: incoming.message,
            detail: incoming.detail,
            firstSeenAt: now,
            lastSeenAt: now,
            resolvedAt: null,
            acknowledgedAt: null,
            acknowledgedById: null,
          },
        });
        summary.reopened += 1;
        events.push({ type: 'reopened', finding: incoming });
        continue;
      }

      // Edge case #9 (spec §9.9): if the OWNER of this open (code, proto,
      // port) changed, close the old finding and open a new one instead of
      // mutating in place. The unique constraint is on (org, server, code,
      // proto, port) with no state dimension, so "close + open" can only be
      // expressed as delete-then-recreate — this still gives the new
      // occupant its own firstSeenAt rather than silently inheriting the
      // previous tenant's "open since" date.
      const ownerChanged =
        existing.ownerLabel != null &&
        incoming.ownerLabel != null &&
        existing.ownerLabel !== incoming.ownerLabel;

      if (ownerChanged) {
        await tx.exposureFinding.delete({ where: { id: existing.id } });
        await createFinding(incoming);
        summary.opened += 1;
        events.push({ type: 'opened', finding: incoming });
        continue;
      }

      await tx.exposureFinding.update({
        where: { id: existing.id },
        data: {
          severity: incoming.severity,
          service: incoming.service,
          ownerLabel: incoming.ownerLabel,
          message: incoming.message,
          detail: incoming.detail,
          lastSeenAt: now,
        },
      });
      summary.continuing += 1;
      if (SEVERITY_RANK[incoming.severity] > SEVERITY_RANK[existing.severity]) {
        events.push({ type: 'severity_increased', finding: incoming, from: existing.severity });
      }
    }

    for (const [key, existing] of existingByKey) {
      if (!existing.resolvedAt && !newByKey.has(key)) {
        await tx.exposureFinding.update({ where: { id: existing.id }, data: { resolvedAt: now } });
        summary.resolved += 1;
        events.push({ type: 'resolved', finding: existing });
      }
    }
  });

  if (events.length > 0) {
    try {
      await postureAlertService.dispatchFindingEvents({ orgId, serverId, events });
    } catch (err) {
      // Alerting is best-effort: a routing failure is logged, never fatal to
      // the snapshot that triggered it.
      logger.error('postureService: alert dispatch failed', { serverId, error: err.message });
    }
  }

  return {
    snapshotId: snapshot.id,
    outOfOrder: false,
    listenersReplaced: true,
    findings: summary,
  };
}

export default { ingest, computeFindings };
