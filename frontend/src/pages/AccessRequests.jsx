import { useState, useEffect, useCallback, useRef } from 'react';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { useSearchParams } from 'react-router-dom';
import {
  Plus,
  Clock,
  CheckCircle,
  XCircle,
  Ban,
  AlertCircle,
  KeyRound,
  Eye,
  Zap,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import ServerName, { serverSearchString } from '@/components/shared/ServerName';
import EntityLink from '@/components/EntityLink';
import Badge from '@/components/shared/Badge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import UserCell from '@/components/shared/UserCell';
import Avatar from '@/components/ui/Avatar';
import Modal from '@/components/shared/Modal';
import FilteredEmptyState from '@/components/shared/FilteredEmptyState';
import { appliedFilterCount, clearedFilterValues } from '@/lib/filters';
import RequestForm from '@/components/access-requests/RequestForm';
import ApprovalCard from '@/components/access-requests/ApprovalCard';
import CredentialDownload from '@/components/access-requests/CredentialDownload';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import {
  listAccessRequests,
  getAccessRequest,
  revokeAccessRequest,
} from '@/services/accessRequestService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime, formatDateTime } from '@/utils/time';
import { ACCESS_REQUEST_STATUS_LABELS } from '@/lib/labels';
import { PENDING_REVIEWS_EVENT } from '@/hooks/usePendingReviewCount';
import { can } from '@/lib/permissions';
import useAutoRefresh from '@/hooks/useAutoRefresh';
import useUrlFilters from '@/hooks/useUrlFilters';
import { envAccent } from '@/lib/mobileCard';
import { CardStatus } from '@/components/mobile/MobileCard';
import { statusTone } from '@/lib/badgeTones';



const STATUS_META = {
  PENDING: { label: 'Pending', variant: 'warning', Icon: Clock },
  APPROVED: { label: 'Approved', variant: 'success', Icon: CheckCircle },
  DENIED: { label: 'Denied', variant: 'danger', Icon: XCircle },
  EXPIRED: { label: 'Expired', variant: 'default', Icon: AlertCircle },
  REVOKED: { label: 'Revoked', variant: 'danger', Icon: Ban },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, variant: 'default', Icon: AlertCircle };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

function DetailRow({ label, value }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-b border-border py-2.5 last:border-0">
      <dt className="col-span-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="col-span-2 break-all text-sm text-foreground">{value ?? '-'}</dd>
    </div>
  );
}

function formatDuration(seconds) {
  if (!seconds) return '-';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function RequestDetailModal({ requestId, open, onClose, onRefresh, currentUser }) {
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');
  const [showRevokeForm, setShowRevokeForm] = useState(false);

  const fetchDetail = useCallback(async () => {
    if (!requestId || !open) return;
    setLoading(true);
    setError('');
    try {
      const ar = await getAccessRequest(requestId);
      setRequest(ar);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to load request details.');
    } finally {
      setLoading(false);
    }
  }, [requestId, open]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  const handleRefresh = () => {
    fetchDetail();
    onRefresh?.();
  };

  const handleRevoke = async () => {
    if (!revokeReason.trim()) return;
    setRevoking(true);
    try {
      await revokeAccessRequest(request.id, { reason: revokeReason.trim() });
      setShowRevokeForm(false);
      setRevokeReason('');
      handleRefresh();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to revoke access.');
    } finally {
      setRevoking(false);
    }
  };

  const isRequester = currentUser?.id === request?.requesterId;
  // The API says what this viewer may do with the request (approver set,
  // access_requests.revoke_any), so the buttons always match what it allows.
  const isReviewer = !!request?.viewer?.canReview;
  const canRevoke = !!request?.viewer?.canRevoke;

  return (
    <Modal open={open} onClose={onClose} title="Access Request Details" size="lg">
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-8 w-full animate-pulse rounded bg-muted" />
          ))}
        </div>
      )}
      {!loading && error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {!loading && request && (
        <div>
          <dl>
            <DetailRow
              label="Server"
              value={
                request.server ? (
                  <span className="flex items-center gap-2">
                    <EntityLink
                      to={`/servers/${request.server.id}`}
                      entityType="server"
                      entityName={request.server.displayName || request.server.hostname}
                    >
                      <ServerName server={request.server} />
                    </EntityLink>
                    {request.server.environment && (
                      <EnvironmentBadge environment={request.server.environment} />
                    )}
                  </span>
                ) : request.serverId
              }
            />
            {request.server?.customer && (
              <DetailRow
                label="Customer"
                value={
                  <EntityLink
                    to={`/customers/${request.server.customer.id}`}
                    entityType="customer"
                    entityName={request.server.customer.name}
                  >
                    {request.server.customer.name}
                  </EntityLink>
                }
              />
            )}
            <DetailRow label="Protocol" value={request.protocol} />
            <DetailRow label="Status" value={<StatusBadge status={request.status} />} />
            <DetailRow
              label="Requester"
              value={request.requester ? <UserCell user={request.requester} /> : request.requesterId}
            />
            <DetailRow
              label="Reviewer"
              value={request.reviewer ? <UserCell user={request.reviewer} /> : request.reviewerId || '-'}
            />
            <DetailRow label="Reason" value={request.reason} />
            <DetailRow label="Requested duration" value={formatDuration(request.requestedDuration)} />
            <DetailRow label="Approved duration" value={formatDuration(request.approvedDuration)} />
            <DetailRow label="Principal" value={request.requestedPrincipal} />
            <DetailRow label="Denied reason" value={request.deniedReason} />
            <DetailRow label="Expires at" value={formatDateTime(request.expiresAt)} />
            <DetailRow label="Created" value={formatDateTime(request.createdAt)} />
            <DetailRow label="Reviewed at" value={formatDateTime(request.reviewedAt)} />
          </dl>

          {isReviewer && request.status === 'PENDING' && (
            <ApprovalCard request={request} onRefresh={handleRefresh} />
          )}
          {isRequester && request.status === 'APPROVED' && (
            <CredentialDownload request={request} />
          )}

          {canRevoke && (
            <div className="mt-4">
              {!showRevokeForm ? (
                <Button
                  variant="outline"
                  onClick={() => setShowRevokeForm(true)}
                  className="border-destructive/50 text-destructive hover:bg-destructive/10"
                >
                  <Ban className="mr-2 h-4 w-4" />
                  Revoke access
                </Button>
              ) : (
                <div className="rounded-md border border-destructive/30 p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Revoke access
                  </p>
                  <textarea
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    rows={2}
                    value={revokeReason}
                    onChange={(e) => setRevokeReason(e.target.value)}
                    placeholder="Reason for revocation..."
                  />
                  <div className="flex gap-2">
                    <Button variant="destructive" size="sm" onClick={handleRevoke} disabled={revoking || !revokeReason.trim()}>
                      {revoking ? 'Revoking...' : 'Confirm Revoke'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setShowRevokeForm(false); setRevokeReason(''); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const TABS = [
  { key: 'mine', label: 'My requests' },
  { key: 'to-review', label: 'Pending reviews' },
];

const STATUSES = ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'REVOKED'];

// A picker may only list users if the caller can, via one of the
// permissions lookup.js's ACCESS.users checks (backend routes/lookup.js).
// Without one of these the picker's API call 403s and shows an empty list —
// so the filter itself is hidden rather than offered and failing silently.
function canListUsers(user) {
  return (
    can(user, 'users.view') ||
    can(user, 'access_requests.view_all') ||
    can(user, 'sessions.view_all') ||
    can(user, 'certificates.view_all') ||
    can(user, 'audit.view')
  );
}

const AR_FILTER_DEFAULTS = {
  tab: 'mine',
  status: '',
  server: '',
  requester: '',
  reviewer: '',
  customer: '',
  protocol: '',
  environment: '',
  startDate: '',
  endDate: '',
  q: '',
  sortBy: 'createdAt',
  sortDir: 'desc',
  page: '1',
};

function AccessRequests() {
  const { user } = useAuth();
  const { openTab } = useTerminalWorkspace();
  const isAdmin = can(user, 'access_requests.view_all');
  const canPickUsers = canListUsers(user);
  const tabs = isAdmin ? [...TABS, { key: 'all', label: 'All' }] : TABS;

  const [f, setF] = useUrlFilters(AR_FILTER_DEFAULTS);
  // ?tab=to-review (Activity's "To review" tile) / ?tab=all opens that tab —
  // re-validated on every URL change (not just first render), and falls back
  // to 'mine' for a tab this viewer isn't allowed (or doesn't exist).
  const activeTab = f.tab === 'to-review' || (f.tab === 'all' && isAdmin) ? f.tab : 'mine';
  const page = parseInt(f.page, 10) || 1;

  const [requests, setRequests] = useState([]);
  const [total, setTotal] = useState(0);
  const [pendingReviewCount, setPendingReviewCount] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [initialServerId, setInitialServerId] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    // Supports both the legacy `?new=1` trigger and the documented
    // `?action=new` deep-link contract (components/command/CommandPalette.jsx,
    // components/command/QuickActionsMenu.jsx).
    if (searchParams.get('new') === '1' || searchParams.get('action') === 'new') {
      setInitialServerId(searchParams.get('serverId') || '');
      setFormOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      next.delete('action');
      next.delete('serverId');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Deep link: ?request=<id> (e.g. from the Audit Log or a notification)
  // opens that request's detail modal, whichever tab it's in.
  useEffect(() => {
    const requestId = searchParams.get('request');
    if (requestId) {
      setSelectedId(requestId);
      setDetailOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('request');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const loadedRef = useRef(false);
  const fetchRequests = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    setError('');
    try {
      const params = { tab: activeTab, page, limit: pageSize };
      if (f.status) params.status = f.status;
      if (f.server) params.serverId = f.server;
      if (f.requester) params.requesterId = f.requester;
      if (f.reviewer) params.reviewerId = f.reviewer;
      if (f.customer) params.customerId = f.customer;
      if (f.protocol) params.protocol = f.protocol;
      if (f.environment) params.environment = f.environment;
      if (f.q) params.search = f.q;
      if (f.sortBy) params.sortBy = f.sortBy;
      if (f.sortDir) params.sortDir = f.sortDir;
      if (f.startDate) params.startDate = f.startDate;
      if (f.endDate) params.endDate = f.endDate;
      const resp = await listAccessRequests(params);
      const items = resp.data?.items || resp.data || [];
      const metaTotal = resp.meta?.total ?? (Array.isArray(resp.data) ? resp.data.length : 0);
      setRequests(items);
      setTotal(metaTotal);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load access requests.');
    } finally {
      setLoading(false);
      loadedRef.current = true;
    }
  }, [
    activeTab,
    page,
    pageSize,
    f.status,
    f.server,
    f.requester,
    f.reviewer,
    f.customer,
    f.protocol,
    f.environment,
    f.q,
    f.sortBy,
    f.sortDir,
    f.startDate,
    f.endDate,
  ]);

  const fetchPendingReviewCount = useCallback(async () => {
    try {
      const resp = await listAccessRequests({ tab: 'to-review', status: 'PENDING', limit: 1 });
      const count = resp.meta?.total ?? 0;
      setPendingReviewCount(count);
      // Keep the sidebar badge in step with this tab (hooks/usePendingReviewCount).
      window.dispatchEvent(new CustomEvent(PENDING_REVIEWS_EVENT, { detail: count }));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);
  useEffect(() => { fetchPendingReviewCount(); }, [fetchPendingReviewCount]);

  // Pending requests change on their own (another reviewer acts, one
  // expires) — gentle 30s polling on top of the manual Refresh button.
  const loadAll = useCallback(async () => {
    await Promise.all([fetchRequests(), fetchPendingReviewCount()]);
  }, [fetchRequests, fetchPendingReviewCount]);
  const { refresh, refreshing, lastUpdated } = useAutoRefresh(loadAll, { interval: 30000 });

  const handleTabChange = (key) => {
    setF({
      tab: key,
      page: '1',
      status: '',
      server: '',
      requester: '',
      reviewer: '',
      customer: '',
      protocol: '',
      environment: '',
      startDate: '',
      endDate: '',
    });
  };

  const openDetail = (id) => {
    setSelectedId(id);
    setDetailOpen(true);
  };

  // A request is connectable when it's the caller's own, APPROVED, and unexpired.
  const isConnectable = (r) =>
    r?.status === 'APPROVED' &&
    r?.requesterId === user?.id &&
    (!r.expiresAt || new Date(r.expiresAt) > new Date());

  // Quick Connect — open the web terminal for an approved request. The Terminal
  // page detects the protocol (SSH/RDP) from the request and connects.
  const quickConnect = (r) => {
    // RDP stays a standalone window (guacamole canvas); SSH opens a tab in
    // the Terminals workspace.
    if (r.protocol === 'RDP') {
      window.open(`/terminal?requestId=${r.id}`, '_blank', 'noopener');
      return;
    }
    const server = r.server || {};
    openTab(
      { requestId: r.id, principal: r.requestedPrincipal || undefined },
      {
        label: server.displayName || server.hostname || 'Terminal',
        env: server.environment,
        host: server.ipAddress || server.hostname,
        username: r.requestedPrincipal,
      }
    );
  };

  const handleRefresh = () => {
    fetchRequests();
    fetchPendingReviewCount();
  };

  const filterDefs = [
    {
      key: 'status',
      label: 'Status',
      placeholder: 'All statuses',
      options: [
        { value: '', label: 'All statuses' },
        ...STATUSES.map((s) => ({ value: s, label: ACCESS_REQUEST_STATUS_LABELS[s] || s })),
      ],
    },
    { key: 'server', label: 'Server', type: 'entity', entity: 'servers', placeholder: 'All servers' },
    { key: 'customer', label: 'Customer', type: 'entity', entity: 'customers', placeholder: 'All customers' },
    ...(activeTab !== 'mine' && canPickUsers
      ? [{ key: 'requester', label: 'Requester', type: 'entity', entity: 'users', placeholder: 'All requesters' }]
      : []),
    ...(activeTab === 'all' && canPickUsers
      ? [{ key: 'reviewer', label: 'Reviewer', type: 'entity', entity: 'users', placeholder: 'All reviewers' }]
      : []),
    {
      key: 'protocol',
      label: 'Protocol',
      placeholder: 'All protocols',
      options: [
        { value: '', label: 'All protocols' },
        { value: 'SSH', label: 'SSH' },
        { value: 'RDP', label: 'RDP' },
      ],
    },
    {
      key: 'environment',
      label: 'Environment',
      placeholder: 'All environments',
      options: [
        { value: '', label: 'All environments' },
        { value: 'demo', label: 'Demo' },
        { value: 'dev', label: 'Dev' },
        { value: 'staging', label: 'Staging' },
        { value: 'prod', label: 'Prod' },
      ],
    },
    { key: 'startDate', label: 'Created from', type: 'date' },
    { key: 'endDate', label: 'Created to', type: 'date' },
  ];
  const filterValues = {
    status: f.status,
    server: f.server,
    customer: f.customer,
    requester: f.requester,
    reviewer: f.reviewer,
    protocol: f.protocol,
    environment: f.environment,
    startDate: f.startDate,
    endDate: f.endDate,
  };
  const applyFilters = (next) => {
    setF({
      status: next.status ?? '',
      server: next.server ?? '',
      customer: next.customer ?? '',
      requester: next.requester ?? '',
      reviewer: next.reviewer ?? '',
      protocol: next.protocol ?? '',
      environment: next.environment ?? '',
      startDate: next.startDate ?? '',
      endDate: next.endDate ?? '',
      page: '1',
    });
  };

  const columns = [
    {
      key: 'server',
      label: 'Server',
      sortable: true,
      searchAccessor: (r) => serverSearchString(r.server),
      mobile: {
        slot: 'title',
        render: (r) => r.server?.displayName || r.server?.hostname || r.serverId,
      },
      render: (r) => (
        <div className="flex items-center gap-2">
          <ServerName server={r.server} fallback={r.serverId} />
          {r.server?.environment && <EnvironmentBadge environment={r.server.environment} />}
        </div>
      ),
    },
    ...(activeTab !== 'mine'
      ? [{
          key: 'requester',
          // Not a backend-whitelisted sort column (server sorts createdAt |
          // status | requestedDuration | server) — sortable:false so the
          // header never sends a sortBy the API would 400 on.
          sortable: false,
          label: 'Requester',
          searchAccessor: (r) => r.requester?.name || r.requester?.email || '',
          mobile: {
            slot: 'secondary',
            order: 1,
            render: (r) => r.requester?.name || r.requester?.email || r.requesterId || 'Unknown user',
          },
          render: (r) => <UserCell user={r.requester} fallback={r.requesterId || 'Unknown user'} />,
        }]
      : []),
    ...(activeTab === 'mine'
      ? [{
          key: 'reviewer',
          sortable: false,
          label: 'Reviewer',
          mobile: 'hidden',
          render: (r) => (
            <span className="text-sm text-muted-foreground">
              {r.reviewer?.name || r.reviewer?.email || '-'}
            </span>
          ),
        }]
      : []),
    {
      key: 'reason',
      sortable: false,
      label: 'Reason',
      hideBelow: 'md',
      // Phones: in the request details (tap the card).
      mobile: 'hidden',
      render: (r) => (
        <span className="block max-w-xs truncate text-sm text-muted-foreground" title={r.reason}>
          {r.reason}
        </span>
      ),
    },
    {
      // Backend sort column is `requestedDuration` — key matches it directly
      // so clicking the header sends a sortBy the API already whitelists.
      key: 'requestedDuration',
      label: 'Duration',
      sortable: true,
      mobile: 'hidden',
      render: (r) => (
        <span className="text-sm text-muted-foreground">{formatDuration(r.requestedDuration)}</span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      searchAccessor: (r) => r.status || '',
      // Phones: quiet status next to the "⋯" menu (DataTable `mobile.corner`).
      mobile: 'hidden',
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: 'createdAt',
      label: 'Created',
      sortable: true,
      hideBelow: 'lg',
      mobile: {
        slot: 'secondary',
        order: 2,
        render: (r) => `${relativeTime(r.createdAt)} · ${formatDuration(r.requestedDuration)}`,
      },
      render: (r) => (
        <span className="text-xs text-muted-foreground">{relativeTime(r.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        {
          label: 'Quick Connect',
          icon: Zap,
          primary: true,
          hidden: (r) => !isConnectable(r),
          onClick: (r) => quickConnect(r),
        },
        {
          label: 'View details',
          icon: Eye,
          onClick: (r) => openDetail(r.id),
        },
        ...(can(user, 'access_requests.revoke_any')
          ? [{
              label: 'Revoke',
              icon: Ban,
              variant: 'destructive',
              onClick: (r) => openDetail(r.id),
            }]
          : []),
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={KeyRound}
        title="Access Requests"
        subtitle="Request temporary access to servers or review pending requests."
        helpKey="access-requests"
        onRefresh={refresh}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
        actions={[
          { key: 'new', label: 'New request', icon: Plus, onClick: () => setFormOpen(true) },
        ]}
      />

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={[
              'relative flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {tab.label}
            {tab.key === 'to-review' && pendingReviewCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1 text-xs font-semibold text-amber-600 dark:text-amber-400">
                {pendingReviewCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        data={requests}
        loading={loading}
        emptyMessage={
          activeTab === 'mine'
            ? 'No access requests yet. Create one to get started.'
            : activeTab === 'to-review'
            ? 'No pending requests to review.'
            : 'No access requests found.'
        }
        emptyState={
          appliedFilterCount(filterDefs, filterValues) > 0 ? (
            <FilteredEmptyState onClear={() => applyFilters(clearedFilterValues(filterDefs))} />
          ) : undefined
        }
        searchPlaceholder="Search servers or requesters..."
        initialSearch={f.q}
        onSearchChange={(value) => setF({ q: value, page: '1' })}
        serverSort={{
          sortKey: f.sortBy,
          sortDir: f.sortDir,
          onSortChange: (key, dir) => setF({ sortBy: key, sortDir: dir, page: '1' }),
        }}
        filterDefs={filterDefs}
        filterValues={filterValues}
        onFilterChange={applyFilters}
        mobile={{
          onCardClick: (r) => openDetail(r.id),
          accent: (r) => envAccent(r.server?.environment),
          corner: (r) => <CardStatus {...statusTone(r.status)} />,
          leading: (r) =>
            activeTab !== 'mine' ? (
              <Avatar name={r.requester?.name} email={r.requester?.email} avatarUrl={r.requester?.avatarUrl} size="md" />
            ) : undefined,
        }}
        serverPagination={{
          page,
          total,
          onPageChange: (p) => setF({ page: String(p) }),
          pageSize,
          onPageSizeChange: (size) => { setPageSize(size); setF({ page: '1' }); },
        }}
      />

      <RequestDetailModal
        requestId={selectedId}
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setSelectedId(null); }}
        onRefresh={handleRefresh}
        currentUser={user}
      />

      <RequestForm
        open={formOpen}
        onClose={() => { setFormOpen(false); setInitialServerId(''); }}
        onSuccess={handleRefresh}
        initialServerId={initialServerId}
      />
    </div>
  );
}

export default AccessRequests;
