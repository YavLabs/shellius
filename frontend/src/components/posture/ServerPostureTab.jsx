import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Cpu, Database, Download, Gauge, HardDrive, Radar, ShieldCheck, ShieldOff, Trash2, Volume1, VolumeX, Wifi } from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import { serviceLabel } from '@/lib/postureLabels';
import FindingDetailModal from '@/components/posture/FindingDetailModal';
import ListenerDetailModal from '@/components/posture/ListenerDetailModal';
import ExportDialog from '@/components/posture/ExportDialog';
import ExpectedPortDialog from '@/components/posture/ExpectedPortDialog';
import { Button } from '@/components/ui/button';
import { can } from '@/lib/permissions';
import { useAuth } from '@/context/AuthContext';
import EmptyState from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/badge';
import SeverityBadge from '@/components/posture/SeverityBadge';
import FindingStatusBadge from '@/components/posture/FindingStatusBadge';
import MuteDialog from '@/components/posture/MuteDialog';
import Sparkline from '@/components/posture/Sparkline';
import { reachabilityTone } from '@/lib/badgeTones';
import { getServerPosture, muteFinding, unmuteFinding, acknowledgeFinding, listExpectedPorts, removeExpectedPort } from '@/services/postureService';
import { relativeTime, formatDateTime } from '@/utils/time';

function StatRow({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{children ?? '-'}</span>
    </div>
  );
}

function GaugeCard({ icon: Icon, label, points, unit = '%', color, onClick }) {
  const last = [...points].reverse().find((v) => v !== null && v !== undefined && !Number.isNaN(v));
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={onClick ? `${label} history` : undefined}
      className={`flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card p-3.5 text-left ${
        onClick ? 'transition-colors hover:border-primary/40 hover:bg-accent/40' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
          {last !== undefined ? `${Math.round(last)}${unit}` : '—'}
        </p>
      </div>
      <Sparkline points={points} max={unit === '%' ? 100 : Math.max(1, ...points.filter((v) => v != null))} color={color} />
    </Tag>
  );
}

/**
 * Server detail → Posture tab (docs/posture/posture-spec.md §8). Its own
 * fetch/loading/error cycle so it only runs while the tab is open.
 */

function ServerPostureTab({ serverId, canMute, authMode, canBootstrap, onBootstrap }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [muteTarget, setMuteTarget] = useState(null);
  // Row click opens the detail view; the row's … menu keeps the quick actions.
  const [detailFinding, setDetailFinding] = useState(null);
  const [detailListener, setDetailListener] = useState(null);
  const [selected, setSelected] = useState([]);
  const [exportDataset, setExportDataset] = useState(null); // 'findings' | 'listeners'
  const [expectedTargets, setExpectedTargets] = useState(null);
  const [expectedPorts, setExpectedPorts] = useState([]);
  const { user } = useAuth();
  const canExport = can(user, 'posture.export');
  const canExpect = can(user, 'posture.expected_ports');
  const [muteSubmitting, setMuteSubmitting] = useState(false);
  const [muteError, setMuteError] = useState('');

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getServerPosture(serverId);
      setData(res);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load posture data');
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const loadExpected = useCallback(() => {
    // Best-effort: the tab is still useful without it, and a viewer who
    // cannot read the list should not see an error banner over the findings.
    listExpectedPorts(serverId).then(setExpectedPorts).catch(() => setExpectedPorts([]));
  }, [serverId]);

  useEffect(() => {
    loadExpected();
  }, [loadExpected]);

  const handleAcknowledge = async (finding) => {
    setBusyId(finding.id);
    try {
      await acknowledgeFinding(finding.id);
      fetch();
    } finally {
      setBusyId(null);
    }
  };

  const handleUnmute = async (finding) => {
    setBusyId(finding.id);
    try {
      await unmuteFinding(finding.id);
      fetch();
    } finally {
      setBusyId(null);
    }
  };

  const handleMuteConfirm = async (payload) => {
    if (!muteTarget) return;
    setMuteSubmitting(true);
    setMuteError('');
    try {
      await muteFinding(muteTarget.id, payload);
      setMuteTarget(null);
      fetch();
    } catch (err) {
      setMuteError(err.response?.data?.error?.message || 'Failed to mute finding');
    } finally {
      setMuteSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-24 animate-pulse rounded-lg bg-muted" />
        <div className="h-48 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }

  const collector = data?.collector;
  const snapshot = data?.snapshot;

  // Three distinct empty states (spec §9.14) — never a blank "no findings"
  // when the real story is "nothing has ever reported".
  if (!collector?.installed) {
    // Credential-mode hosts connect with a stored identity, never a
    // bootstrap cert, so the "Host menu → Bootstrap host" item is hidden on
    // them (pages/ServerDetail.jsx). They can still get posture coverage
    // through the reduced posture-only installer (POST /api/bootstrap/token
    // { mode: 'posture' }), which never touches sshd, CA trust or
    // check-principals — that's the whole reassurance these hosts need.
    if (authMode === 'credential') {
      return (
        <EmptyState
          icon={Radar}
          title="Collector not installed on this host"
          description="This host connects with a stored identity, not a Shellius certificate. Installing the posture collector adds only the collector and its own systemd timer — it changes nothing about how SSH authentication works on this host."
          action={canBootstrap && onBootstrap ? { label: 'Install posture collector', onClick: () => onBootstrap('posture') } : undefined}
        />
      );
    }
    return (
      <EmptyState
        icon={Radar}
        title="Collector not installed on this host"
        description='This server has never sent a posture snapshot. Run the bootstrap command with "--upgrade" appended to install it — it starts reporting within a few minutes.'
        action={canBootstrap && onBootstrap ? { label: 'Bootstrap host', onClick: () => onBootstrap('full') } : undefined}
      />
    );
  }

  if (!snapshot) {
    return (
      <EmptyState
        icon={Radar}
        title="Waiting for the first snapshot"
        description="The collector is installed but hasn't reported yet. It reports on its own timer (5 minutes by default) — check back shortly."
      />
    );
  }

  const listeners = data.listeners || [];
  const findings = (data.findings || []).filter((f) => f.status !== 'resolved');

  const selectedFindings = findings.filter((f) => selected.includes(f.id));

  const handleBulkAcknowledge = async () => {
    setBusyId('bulk');
    try {
      // Sequential: each is an audited write, and a burst against a shared
      // API is a worse trade than a second of latency on a bulk action.
      for (const id of selected) await acknowledgeFinding(id);
      setSelected([]);
      fetch();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to acknowledge findings');
    } finally {
      setBusyId(null);
    }
  };

  const bulkBar = (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-accent/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-foreground">{selected.length} selected</span>
      <div className="flex flex-wrap items-center gap-2">
        {canMute && (
          <Button size="sm" onClick={() => setMuteTarget({ ids: selected })}>
            <VolumeX className="mr-1.5 h-4 w-4" /> Mute
          </Button>
        )}
        {canMute && (
          <Button variant="outline" size="sm" onClick={handleBulkAcknowledge} disabled={busyId === 'bulk'}>
            <Check className="mr-1.5 h-4 w-4" /> Acknowledge
          </Button>
        )}
        {canExpect && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setExpectedTargets(
                selectedFindings.filter((f) => f.port).map((f) => ({ port: f.port, proto: f.proto }))
              )
            }
            disabled={!selectedFindings.some((f) => f.port)}
          >
            <ShieldCheck className="mr-1.5 h-4 w-4" /> Mark expected
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setSelected([])}>
          Clear
        </Button>
      </div>
    </div>
  );
  const metrics = data.metrics || [];
  const cpu = metrics.map((m) => m.cpuPct ?? null);
  const mem = metrics.map((m) => m.memPct ?? null);
  const disk = metrics.map((m) => m.diskPct ?? null);
  const load = metrics.map((m) => m.load1 ?? null);

  const listenerColumns = [
    {
      key: 'port',
      label: 'Port',
      mobile: { slot: 'title', render: (r) => `${(r.proto || '').toUpperCase()}/${r.port}${r.containerPort && r.containerPort !== r.port ? ` → ${r.containerPort}` : ''}` },
      render: (r) => (
        <span className="font-mono text-sm">
          {(r.proto || '').toUpperCase()}/{r.port}
          {r.containerPort && r.containerPort !== r.port && (
            <span className="text-muted-foreground"> → {r.containerPort}</span>
          )}
        </span>
      ),
    },
    {
      key: 'bind',
      label: 'Bind',
      hideBelow: 'md',
      mobile: { slot: 'meta', order: 0, render: (r) => r.bind },
      render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.bind}</span>,
    },
    {
      key: 'reachability',
      label: 'Reachability',
      mobile: { slot: 'meta', order: 1, render: (r) => <Badge tone={reachabilityTone(r.reachability).tone}>{reachabilityTone(r.reachability).label}</Badge> },
      render: (r) => {
        const { tone, label } = reachabilityTone(r.reachability);
        return <Badge tone={tone}>{label}</Badge>;
      },
    },
    {
      key: 'service',
      label: 'Service',
      // Search what the cell actually shows, so "docker" or "pm2" finds the
      // rows the column now labels that way.
      searchAccessor: (r) => serviceLabel(r).text,
      mobile: { slot: 'secondary', render: (r) => serviceLabel(r).text },
      render: (r) => {
        const { text, inferred } = serviceLabel(r);
        return (
          <span className={inferred ? 'text-muted-foreground' : 'text-foreground'} title={text}>
            {text}
          </span>
        );
      },
    },
    {
      key: 'owner',
      label: 'Owner',
      mobile: { slot: 'meta', order: 2, render: (r) => (r.ownerKind ? `${r.ownerKind}/${r.ownerName || '-'}` : null) },
      render: (r) => (
        <div className="max-w-[14rem]">
          <p className="truncate text-sm text-foreground">
            {r.ownerKind ? `${r.ownerKind}/${r.ownerName || '-'}` : <span className="text-muted-foreground">Unattributed</span>}
          </p>
          {(r.ownerDetail || r.ownerUser) && (
            <p className="truncate text-[11px] text-muted-foreground">
              {[r.ownerDetail, r.ownerUser ? `user: ${r.ownerUser}` : null].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'sourcePath',
      label: 'Source',
      hideBelow: 'lg',
      mobile: 'hidden',
      render: (r) => (
        <span className="max-w-[12rem] truncate font-mono text-[11px] text-muted-foreground" title={r.sourcePath}>
          {r.sourcePath || '-'}
        </span>
      ),
    },
  ];

  const findingColumns = [
    {
      key: 'severity',
      label: 'Severity',
      className: 'w-28',
      mobile: 'hidden',
      render: (r) => <SeverityBadge severity={r.severity} />,
    },
    {
      key: 'finding',
      label: 'Finding',
      mobile: { slot: 'title', render: (r) => r.message },
      render: (r) => (
        <div>
          <p className="font-medium text-foreground">{r.message}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {r.code}
            {r.proto && r.port ? ` · ${r.proto}/${r.port}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      mobile: { slot: 'meta', render: (r) => <FindingStatusBadge status={r.status} /> },
      render: (r) => <FindingStatusBadge status={r.status} />,
    },
    {
      key: 'lastSeenAt',
      label: 'Last seen',
      hideBelow: 'md',
      mobile: { slot: 'secondary', render: (r) => `Since ${relativeTime(r.firstSeenAt)}` },
      render: (r) => (
        <span className="text-xs text-muted-foreground" title={formatDateTime(r.lastSeenAt)}>
          {relativeTime(r.lastSeenAt)}
        </span>
      ),
    },
    ...(canMute
      ? [
          {
            key: 'actions',
            label: '',
            className: 'w-10',
            actions: [
              {
                label: 'Acknowledge',
                icon: Check,
                onClick: handleAcknowledge,
                hidden: (r) => r.status !== 'open' || !!r.acknowledgedAt || busyId === r.id,
              },
              {
                label: 'Mute…',
                icon: VolumeX,
                onClick: (r) => setMuteTarget({ id: r.id }),
                hidden: (r) => r.status !== 'open',
              },
              {
                label: 'Unmute',
                icon: Volume1,
                onClick: handleUnmute,
                hidden: (r) => r.status !== 'muted' || busyId === r.id,
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      {/* Collector / snapshot status — a degraded or stale collector must be
          visible, never a silent "all clean". */}
      {collector.stale && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">This host stopped reporting</p>
            <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-300/90">
              Last snapshot {relativeTime(collector.lastSeenAt)} ({formatDateTime(collector.lastSeenAt)}). Findings below
              are held at their last known state, not cleared — verify the collector timer / connectivity on the host.
            </p>
          </div>
        </div>
      )}
      {snapshot.collectorOk === false && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Collector degraded</p>
            <p className="mt-0.5 text-xs opacity-90">
              {snapshot.degradedReason || 'The collector ran but could not fully inspect this host — treat this report as incomplete, not clean.'}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-foreground">Collector</h3>
          </div>
          <div className="px-5 py-4">
            <StatRow label="Status">
              {collector.stale ? (
                <Badge tone="warning">Stale</Badge>
              ) : snapshot.collectorOk === false ? (
                <Badge tone="danger">Degraded</Badge>
              ) : (
                <Badge tone="success" icon={ShieldCheck}>
                  Reporting
                </Badge>
              )}
            </StatRow>
            <StatRow label="Version">{collector.version || 'Unknown'}</StatRow>
            <StatRow label="Last snapshot">
              {collector.lastSeenAt ? `${relativeTime(collector.lastSeenAt)} · ${formatDateTime(collector.lastSeenAt)}` : '-'}
            </StatRow>
            <StatRow label="Collected at">{formatDateTime(snapshot.collectedAt)}</StatRow>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-foreground">Firewall</h3>
          </div>
          <div className="px-5 py-4">
            <StatRow label="Engine">
              {snapshot.firewall?.engine && snapshot.firewall.engine !== 'unknown' ? (
                <span className="uppercase">{snapshot.firewall.engine}</span>
              ) : (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Wifi className="h-3.5 w-3.5" /> No usable firewall data
                </span>
              )}
            </StatRow>
            <StatRow label="Active">{snapshot.firewall?.active === true ? 'Yes' : snapshot.firewall?.active === false ? 'No' : '-'}</StatRow>
            <StatRow label="Default incoming">{snapshot.firewall?.defaultIncoming || '-'}</StatRow>
          </div>
        </div>
      </div>

      {metrics.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-foreground">Resources (~24h)</h3>
            <button
              type="button"
              onClick={() => navigate(`/servers/${serverId}/resources`)}
              className="text-xs text-primary hover:underline"
            >
              View history
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <GaugeCard icon={Cpu} label="CPU" points={cpu} color="primary" onClick={() => navigate(`/servers/${serverId}/resources`)} />
            <GaugeCard icon={Gauge} label="Memory" points={mem} color="violet" onClick={() => navigate(`/servers/${serverId}/resources`)} />
            <GaugeCard icon={HardDrive} label="Disk" points={disk} color="amber" onClick={() => navigate(`/servers/${serverId}/resources`)} />
            <GaugeCard icon={Database} label="Load (1m)" points={load} unit="" color="emerald" onClick={() => navigate(`/servers/${serverId}/resources`)} />
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Open findings</h3>
          {canExport && findings.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setExportDataset('findings')}>
              <Download className="mr-1.5 h-4 w-4" /> Export
            </Button>
          )}
        </div>
        {findings.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No open findings" description="This host is clean as of the last snapshot." />
        ) : (
          <DataTable
            columns={findingColumns}
            data={findings}
            onRowClick={setDetailFinding}
            showSearch={false}
            emptyMessage="No open findings"
            selectable={canMute || canExpect}
            selectedIds={selected}
            onSelectionChange={setSelected}
            bulkActions={bulkBar}
          />
        )}
      </div>

      {expectedPorts.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-foreground">Expected on this server</h3>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {expectedPorts.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="shrink-0 font-mono text-foreground">
                  {e.proto === 'any' ? 'ANY' : e.proto.toUpperCase()}/{e.port}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={e.note}>
                  {e.note}
                  {e.createdBy?.name ? ` · ${e.createdBy.name}` : ''}
                </span>
                {canExpect && (
                  <button
                    type="button"
                    onClick={async () => {
                      await removeExpectedPort(serverId, e.id);
                      loadExpected();
                      fetch();
                    }}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Stop expecting port ${e.port}`}
                    title="Stop expecting this port"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-muted-foreground">
            These ports are not reported as exposed on this host. Removing an entry does not reopen
            the finding immediately — it comes back on the next snapshot if the port is still
            listening, which is the only evidence that justifies reopening it.
          </p>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Listeners</h3>
          {canExport && listeners.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setExportDataset('listeners')}>
              <Download className="mr-1.5 h-4 w-4" /> Export
            </Button>
          )}
        </div>
        <DataTable
          columns={listenerColumns}
          data={listeners}
          onRowClick={setDetailListener}
          showSearch={listeners.length > 8}
          searchPlaceholder="Search port, service or owner..."
          emptyMessage="No listening ports reported"
          mobile={{ accent: (r) => (r.reachability === 'internet' ? { tone: 'danger', label: 'INTERNET' } : null) }}
        />
      </div>

      <ExportDialog
        open={!!exportDataset}
        dataset={exportDataset || 'findings'}
        filters={{ serverId, ...(exportDataset === 'findings' ? { status: 'open' } : {}) }}
        scopeLabel={exportDataset === 'listeners' ? 'this server\u2019s listening ports' : 'this server\u2019s open findings'}
        onClose={() => setExportDataset(null)}
      />

      <ExpectedPortDialog
        open={!!expectedTargets}
        serverId={serverId}
        targets={expectedTargets || []}
        onClose={() => setExpectedTargets(null)}
        onDone={() => { setSelected([]); fetch(); loadExpected(); }}
      />

      <FindingDetailModal
        open={!!detailFinding}
        finding={detailFinding}
        onClose={() => setDetailFinding(null)}
        canMute={canMute}
        busy={busyId === detailFinding?.id}
        showServerLink={false}
        onAcknowledge={(f) => { setDetailFinding(null); handleAcknowledge(f); }}
        onMute={(f) => { setDetailFinding(null); setMuteTarget({ id: f.id }); }}
        onUnmute={(f) => { setDetailFinding(null); handleUnmute(f); }}
        canExpect={canExpect}
        onMarkExpected={(f) => {
          setDetailFinding(null);
          setExpectedTargets([{ port: f.port, proto: f.proto }]);
        }}
      />

      <ListenerDetailModal
        open={!!detailListener}
        listener={detailListener}
        findings={findings}
        onClose={() => setDetailListener(null)}
        onOpenFinding={(f) => { setDetailListener(null); setDetailFinding(f); }}
      />

      <MuteDialog
        open={!!muteTarget}
        count={1}
        submitting={muteSubmitting}
        error={muteError}
        onConfirm={handleMuteConfirm}
        onCancel={() => { setMuteTarget(null); setMuteError(''); }}
      />
    </div>
  );
}

export default ServerPostureTab;
