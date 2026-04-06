import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Clock,
  CheckCircle,
  XCircle,
  Ban,
  AlertCircle,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import Badge from '@/components/shared/Badge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import Modal from '@/components/shared/Modal';
import RequestForm from '@/components/access-requests/RequestForm';
import ApprovalCard from '@/components/access-requests/ApprovalCard';
import CredentialDownload from '@/components/access-requests/CredentialDownload';
import {
  listAccessRequests,
  getAccessRequest,
  revokeAccessRequest,
} from '@/services/accessRequestService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime, formatDateTime } from '@/utils/time';

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
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
      const resp = await getAccessRequest(requestId);
      setRequest(resp.data || resp);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to load request details.');
    } finally {
      setLoading(false);
    }
  }, [requestId, open]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

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
                ) : (
                  request.serverId
                )
              }
            />
            <DetailRow label="Protocol" value={request.protocol} />
            <DetailRow
              label="Status"
              value={<StatusBadge status={request.status} />}
            />
            <DetailRow
              label="Requester"
              value={request.requester?.name || request.requester?.email || request.requesterId}
            />
            <DetailRow
              label="Reviewer"
              value={request.reviewer?.name || request.reviewer?.email || request.reviewerId || '-'}
            />
            <DetailRow label="Reason" value={request.reason} />
            <DetailRow
              label="Requested Duration"
              value={formatDuration(request.requestedDuration)}
            />
            <DetailRow
              label="Approved Duration"
              value={formatDuration(request.approvedDuration)}
            />
            <DetailRow label="Principal" value={request.requestedPrincipal} />
            <DetailRow label="Denied Reason" value={request.deniedReason} />
            <DetailRow label="Expires At" value={formatDateTime(request.expiresAt)} />
            <DetailRow label="Created" value={formatDateTime(request.createdAt)} />
            <DetailRow label="Reviewed At" value={formatDateTime(request.reviewedAt)} />
          </dl>

          {/* Reviewer approval panel */}
          {isReviewer && request.status === 'PENDING' && (
            <ApprovalCard request={request} onRefresh={handleRefresh} />
          )}

          {/* Requester credential download */}
          {isRequester && request.status === 'APPROVED' && (
            <CredentialDownload request={request} />
          )}

          {/* Revoke */}
          {canRevoke && (
            <div className="mt-4">
              {!showRevokeForm ? (
                <button
                  onClick={() => setShowRevokeForm(true)}
                  className="flex items-center gap-2 rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
                >
                  <Ban className="h-4 w-4" />
                  Revoke Access
                </button>
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
                    <button
                      onClick={handleRevoke}
                      disabled={revoking || !revokeReason.trim()}
                      className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                    >
                      {revoking ? 'Revoking...' : 'Confirm Revoke'}
                    </button>
                    <button
                      onClick={() => {
                        setShowRevokeForm(false);
                        setRevokeReason('');
                      }}
                      className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent"
                    >
                      Cancel
                    </button>
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
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

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
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  useEffect(() => {
    fetchPendingReviewCount();
  }, [fetchPendingReviewCount]);

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

  const columns = [
    {
      key: 'server',
      label: 'Server',
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
      ? [
          {
            key: 'requester',
            label: 'Requester',
            render: (r) => (
              <div>
                <p className="text-sm text-foreground">
                  {r.requester?.name || r.requester?.email || r.requesterId}
                </p>
              </div>
            ),
          },
        ]
      : []),
    ...(activeTab === 'mine'
      ? [
          {
            key: 'reviewer',
            label: 'Reviewer',
            render: (r) => (
              <span className="text-sm text-muted-foreground">
                {r.reviewer?.name || r.reviewer?.email || '-'}
              </span>
            ),
          },
        ]
      : []),
    {
      key: 'reason',
      label: 'Reason',
      render: (r) => (
        <span
          className="block max-w-xs truncate text-sm text-muted-foreground"
          title={r.reason}
        >
          {r.reason}
        </span>
      ),
    },
    {
      key: 'duration',
      label: 'Duration',
      render: (r) => (
        <span className="text-sm text-muted-foreground">
          {formatDuration(r.requestedDuration)}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: 'createdAt',
      label: 'Created',
      render: (r) => (
        <span className="text-xs text-muted-foreground">{relativeTime(r.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-16',
      render: (r) => (
        <button
          onClick={() => openDetail(r.id)}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          View
        </button>
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const selectCls =
    'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Access Requests</h1>
          <p className="text-sm text-muted-foreground">
            Request temporary access to servers or review pending requests.
          </p>
        </div>
        <button
          onClick={() => setFormOpen(true)}
          className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Request
        </button>
      </div>

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

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          className={selectCls}
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
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
      />


      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {total} request{total === 1 ? '' : 's'}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <RequestDetailModal
        requestId={selectedId}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setSelectedId(null);
        }}
        onRefresh={handleRefresh}
        currentUser={user}
      />

      <RequestForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={handleRefresh}
      />
    </div>
  );
}

export default AccessRequests;
