import { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import Badge from '@/components/shared/Badge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import Modal from '@/components/shared/Modal';
import RequestForm from '@/components/access-requests/RequestForm';
import ApprovalCard from '@/components/access-requests/ApprovalCard';
import CredentialDownload from '@/components/access-requests/CredentialDownload';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  listAccessRequests,
  getAccessRequest,
  revokeAccessRequest,
} from '@/services/accessRequestService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime, formatDateTime } from '@/utils/time';

const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

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
  const isReviewer =
    isAtLeast(currentUser, 'admin') ||
    currentUser?.id === request?.reviewerId ||
    currentUser?.id === request?.requester?.managerId;
  const canRevoke =
    request?.status === 'APPROVED' && (isRequester || isAtLeast(currentUser, 'admin'));

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
                    {request.server.hostname || request.server.name}
                    {request.server.environment && (
                      <EnvironmentBadge environment={request.server.environment} />
                    )}
                  </span>
                ) : request.serverId
              }
            />
            <DetailRow label="Protocol" value={request.protocol} />
            <DetailRow label="Status" value={<StatusBadge status={request.status} />} />
            <DetailRow
              label="Requester"
              value={request.requester?.name || request.requester?.email || request.requesterId}
            />
            <DetailRow
              label="Reviewer"
              value={request.reviewer?.name || request.reviewer?.email || request.reviewerId || '-'}
            />
            <DetailRow label="Reason" value={request.reason} />
            <DetailRow label="Requested Duration" value={formatDuration(request.requestedDuration)} />
            <DetailRow label="Approved Duration" value={formatDuration(request.approvedDuration)} />
            <DetailRow label="Principal" value={request.requestedPrincipal} />
            <DetailRow label="Denied Reason" value={request.deniedReason} />
            <DetailRow label="Expires At" value={formatDateTime(request.expiresAt)} />
            <DetailRow label="Created" value={formatDateTime(request.createdAt)} />
            <DetailRow label="Reviewed At" value={formatDateTime(request.reviewedAt)} />
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
                  Revoke Access
                </Button>
              ) : (
                <div className="rounded-md border border-destructive/30 p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Revoke Access
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
  { key: 'mine', label: 'My Requests' },
  { key: 'to-review', label: 'Pending Reviews' },
];

const STATUSES = ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'REVOKED'];

function AccessRequests() {
  const { user } = useAuth();
  const isAdmin = isAtLeast(user, 'admin');
  const tabs = isAdmin ? [...TABS, { key: 'all', label: 'All' }] : TABS;

  const [activeTab, setActiveTab] = useState('mine');
  const [requests, setRequests] = useState([]);
  const [total, setTotal] = useState(0);
  const [pendingReviewCount, setPendingReviewCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [initialServerId, setInitialServerId] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setInitialServerId(searchParams.get('serverId') || '');
      setFormOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      next.delete('serverId');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { tab: activeTab, page, limit: pageSize };
      if (statusFilter) params.status = statusFilter;
      const resp = await listAccessRequests(params);
      const items = resp.data?.items || resp.data || [];
      const metaTotal = resp.meta?.total ?? (Array.isArray(resp.data) ? resp.data.length : 0);
      setRequests(items);
      setTotal(metaTotal);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load access requests.');
    } finally {
      setLoading(false);
    }
  }, [activeTab, page, pageSize, statusFilter]);

  const fetchPendingReviewCount = useCallback(async () => {
    try {
      const resp = await listAccessRequests({ tab: 'to-review', status: 'PENDING', limit: 1 });
      const count = resp.meta?.total ?? 0;
      setPendingReviewCount(count);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);
  useEffect(() => { fetchPendingReviewCount(); }, [fetchPendingReviewCount]);

  const handleTabChange = (key) => {
    setActiveTab(key);
    setPage(1);
    setStatusFilter('');
  };

  const openDetail = (id) => {
    setSelectedId(id);
    setDetailOpen(true);
  };

  const handleRefresh = () => {
    fetchRequests();
    fetchPendingReviewCount();
  };

  const filterSlot = (
    <Select
      value={statusFilter || '_all'}
      onValueChange={(v) => { setStatusFilter(v === '_all' ? '' : v); setPage(1); }}
    >
      <SelectTrigger className="w-[160px]"><SelectValue placeholder="All statuses" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="_all">All statuses</SelectItem>
        {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
      </SelectContent>
    </Select>
  );

  const columns = [
    {
      key: 'server',
      label: 'Server',
      sortable: true,
      searchAccessor: (r) => `${r.server?.hostname || r.server?.name || ''} ${r.server?.environment || ''}`,
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {r.server?.hostname || r.server?.name || r.serverId}
          </span>
          {r.server?.environment && <EnvironmentBadge environment={r.server.environment} />}
        </div>
      ),
    },
    ...(activeTab !== 'mine'
      ? [{
          key: 'requester',
          label: 'Requester',
          sortable: true,
          searchAccessor: (r) => r.requester?.name || r.requester?.email || '',
          render: (r) => (
            <span className="text-sm text-foreground">
              {r.requester?.name || r.requester?.email || r.requesterId}
            </span>
          ),
        }]
      : []),
    ...(activeTab === 'mine'
      ? [{
          key: 'reviewer',
          label: 'Reviewer',
          render: (r) => (
            <span className="text-sm text-muted-foreground">
              {r.reviewer?.name || r.reviewer?.email || '-'}
            </span>
          ),
        }]
      : []),
    {
      key: 'reason',
      label: 'Reason',
      hideBelow: 'md',
      render: (r) => (
        <span className="block max-w-xs truncate text-sm text-muted-foreground" title={r.reason}>
          {r.reason}
        </span>
      ),
    },
    {
      key: 'duration',
      label: 'Duration',
      render: (r) => (
        <span className="text-sm text-muted-foreground">{formatDuration(r.requestedDuration)}</span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      searchAccessor: (r) => r.status || '',
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: 'createdAt',
      label: 'Created',
      sortable: true,
      hideBelow: 'lg',
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
          label: 'View Details',
          icon: Eye,
          onClick: (r) => openDetail(r.id),
        },
        ...(isAdmin
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
        subtitle="Request temporary access to servers or review pending requests." helpKey="access-requests">
        <Button onClick={() => setFormOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Request
        </Button>
      </PageHeader>

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
        searchPlaceholder="Search servers or requesters..."
        filters={filterSlot}
        serverPagination={{
          page,
          total,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => { setPageSize(size); setPage(1); },
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
