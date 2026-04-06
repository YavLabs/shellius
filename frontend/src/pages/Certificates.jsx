import { useState, useEffect, useCallback, useRef } from 'react';
import {
  MoreVertical,
  ShieldX,
  Eye,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import SearchInput from '@/components/shared/SearchInput';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import CertStatusBadge from '@/components/shared/CertStatusBadge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { listCertificates, revokeCertificate } from '@/services/certificateService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime } from '@/utils/time';

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

function validUntilLabel(validBefore) {
  if (!validBefore) return '-';
  const d = new Date(validBefore);
  if (Number.isNaN(d.getTime())) return '-';
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  const days = Math.floor(h / 24);
  return `in ${days}d`;
}

function RowMenu({ onView, onRevoke, canRevoke }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const fn = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', fn);
    return () => window.removeEventListener('mousedown', fn);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((p) => !p);
        }}
        className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-border bg-card shadow-lg">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onView();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
          >
            <Eye className="h-3.5 w-3.5" /> View Details
          </button>
          {canRevoke && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onRevoke();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive hover:bg-accent"
            >
              <ShieldX className="h-3.5 w-3.5" /> Revoke
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-b border-border py-2.5 last:border-0">
      <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide col-span-1">
        {label}
      </dt>
      <dd className="text-sm text-foreground col-span-2 break-all">{value ?? '-'}</dd>
    </div>
  );
}

function CertDetailModal({ cert, open, onClose }) {
  if (!cert) return null;
  return (
    <Modal open={open} onClose={onClose} title="Certificate Details" size="lg">
      <dl>
        <DetailRow label="Serial" value={cert.serial} />
        <DetailRow label="Status" value={<CertStatusBadge status={cert.status} />} />
        <DetailRow
          label="Issued To"
          value={cert.issuedTo?.name || cert.issuedTo?.email || cert.userId}
        />
        <DetailRow
          label="Issued For"
          value={
            cert.issuedFor ? (
              <span className="flex items-center gap-2">
                {cert.issuedFor.hostname}
                {cert.issuedFor.environment && (
                  <EnvironmentBadge environment={cert.issuedFor.environment} />
                )}
              </span>
            ) : (
              cert.serverId
            )
          }
        />
        <DetailRow
          label="Principals"
          value={
            Array.isArray(cert.principals) ? cert.principals.join(', ') : cert.principals
          }
        />
        <DetailRow label="Key ID" value={cert.keyId} />
        <DetailRow label="Cert Type" value={cert.certType} />
        <DetailRow label="CA Key Pair ID" value={cert.caKeyPairId} />
        <DetailRow label="Valid After" value={formatDateTime(cert.validAfter)} />
        <DetailRow label="Valid Before" value={formatDateTime(cert.validBefore)} />
        <DetailRow label="Issued At" value={formatDateTime(cert.createdAt)} />
        <DetailRow label="Revoked At" value={formatDateTime(cert.revokedAt)} />
        <DetailRow
          label="Revoked By"
          value={cert.revokedBy?.name || cert.revokedBy?.email || cert.revokedById}
        />
        {cert.extensions && Object.keys(cert.extensions).length > 0 && (
          <DetailRow
            label="Extensions"
            value={
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
                {JSON.stringify(cert.extensions, null, 2)}
              </pre>
            }
          />
        )}
        {cert.criticalOptions && Object.keys(cert.criticalOptions).length > 0 && (
          <DetailRow
            label="Critical Options"
            value={
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
                {JSON.stringify(cert.criticalOptions, null, 2)}
              </pre>
            }
          />
        )}
      </dl>
    </Modal>
  );
}

const STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'];

function Certificates() {
  const { user } = useAuth();
  const canAdmin = isAtLeast(user, 'admin');

  const [certs, setCerts] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [detailCert, setDetailCert] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: pageSize };
      if (statusFilter) params.status = statusFilter;
      const resp = await listCertificates(params);
      const items = resp.data?.items || resp.data || [];
      const metaTotal =
        resp.meta?.total ?? resp.data?.total ?? items.length;
      setCerts(items);
      setTotal(metaTotal);
    } catch (err) {
      setError(
        err.response?.data?.error?.message || err.message || 'Failed to load certificates'
      );
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, statusFilter]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const filteredCerts = search
    ? certs.filter((c) => {
        const q = search.toLowerCase();
        const userName = (c.issuedTo?.name || c.issuedTo?.email || '').toLowerCase();
        const serverName = (c.issuedFor?.hostname || '').toLowerCase();
        const serial = (c.serial || '').toLowerCase();
        return userName.includes(q) || serverName.includes(q) || serial.includes(q);
      })
    : certs;

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await revokeCertificate(revokeTarget.id);
      setRevokeTarget(null);
      fetch();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to revoke certificate');
      setRevokeTarget(null);
    } finally {
      setRevoking(false);
    }
  };

  const columns = [
    {
      key: 'serial',
      label: 'Serial',
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">
          {r.serial ? r.serial.slice(0, 16) + (r.serial.length > 16 ? '…' : '') : '-'}
        </span>
      ),
    },
    {
      key: 'issuedTo',
      label: 'Issued To',
      render: (r) => (
        <div>
          <p className="text-sm font-medium text-foreground">
            {r.issuedTo?.name || '-'}
          </p>
          <p className="text-xs text-muted-foreground">{r.issuedTo?.email || r.userId}</p>
        </div>
      ),
    },
    {
      key: 'server',
      label: 'Server',
      render: (r) =>
        r.issuedFor ? (
          <span className="flex items-center gap-2">
            <span className="text-sm text-foreground">{r.issuedFor.hostname}</span>
            <EnvironmentBadge environment={r.issuedFor.environment} />
          </span>
        ) : (
          <span className="text-muted-foreground text-sm">-</span>
        ),
    },
    {
      key: 'principals',
      label: 'Principals',
      render: (r) => {
        const list = Array.isArray(r.principals) ? r.principals : [];
        const display = list.slice(0, 3).join(', ');
        const extra = list.length > 3 ? ` +${list.length - 3}` : '';
        return (
          <span className="font-mono text-xs text-muted-foreground">
            {display || '-'}
            {extra && <span className="text-muted-foreground/60">{extra}</span>}
          </span>
        );
      },
    },
    {
      key: 'validBefore',
      label: 'Valid Until',
      render: (r) => {
        const label = validUntilLabel(r.validBefore);
        const isExpired = label === 'Expired';
        return (
          <span
            className={
              isExpired
                ? 'text-xs text-muted-foreground'
                : 'text-xs text-foreground'
            }
          >
            {label}
          </span>
        );
      },
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <CertStatusBadge status={r.status} />,
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      render: (r) => (
        <RowMenu
          onView={() => setDetailCert(r)}
          onRevoke={() => setRevokeTarget(r)}
          canRevoke={canAdmin && r.status === 'ACTIVE'}
        />
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectCls =
    'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Certificates</h1>
          <p className="text-sm text-muted-foreground">
            Short-lived SSH certificates issued by the Shellius CA.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-64 flex-1">
          <SearchInput
            value={search}
            onChange={(v) => setSearch(v)}
            placeholder="Search by user, server, or serial..."
          />
        </div>
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
        data={filteredCerts}
        loading={loading}
        emptyMessage="No certificates found"
      />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {total} certificate{total === 1 ? '' : 's'}
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

      <CertDetailModal
        cert={detailCert}
        open={!!detailCert}
        onClose={() => setDetailCert(null)}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke Certificate"
        message={`Revoke certificate for ${
          revokeTarget?.issuedTo?.name || revokeTarget?.issuedTo?.email || 'this user'
        } on ${revokeTarget?.issuedFor?.hostname || 'this server'}? This cannot be undone and will immediately terminate active sessions using this certificate.`}
        confirmLabel={revoking ? 'Revoking...' : 'Revoke'}
        variant="destructive"
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}

export default Certificates;
