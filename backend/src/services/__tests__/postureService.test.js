/**
 * computeFindings — pure unit tests. No DB. Fixtures mirror the scenarios in
 * .posture-wip/test/run-tests.sh (the reference collector's own harness):
 * the footgun (Docker publish bypasses a ufw deny), remapped ports still
 * resolving to the real service, a correctly-bound loopback publish staying
 * silent, and the firewalld/unknown-firewall equivalents this backend adds
 * on top of the bash reference.
 */

import { computeFindings } from '../postureService.js';

function findingsByCode(result) {
  const map = {};
  for (const f of result.findings) {
    (map[f.code] ||= []).push(f);
  }
  return map;
}

function findCode(result, code) {
  return result.findings.filter((f) => f.code === code);
}

function reachabilityOf(result, proto, port) {
  const l = result.listeners.find((x) => x.proto === proto && x.port === port);
  return l ? l.reachability : undefined;
}

describe('computeFindings', () => {
  // =========================================================================
  // Scenario 1 — the footgun: Docker -p 5432 with an explicit ufw deny.
  // =========================================================================
  test('DOCKER_FIREWALL_BYPASS: docker-published port survives an explicit ufw deny (CRITICAL)', () => {
    const snapshot = {
      firewall: {
        engine: 'ufw',
        active: true,
        defaultIncoming: 'deny',
        rules: [
          { port: '22', proto: 'tcp', action: 'ALLOW', from: 'Anywhere' },
          { port: '5432', proto: 'tcp', action: 'DENY', from: 'Anywhere' },
        ],
      },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 22, ownerKind: 'systemd', ownerName: 'ssh.service', source: 'ss' },
        {
          proto: 'tcp', bind: '0.0.0.0', port: 5432, containerPort: 5432,
          ownerKind: 'docker', ownerName: 'pg-main', ownerDetail: 'postgres:16-alpine', source: 'docker',
        },
      ],
    };

    const result = computeFindings(snapshot, {});
    const bypass = findCode(result, 'DOCKER_FIREWALL_BYPASS');
    expect(bypass).toHaveLength(1);
    expect(bypass[0]).toMatchObject({ severity: 'CRITICAL', proto: 'tcp', port: 5432, service: 'PostgreSQL' });

    expect(reachabilityOf(result, 'tcp', 5432)).toBe('INTERNET');

    // A "correctly closed per ufw" finding must NOT also fire — the whole
    // point is that the deny rule is silently ineffective, not enforced.
    expect(findCode(result, 'SENSITIVE_PORT_EXPOSED')).toHaveLength(0);

    const expectedPublic = findCode(result, 'EXPECTED_PUBLIC');
    expect(expectedPublic).toHaveLength(1);
    expect(expectedPublic[0]).toMatchObject({ proto: 'tcp', port: 22, service: 'SSH' });
  });

  // =========================================================================
  // Scenario 2 — remapped ports: 5433 is still Postgres, 6380 is still Redis.
  // =========================================================================
  test('remapped ports resolve via the container port, not the host port (5433 -> PostgreSQL, 6380 -> Redis)', () => {
    const snapshot = {
      firewall: {
        engine: 'ufw',
        active: true,
        defaultIncoming: 'deny',
        rules: [{ port: '22', proto: 'tcp', action: 'ALLOW', from: 'Anywhere' }],
      },
      listeners: [
        {
          proto: 'tcp', bind: '0.0.0.0', port: 5433, containerPort: 5432,
          ownerKind: 'docker', ownerName: 'db', ownerDetail: 'postgres:16-alpine', source: 'docker',
        },
        {
          proto: 'tcp', bind: '0.0.0.0', port: 6380, containerPort: 6379,
          ownerKind: 'docker', ownerName: 'cache', ownerDetail: 'redis:7-alpine', source: 'docker',
        },
      ],
    };

    const result = computeFindings(snapshot, {});
    expect(reachabilityOf(result, 'tcp', 5433)).toBe('INTERNET');
    expect(reachabilityOf(result, 'tcp', 6380)).toBe('INTERNET');

    const l5433 = result.listeners.find((l) => l.port === 5433);
    const l6380 = result.listeners.find((l) => l.port === 6380);
    expect(l5433.service).toBe('PostgreSQL');
    expect(l6380.service).toBe('Redis');

    // No explicit rule for either port, but ufw is active + default-deny —
    // Docker bypasses that implicit deny just as surely as an explicit one.
    const bypassPorts = findCode(result, 'DOCKER_FIREWALL_BYPASS').map((f) => f.port).sort();
    expect(bypassPorts).toEqual([5433, 6380]);
  });

  // =========================================================================
  // Scenario 3 — loopback-only Docker publish must be silent.
  // =========================================================================
  test('loopback-only Docker publish produces no exposure finding', () => {
    const snapshot = {
      firewall: {
        engine: 'ufw',
        active: true,
        defaultIncoming: 'deny',
        rules: [{ port: '22', proto: 'tcp', action: 'ALLOW', from: 'Anywhere' }],
      },
      listeners: [
        {
          proto: 'tcp', bind: '127.0.0.1', port: 5432, containerPort: 5432,
          ownerKind: 'docker', ownerName: 'db', ownerDetail: 'postgres:16-alpine', source: 'docker',
        },
      ],
    };

    const result = computeFindings(snapshot, {});
    expect(reachabilityOf(result, 'tcp', 5432)).toBe('LOOPBACK');
    expect(findCode(result, 'DOCKER_FIREWALL_BYPASS')).toHaveLength(0);
    expect(findCode(result, 'SENSITIVE_PORT_EXPOSED')).toHaveLength(0);
  });

  // =========================================================================
  // Native (non-Docker) wildcard bind saved only by a firewall rule: MEDIUM,
  // not CRITICAL — the credibility line from posture-design.md §3.5.
  // =========================================================================
  test('native service on a wildcard bind behind a real firewall rule is MEDIUM, not CRITICAL', () => {
    const snapshot = {
      firewall: {
        engine: 'ufw',
        active: true,
        defaultIncoming: 'deny',
        rules: [{ port: '22', proto: 'tcp', action: 'ALLOW', from: 'Anywhere' }],
      },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 5432, ownerKind: 'process', ownerName: 'postgres', process: 'postgres', source: 'ss' },
      ],
    };

    const result = computeFindings(snapshot, {});
    expect(reachabilityOf(result, 'tcp', 5432)).toBe('FIREWALLED');
    const finding = findCode(result, 'SENSITIVE_PORT_WILDCARD_BIND');
    expect(finding).toHaveLength(1);
    expect(finding[0]).toMatchObject({ severity: 'MEDIUM', service: 'PostgreSQL' });
    expect(findCode(result, 'DOCKER_FIREWALL_BYPASS')).toHaveLength(0);
    expect(findCode(result, 'SENSITIVE_PORT_EXPOSED')).toHaveLength(0);
  });

  // =========================================================================
  // Expected-public suppression via org settings.
  // =========================================================================
  test('a port on the org expected-public list is suppressed to EXPECTED_PUBLIC (INFO)', () => {
    const snapshot = {
      firewall: { engine: 'none', active: false, defaultIncoming: 'unknown', rules: [] },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 8080, ownerKind: 'systemd', ownerName: 'app.service', source: 'ss' },
      ],
    };
    const settings = { expectedPublicPorts: [{ port: 8080, proto: 'tcp', label: 'App gateway' }] };

    const result = computeFindings(snapshot, settings);
    expect(reachabilityOf(result, 'tcp', 8080)).toBe('INTERNET');
    const expected = findCode(result, 'EXPECTED_PUBLIC');
    expect(expected).toHaveLength(1);
    expect(expected[0]).toMatchObject({ port: 8080, service: 'App gateway', detail: { matchedBy: 'setting', bind: '0.0.0.0' } });
    expect(findCode(result, 'PORT_EXPOSED')).toHaveLength(0);
  });

  test('22/80/443 are EXPECTED_PUBLIC by default with no org setting at all', () => {
    const snapshot = {
      firewall: { engine: 'none', active: false, defaultIncoming: 'unknown', rules: [] },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 443, ownerKind: 'systemd', ownerName: 'nginx.service', source: 'ss' },
      ],
    };
    const result = computeFindings(snapshot, {});
    expect(findCode(result, 'EXPECTED_PUBLIC')).toHaveLength(1);
  });

  // =========================================================================
  // firewalld equivalents — same taxonomy, normalized rule shape.
  // =========================================================================
  test('firewalld: DOCKER_FIREWALL_BYPASS fires the same way ufw does', () => {
    const snapshot = {
      firewall: {
        engine: 'firewalld',
        active: true,
        defaultIncoming: 'deny', // zone target normalized from REJECT/DROP/default
        rules: [
          { port: '22', proto: 'tcp', action: 'ALLOW', from: 'Anywhere' },
          { port: '5432', proto: 'tcp', action: 'REJECT', from: 'Anywhere' },
        ],
      },
      listeners: [
        {
          proto: 'tcp', bind: '0.0.0.0', port: 5432, containerPort: 5432,
          ownerKind: 'docker', ownerName: 'pg-main', ownerDetail: 'postgres:16-alpine', source: 'docker',
        },
      ],
    };
    const result = computeFindings(snapshot, {});
    expect(findCode(result, 'DOCKER_FIREWALL_BYPASS')).toHaveLength(1);
    expect(findCode(result, 'DOCKER_FIREWALL_BYPASS')[0].severity).toBe('CRITICAL');
  });

  test('firewalld: FIREWALL_INACTIVE fires when the engine is installed but not active', () => {
    const snapshot = {
      firewall: { engine: 'firewalld', active: false, defaultIncoming: 'deny', rules: [] },
      listeners: [],
    };
    const result = computeFindings(snapshot, {});
    expect(findCode(result, 'FIREWALL_INACTIVE')).toHaveLength(1);
    expect(findCode(result, 'FIREWALL_INACTIVE')[0]).toMatchObject({ severity: 'HIGH', proto: null, port: null });
  });

  // =========================================================================
  // Unknown / unsupported firewall engines never guess FIREWALLED.
  // =========================================================================
  test('nftables/iptables: a wildcard-bound native service reports FIREWALL_STATE_UNKNOWN, not FIREWALLED', () => {
    const snapshot = {
      firewall: { engine: 'nftables', active: true, defaultIncoming: 'deny', rules: [] },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 5432, ownerKind: 'process', ownerName: 'postgres', process: 'postgres', source: 'ss' },
      ],
    };
    const result = computeFindings(snapshot, {});
    expect(reachabilityOf(result, 'tcp', 5432)).toBe('UNKNOWN');
    const unknown = findCode(result, 'FIREWALL_STATE_UNKNOWN');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ severity: 'INFO', port: 5432 });
    expect(findCode(result, 'SENSITIVE_PORT_WILDCARD_BIND')).toHaveLength(0);
    expect(findCode(result, 'SENSITIVE_PORT_EXPOSED')).toHaveLength(0);
  });

  test('nftables: a Docker publish is still definite INTERNET (DNAT bypass is certain, not a guess) but no bypass finding without provable rule coverage', () => {
    const snapshot = {
      firewall: { engine: 'nftables', active: true, defaultIncoming: 'deny', rules: [] },
      listeners: [
        {
          proto: 'tcp', bind: '0.0.0.0', port: 6379, containerPort: 6379,
          ownerKind: 'docker', ownerName: 'cache', ownerDetail: 'redis:7-alpine', source: 'docker',
        },
      ],
    };
    const result = computeFindings(snapshot, {});
    expect(reachabilityOf(result, 'tcp', 6379)).toBe('INTERNET');
    expect(findCode(result, 'DOCKER_FIREWALL_BYPASS')).toHaveLength(0);
    expect(findCode(result, 'FIREWALL_STATE_UNKNOWN')).toHaveLength(0);
    const sensitive = findCode(result, 'SENSITIVE_PORT_EXPOSED');
    expect(sensitive).toHaveLength(1);
    expect(sensitive[0].service).toBe('Redis');
  });

  test('asymmetric IPv4/IPv6 ufw policy for the same port reports FIREWALL_STATE_UNKNOWN', () => {
    const snapshot = {
      firewall: {
        engine: 'ufw',
        active: true,
        defaultIncoming: 'deny',
        rules: [
          { port: '8443', proto: 'tcp', action: 'ALLOW', family: 'v4' },
          { port: '8443', proto: 'tcp', action: 'DENY', family: 'v6' },
        ],
      },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 8443, ownerKind: 'systemd', ownerName: 'app.service', source: 'ss' },
      ],
    };
    const result = computeFindings(snapshot, {});
    expect(reachabilityOf(result, 'tcp', 8443)).toBe('UNKNOWN');
    expect(findCode(result, 'FIREWALL_STATE_UNKNOWN')).toHaveLength(1);
  });

  // =========================================================================
  // Host-level findings.
  // =========================================================================
  test('NO_HOST_FIREWALL fires when no firewall engine is present at all', () => {
    const snapshot = {
      firewall: { engine: 'none', active: false, defaultIncoming: 'unknown', rules: [] },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 8000, ownerKind: 'unknown', ownerName: 'unknown', source: 'ss' },
      ],
    };
    const result = computeFindings(snapshot, {});
    expect(findCode(result, 'NO_HOST_FIREWALL')).toHaveLength(1);
    expect(findCode(result, 'NO_HOST_FIREWALL')[0]).toMatchObject({ severity: 'HIGH', proto: null, port: null });
    // No firewall at all => reachable, not a known-public/sensitive service.
    expect(findCode(result, 'PORT_EXPOSED')).toHaveLength(1);
  });

  test('STALE_FIREWALL_RULE fires for an ALLOW rule with nothing listening on it', () => {
    const snapshot = {
      firewall: {
        engine: 'ufw',
        active: true,
        defaultIncoming: 'deny',
        rules: [
          { port: '22', proto: 'tcp', action: 'ALLOW', from: 'Anywhere' },
          { port: '9999', proto: 'tcp', action: 'ALLOW', from: 'Anywhere' },
        ],
      },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 22, ownerKind: 'systemd', ownerName: 'ssh.service', source: 'ss' },
      ],
    };
    const result = computeFindings(snapshot, {});
    const stale = findCode(result, 'STALE_FIREWALL_RULE');
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ severity: 'LOW', port: 9999 });
  });

  test('UNATTRIBUTED_LISTENER fires when a listener cannot be tied to any owner', () => {
    const snapshot = {
      firewall: { engine: 'none', active: false, defaultIncoming: 'unknown', rules: [] },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 4000, ownerKind: 'unknown', ownerName: 'unknown', source: 'ss' },
      ],
    };
    const result = computeFindings(snapshot, {});
    expect(findCode(result, 'UNATTRIBUTED_LISTENER')).toHaveLength(1);
  });

  test('a well-attributed listener never raises UNATTRIBUTED_LISTENER', () => {
    const snapshot = {
      firewall: { engine: 'none', active: false, defaultIncoming: 'unknown', rules: [] },
      listeners: [
        { proto: 'tcp', bind: '127.0.0.1', port: 3001, ownerKind: 'pm2', ownerName: 'billing-worker', source: 'ss' },
      ],
    };
    const result = computeFindings(snapshot, {});
    expect(findCode(result, 'UNATTRIBUTED_LISTENER')).toHaveLength(0);
  });

  test('pm2 apps that ss only ever reports as "node" are still attributed by owner name', () => {
    const snapshot = {
      firewall: { engine: 'none', active: false, defaultIncoming: 'unknown', rules: [] },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 3001, process: 'node', ownerKind: 'pm2', ownerName: 'billing-worker', source: 'ss' },
      ],
    };
    const result = computeFindings(snapshot, {});
    const l = result.listeners.find((x) => x.port === 3001);
    expect(l.ownerLabel).toBe('pm2/billing-worker');
    expect(findCode(result, 'UNATTRIBUTED_LISTENER')).toHaveLength(0);
  });

  test('empty snapshot produces no findings beyond the host-level firewall state', () => {
    const snapshot = { firewall: { engine: 'ufw', active: true, defaultIncoming: 'deny', rules: [] }, listeners: [] };
    const result = computeFindings(snapshot, {});
    expect(result.listeners).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});

describe('stopped services — the half a socket scan cannot see', () => {
  const base = {
    firewall: {
      engine: 'ufw',
      active: true,
      defaultIncoming: 'deny',
      rules: [{ port: '8080', proto: 'tcp', action: 'ALLOW', from: 'Anywhere' }],
    },
    listeners: [],
  };

  it('a rule with genuinely nothing behind it is still just a stale rule', () => {
    const { findings } = computeFindings({ ...base, services: [] }, {});
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('STALE_FIREWALL_RULE');
    expect(codes).not.toContain('STOPPED_SERVICE_PORT_OPEN');
  });

  it('names the stopped container behind an open rule instead of calling it stale', () => {
    const { findings } = computeFindings(
      {
        ...base,
        services: [
          {
            kind: 'docker',
            name: 'api',
            ref: 'abc123',
            state: 'exited',
            running: false,
            statusText: 'Exited (1) 2 days ago',
            exitCode: 1,
            ports: [{ proto: 'tcp', port: 8080, containerPort: 3000, bind: '0.0.0.0' }],
          },
        ],
      },
      {}
    );
    const codes = findings.map((f) => f.code);
    // The two are mutually exclusive: attributing the rule REPLACES the
    // unattributed version rather than adding a second row for one port.
    expect(codes).toContain('STOPPED_SERVICE_PORT_OPEN');
    expect(codes).not.toContain('STALE_FIREWALL_RULE');

    const f = findings.find((x) => x.code === 'STOPPED_SERVICE_PORT_OPEN');
    expect(f.port).toBe(8080);
    expect(f.severity).toBe('MEDIUM');
    expect(f.ownerLabel).toBe('docker/api');
    expect(f.message).toContain('api');
    expect(f.message).toContain('exited');
    expect(f.detail.serviceState).toBe('exited');
    expect(f.detail.exitCode).toBe(1);
  });

  it('a RUNNING service never suppresses the stale-rule verdict', () => {
    // Running services are found through `ss`; if one is reported running
    // and nothing is listening, the rule really is unbacked.
    const { findings } = computeFindings(
      {
        ...base,
        services: [
          {
            kind: 'docker',
            name: 'api',
            state: 'running',
            running: true,
            ports: [{ proto: 'tcp', port: 8080 }],
          },
        ],
      },
      {}
    );
    expect(findings.map((f) => f.code)).toContain('STALE_FIREWALL_RULE');
  });

  it('matches on protocol, not just port number', () => {
    const { findings } = computeFindings(
      {
        ...base,
        services: [
          {
            kind: 'systemd',
            name: 'app.service',
            state: 'inactive',
            running: false,
            ports: [{ proto: 'udp', port: 8080 }],
          },
        ],
      },
      {}
    );
    // The rule is tcp/8080; a stopped UDP service on 8080 does not explain it.
    expect(findings.map((f) => f.code)).toContain('STALE_FIREWALL_RULE');
  });

  it('a stopped service with no declared ports explains nothing', () => {
    const { findings } = computeFindings(
      {
        ...base,
        services: [{ kind: 'systemd', name: 'cleanup.service', state: 'failed', running: false, ports: [] }],
      },
      {}
    );
    expect(findings.map((f) => f.code)).toContain('STALE_FIREWALL_RULE');
  });
});
