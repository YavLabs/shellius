#!/usr/bin/env node
/**
 * seed-posture-demo.mjs — load a real posture scan into a local database so
 * the Posture UI has something honest to render.
 *
 * The payload below is a transcription of an actual `posture-scan.sh` run on
 * a busy on-prem demo box (47 services, ufw installed but inactive, three
 * datastores published to the world). It is pushed through the real
 * `postureService.ingest`, NOT written as rows — so listeners, findings,
 * severities and transitions are computed by the same code the collector
 * endpoint runs, and the seeded state cannot drift from production behaviour.
 *
 *   node scripts/seed-posture-demo.mjs                 # default target below
 *   node scripts/seed-posture-demo.mjs <serverId>
 *   node scripts/seed-posture-demo.mjs <serverId> --history --reset
 *
 * `--reset` clears this server's existing posture rows first, which a re-run
 * needs: ingest deliberately ignores a snapshot that is not newer than the
 * newest one it already has.
 *
 * `--history` also ingests two earlier snapshots (2h and 1h ago) with a
 * couple of ports absent, so the UI has resolved findings and a re-open, and
 * backfills 7 days of resource samples at the collection interval so the
 * Resources drill-down has something to aggregate over.
 *
 * Local/dev only. It writes to whatever DATABASE_URL points at, so it prints
 * the target server and refuses to run without one.
 */

import process from 'node:process';
import prisma from '../src/config/db.js';
import * as postureService from '../src/services/postureService.js';
import * as postureSettingsService from '../src/services/postureSettingsService.js';

const HISTORY_DAYS = 7;
const DEFAULT_SERVER_ID = 'cmua6ruxg000pcux3fw6da8p9'; // "Onprem Dev Demo 1"

// --- the scan -------------------------------------------------------------
// [port, ownerKind, ownerName, ownerUser, ownerRef, sourcePath, pid,
//  containerPort|null, service|null]
const PM2 = 'pm2';
const DOCKER = 'docker';
const SYSTEMD = 'systemd';

const SCAN = [
  [22, SYSTEMD, 'ssh.service', 'root', 'ssh.service', '/usr/lib/systemd/system/ssh.service', 124007, null],
  [80, SYSTEMD, 'apache2.service', 'www-data', 'apache2.service', '/usr/lib/systemd/system/apache2.service', 3686131, null],
  [631, SYSTEMD, 'snap.cups.cupsd.service', 'root', 'snap.cups.cupsd.service', '/etc/systemd/system/snap.cups.cupsd.service', 124609, null],
  [3000, PM2, 'iTMS', 'ithadmin', '#0', '/home/ithadmin/iTMS/workspace/shadcn-ui', 3146929, null],
  [3001, PM2, 'iCRMCOM', 'ithadmin', '#1', '/home/ithadmin/iCRMCOM/workspace/shadcn-ui', 3146930, null],
  [3002, DOCKER, 'chatbot_api', 'root', 'cd8f9129c3e3', '/home/ithadmin/wp-chatbot-backend/docker-compose.yml', 3651, null],
  [3004, PM2, 'ksb-testbench-FE', 'ithadmin', '#19', '/home/ithadmin/KSB-TestBench-v46/app/frontend/dist', 3147042, null],
  [3005, DOCKER, 'self-hosting-op-dashboard-1', 'root', 'fe07ecd8db89', '/home/ithadmin/openpanel/self-hosting/docker-compose.yml', 2349, null],
  [3006, DOCKER, 'self-hosting-op-api-1', 'root', 'e55b151fdca9', '/home/ithadmin/openpanel/self-hosting/docker-compose.yml', 4121, null],
  [3007, PM2, 'sentry-iecom-portal', 'ithadmin', '#15', '/home/ithadmin/sentry_ecom_demo/iEcom_portal', 3147013, null],
  [3022, PM2, 'iSERV Dev Frontend', 'ithadmin', '#16', '/home/ithadmin/iSERV-DEV/portal', 3147020, null],
  [3310, DOCKER, 'ocs_wp_db', 'root', 'd3aa6b58037b', '/home/ithadmin/ocs_website/docker-compose.yml', 4001, 3306],
  [3311, DOCKER, 'ithena-wp-mysql', 'root', '566cf2074556', '/home/ithadmin/ithena_website/docker-compose.yaml', 3782, 3306],
  [3423, DOCKER, 'iserv-portal-1', 'root', 'd330f56efc92', '/home/ithadmin/iSERV-Dev-Docker/docker-compose.yml', 2783256, 3000],
  [4005, DOCKER, 'msb-nginx', 'root', '2a39a65a2de1', '/home/ithadmin/imsb/docker-compose.yml', 4056, 80],
  [5007, PM2, 'sentry-iecom-server', 'ithadmin', '#14', '/home/ithadmin/sentry_ecom_demo/iEcom_server', 3147007, null],
  [5022, PM2, 'iserv-dev-backend', 'ithadmin', '#18', '/home/ithadmin/iSERV-DEV/server', 127672, null],
  [5435, DOCKER, 'chatbot_postgres', 'root', '22930ff45c16', '/home/ithadmin/wp-chatbot-backend/docker-compose.yml', 3517, 5432],
  [5563, DOCKER, 'iserv-server-1', 'root', '13761179a562', '/home/ithadmin/iSERV-Dev-Docker/docker-compose.yml', 2783124, 5000],
  [7500, PM2, 'bartelt-ecom-frontend', 'ithadmin', '#2', '/home/ithadmin/bartelt_demo/iEcom_portal', 3147457, null],
  [7501, PM2, 'bartelt-ecom-backend', 'ithadmin', '#3', '/home/ithadmin/bartelt_demo/iEcom_server', 3146948, null],
  [7502, PM2, 'bsi-ecom-frontend', 'ithadmin', '#5', '/home/ithadmin/bsi_demo/iEcom_portal', 3147518, null],
  [7503, PM2, 'bsi_server_ecom_infisical', 'ithadmin', '#24', '/home/ithadmin/bsi_demo/iEcom_server', 3147133, null],
  [7504, PM2, 'zalkins-ecom-frontend', 'ithadmin', '#6', '/home/ithadmin/zalkins_demo/iEcom_portal', 3147472, null],
  [7505, PM2, 'zalkins_server_ecom_infisical', 'ithadmin', '#20', '/home/ithadmin/zalkins_demo/iEcom_server', 3147077, null],
  [7530, PM2, 'matrix-ecom-frontend', 'ithadmin', '#8', '/home/ithadmin/matrix_demo/iEcom_portal', 3147459, null],
  [7531, PM2, 'matrix_server_ecom_infisical', 'ithadmin', '#21', '/home/ithadmin/matrix_demo/iEcom_server', 3147080, null],
  [7532, PM2, 'haumiller-ecom-frontend', 'ithadmin', '#9', '/home/ithadmin/haumiller_demo/iEcom_portal', 3147524, null],
  [7533, PM2, 'haumilier_server_ecom_infisical', 'ithadmin', '#23', '/home/ithadmin/haumiller_demo/iEcom_server', 3147123, null],
  [7534, PM2, 'ca-ecom-frontend', 'ithadmin', '#10', '/home/ithadmin/ca_demo/iEcom_portal', 3147476, null],
  [7535, PM2, 'ca_server_ecom_infisical', 'ithadmin', '#22', '/home/ithadmin/ca_demo/iEcom_server', 3147097, null],
  [8002, SYSTEMD, 'ksb-backend.service', 'ithadmin', 'ksb-backend.service', '/etc/systemd/system/ksb-backend.service', 126702, null],
  [8080, DOCKER, 'pwd-frontend-1', 'root', '8e607db05ade', '/home/ithadmin/erpnext_docker/docker-compose.yml', 5986, 8080],
  [8081, DOCKER, 'panelops-dev-frontend-1', 'root', 'f4bf54abde5d', '/home/ithadmin/gitops/erpnext-one.yaml', 540771, 8080],
  [8082, DOCKER, 'sample_infisical_web_server', 'root', '8d14050ef9ad', '/home/ithadmin/sample_infisical_docker/compose.yml', 79385, 8080],
  [8083, DOCKER, 'huly-nginx-1.21.3', 'root', '4736650063b6', '/home/ithadmin/huly-selfhost/compose.yml', 5982, 80],
  [8085, DOCKER, 'ocs_wp_app', 'root', '5b6e13a85b52', '/home/ithadmin/ocs_website/docker-compose.yml', 1016652, 80],
  [8086, DOCKER, 'ithena-wp', 'root', 'dbbb86a321cc', '/home/ithadmin/ithena_website/docker-compose.yaml', 2402042, 80],
  [8094, DOCKER, 'huly_v7-kvs-1', 'root', 'c4c8f1c78ce5', '/home/ithadmin/huly-selfhost/compose.yml', 4398, 8094],
  [8501, PM2, 'iPLAN-Demo', 'ithadmin', '#7', '/home/ithadmin/supply_chain', 3146964, null],
  [8776, DOCKER, 'iserv-server-1', 'root', '13761179a562', '/home/ithadmin/iSERV-Dev-Docker/docker-compose.yml', 2783124, 5000],
  [8777, PM2, 'sentry-iecom-server', 'ithadmin', '#14', '/home/ithadmin/sentry_ecom_demo/iEcom_server', 3147007, null],
  [8876, PM2, 'iserv-dev-backend', 'ithadmin', '#18', '/home/ithadmin/iSERV-DEV/server', 127672, null],
  [45876, DOCKER, 'beszel-agent', 'root', 'b7215edc8c06', '/home/ithadmin/beszel/docker-compose.yaml', 2304, 45876],
];

// Present in the two historical snapshots and gone from the newest one, so
// --history leaves the Resolved tab populated: a debug port someone closed
// and a Redis that was moved behind loopback. Without these every finding is
// open and "resolved by whom" has nothing to show.
const TRANSIENT = [
  [9229, PM2, 'iserv-dev-backend', 'ithadmin', '#18', '/home/ithadmin/iSERV-DEV/server', 127672, null],
  [6380, DOCKER, 'chatbot_redis', 'root', 'f1e2d3c4b5a6', '/home/ithadmin/wp-chatbot-backend/docker-compose.yml', 3520, 6379],
];

// The three the scan hid behind --all. Loopback binds, so they must classify
// as LOOPBACK and raise nothing — which is itself worth seeing in the UI.
const LOOPBACK = [
  [5432, DOCKER, 'huly_v7-postgres-1', 'root', 'a1f2c3d4e5f6', '/home/ithadmin/huly-selfhost/compose.yml', 4402, 5432],
  [6379, DOCKER, 'huly_v7-redis-1', 'root', 'b2c3d4e5f6a1', '/home/ithadmin/huly-selfhost/compose.yml', 4405, 6379],
  [11211, SYSTEMD, 'memcached.service', 'memcache', 'memcached.service', '/usr/lib/systemd/system/memcached.service', 125880, null],
];

function listener([port, ownerKind, ownerName, ownerUser, ownerRef, sourcePath, pid, containerPort], bind) {
  return {
    proto: 'tcp',
    bind,
    port,
    containerPort: containerPort ?? null,
    pids: String(pid),
    process: ownerKind === DOCKER ? 'docker-proxy' : ownerName,
    ownerKind,
    ownerName,
    ownerDetail: ownerKind === DOCKER ? sourcePath.split('/').slice(-2).join('/') : null,
    ownerRef,
    ownerUser,
    sourcePath,
    source: ownerKind === DOCKER ? 'docker' : 'ss',
  };
}

function buildPayload(collectedAt, { omitPorts = [], includeTransient = false, metrics }) {
  const omit = new Set(omitPorts);
  return {
    schemaVersion: 1,
    scanner: 'posture-scan.sh',
    agentVersion: '1.6.0',
    collectedAt: collectedAt.toISOString(),
    hostname: 'dev-demos-02',
    collectorOk: true,
    firewall: {
      // Installed but not enforcing — the headline of the real scan.
      engine: 'ufw',
      active: false,
      defaultIncoming: 'deny',
      rules: [
        { action: 'ALLOW', port: '22', proto: 'tcp' },
        { action: 'ALLOW', port: '80', proto: 'tcp' },
        { action: 'ALLOW', port: '443', proto: 'tcp' },
      ],
    },
    listeners: [
      ...SCAN.filter((r) => !omit.has(r[0])).map((r) => listener(r, '0.0.0.0')),
      ...(includeTransient ? TRANSIENT.map((r) => listener(r, '0.0.0.0')) : []),
      ...LOOPBACK.map((r) => listener(r, '127.0.0.1')),
    ],
    services: [],
    metrics,
  };
}

/**
 * Backfill resource samples at the collection interval.
 *
 * Written straight to hostMetricSample rather than through ingest: ingest
 * records one sample per snapshot, and 2000 snapshots to get 2000 samples
 * would be a lie about how often the host was scanned.
 *
 * The shape is deliberately not noise — a daily business-hours cycle on CPU,
 * memory climbing and sawtoothing on restarts, disk creeping up all week.
 * Flat random data makes every aggregation look identical and tells you
 * nothing about whether the charts work.
 */
async function backfillMetrics(orgId, serverId, { days, intervalSeconds }) {
  const step = intervalSeconds * 1000;
  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  const rows = [];

  let mem = 55;
  for (let t = start; t <= end; t += step) {
    const d = new Date(t);
    const hour = d.getHours() + d.getMinutes() / 60;
    const weekday = d.getDay() !== 0 && d.getDay() !== 6;
    const progress = (t - start) / (end - start);

    // CPU: quiet at night, busy 09:00-18:00 on weekdays, with jitter.
    const busy = Math.exp(-(((hour - 13.5) / 4) ** 2)) * (weekday ? 1 : 0.35);
    const cpu = clamp(8 + busy * 55 + (Math.random() - 0.5) * 9, 1, 99);

    // Memory: creeps up, drops when something restarts (~every 18h).
    mem += 0.045 + (Math.random() - 0.45) * 0.1;
    if (Math.random() < step / (18 * 60 * 60 * 1000)) mem -= 12 + Math.random() * 8;
    mem = clamp(mem, 42, 94);

    // Disk: monotonic creep — the thing you want a week of history to see.
    const disk = clamp(48 + progress * 9 + (Math.random() - 0.5) * 0.4, 1, 99);

    // Load tracks CPU on a 4-core box, with heavier tails.
    const load = Math.max(0.05, (cpu / 100) * 4 + (Math.random() - 0.4) * 1.1);

    rows.push({
      orgId,
      serverId,
      at: d,
      cpuPct: round1(cpu),
      memPct: round1(mem),
      diskPct: round1(disk),
      load1: round2(load),
    });
  }

  // createMany in chunks — one statement with 2000 rows is needlessly large.
  for (let i = 0; i < rows.length; i += 500) {
    await prisma.hostMetricSample.createMany({ data: rows.slice(i, i + 500) });
  }
  return rows.length;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

async function main() {
  const args = process.argv.slice(2);
  const serverId = args.find((a) => !a.startsWith('--')) || DEFAULT_SERVER_ID;
  const withHistory = args.includes('--history');

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — refusing to guess a database.');
    process.exit(1);
  }

  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, orgId: true, hostname: true, displayName: true, environment: true },
  });
  if (!server) {
    console.error(`No server with id ${serverId}. Pass one as the first argument.`);
    process.exit(1);
  }

  console.log(`Target: ${server.displayName || server.hostname} (${server.environment})  org=${server.orgId}`);

  // Re-seeding must start from nothing: ingest treats a snapshot that is not
  // newer than the newest known one as out-of-order and leaves finding state
  // alone, so a second run over existing rows would quietly do nothing.
  if (args.includes('--reset')) {
    await prisma.exposureFinding.deleteMany({ where: { serverId: server.id } });
    await prisma.hostListener.deleteMany({ where: { serverId: server.id } });
    await prisma.hostMetricSample.deleteMany({ where: { serverId: server.id } });
    await prisma.hostSnapshot.deleteMany({ where: { serverId: server.id } });
    console.log('Cleared existing posture rows for this server.');
  }

  // Posture is opt-in per org; a seeded fleet with the feature switched off
  // would render the enablement path instead of the data.
  const settings = await postureSettingsService.getSettings(server.orgId);
  if (!settings.enabled) {
    await postureSettingsService.updateSettings(server.orgId, { enabled: true });
    console.log('Enabled posture for this organization.');
  }

  const now = Date.now();
  const runs = [];
  if (withHistory) {
    // Two hours ago: the two datastores on 3310/3311 were not yet published,
    // and one app port was down — so the newest snapshot produces opened
    // findings rather than a flat wall of "seen since forever".
    runs.push({
      at: new Date(now - 2 * 60 * 60 * 1000),
      omitPorts: [3310, 3311, 8501],
      includeTransient: true,
      metrics: { cpuPct: 18.4, memPct: 61.2, diskPct: 54.9, load1: 1.12 },
    });
    runs.push({
      at: new Date(now - 60 * 60 * 1000),
      omitPorts: [3311],
      includeTransient: true,
      metrics: { cpuPct: 31.7, memPct: 64.8, diskPct: 55.0, load1: 2.05 },
    });
  }
  runs.push({
    at: new Date(now - 60 * 1000),
    omitPorts: [],
    metrics: { cpuPct: 42.3, memPct: 71.5, diskPct: 55.1, load1: 3.41 },
  });

  for (const run of runs) {
    const payload = buildPayload(run.at, run);
    const result = await postureService.ingest(server.orgId, server.id, payload);
    console.log(
      `  ${run.at.toISOString()}  listeners=${payload.listeners.length}  ` +
        `opened=${result.findings.opened} continuing=${result.findings.continuing} ` +
        `reopened=${result.findings.reopened} resolved=${result.findings.resolved}`
    );
  }

  if (withHistory) {
    // Resource retention defaults to 24h, so a 7-day backfill would be pruned
    // on the next run and the drill-down would have nothing to show. Raise it
    // for this org — a dev database, and the script says what it changed.
    const settingsNow = await postureSettingsService.getSettings(server.orgId);
    if (settingsNow.metricRetentionHours < HISTORY_DAYS * 24) {
      await postureSettingsService.updateSettings(server.orgId, {
        metricRetentionHours: HISTORY_DAYS * 24,
      });
      console.log(`Raised metric retention to ${HISTORY_DAYS * 24}h so the backfill survives pruning.`);
    }
    const written = await backfillMetrics(server.orgId, server.id, {
      days: HISTORY_DAYS,
      intervalSeconds: settingsNow.collectIntervalSeconds || 300,
    });
    console.log(`Backfilled ${written} resource samples over ${HISTORY_DAYS} days.`);
  }

  const bySeverity = await prisma.exposureFinding.groupBy({
    by: ['severity'],
    where: { orgId: server.orgId, serverId: server.id, resolvedAt: null },
    _count: { _all: true },
  });
  const resolved = await prisma.exposureFinding.count({
    where: { orgId: server.orgId, serverId: server.id, NOT: { resolvedAt: null } },
  });

  console.log('\nOpen findings:');
  for (const row of bySeverity.sort((a, b) => a.severity.localeCompare(b.severity))) {
    console.log(`  ${row.severity.padEnd(8)} ${row._count._all}`);
  }
  console.log(`  resolved ${resolved}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Redis keeps a live connection open, so the process would otherwise
    // hang after the work is done. This is a one-shot script.
    process.exit(process.exitCode || 0);
  });
