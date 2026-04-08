import { useState, useEffect, useCallback } from 'react';
import {
  Eye,
  Download,
  FileKey,
  AlertTriangle,
  Ban,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import CertStatusBadge from '@/components/shared/CertStatusBadge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { listCertificates, revokeCertificate } from '@/services/certificateService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime } from '@/utils/time';

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

function downloadBlob(filename, content) {
  const blob = new Blob([content], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function msUntil(validBefore) {
  if (!validBefore) return null;
  const d = new Date(validBefore);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime() - Date.now();
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function ExpiryPill({ validBefore }) {
  const ms = msUntil(validBefore);
  if (ms === null) return null;
  if (ms <= 0) {
    return (
      <span className="ml-1 inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive border border-destructive/30">
        Expired
      </span>
    );
  }
  if (ms < ONE_DAY_MS) {
    return (
      <span className="ml-1 inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 border border-amber-500/30">
        Expiring soon
      </span>
    );
  }
  return null;
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

function CertDetailModal({ cert, open, onClose, onDownload }) {
  if (!cert) return null;
  return (
    <Modal open={open} onClose={onClose} title="Certificate Details" size="lg">
      <dl>
        <DetailRow label="Serial" value={cert.serial} />
        <DetailRow label="Status" value={<CertStatusBadge status={cert.status} />} />
        <DetailRow label="Issued To" value={cert.issuedTo?.name || cert.issuedTo?.email || cert.userId} />
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
              <span className="italic text-muted-foreground">unknown server</span>
            )
          }
        />
        <DetailRow
          label="Principals"
          value={Array.isArray(cert.principals) ? cert.principals.join(', ') : cert.principals}
        />
        <DetailRow label="Type" value={cert.certType} />
        <DetailRow label="Valid After" value={formatDateTime(cert.validAfter)} />
        <DetailRow label="Valid Before" value={formatDateTime(cert.validBefore)} />
        <DetailRow label="Issued At" value={formatDateTime(cert.createdAt)} />
        {cert.revokedAt && (
          <DetailRow label="Revoked At" value={formatDateTime(cert.revokedAt)} />
        )}
        {cert.revokedAt && (
          <DetailRow
            label="Revoked By"
            value={
              cert.revokedBy?.name ||
              cert.revokedBy?.email || (
                <span className="italic text-muted-foreground">Unknown</span>
              )
            }
          />
        )}
        {cert.extensions && Object.keys(cert.extensions).length > 0 && (
          <DetailRow
            label="Extensions"
            value={<pre className="text-xs text-muted-foreground whitespace-pre-wrap">{JSON.stringify(cert.extensions, null, 2)}</pre>}
          />
        )}
      </dl>
      {cert.signedCert && (
        <div className="mt-4 border-t border-border pt-4">
          <Button variant="outline" size="sm" onClick={() => onDownload(cert)}>
            <Download className="mr-2 h-4 w-4" /> Download .pub
          </Button>
        </div>
      )}
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
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [statusFilter, setStatusFilter] = useState('');

  const [detailCert, setDetailCert] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);

  const fetchCerts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: pageSize };
      if (statusFilter) params.status = statusFilter;
      const resp = await listCertificates(params);
      const items = resp.data?.items || resp.data || [];
      const metaTotal = resp.meta?.total ?? resp.data?.total ?? items.length;
      setCerts(items);
      setTotal(metaTotal);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load certificates');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, statusFilter]);

  useEffect(() => { fetchCerts(); }, [fetchCerts]);

  // Count certs expiring within 24h
  const expiringSoonCount = certs.filter((c) => {
    if (c.status !== 'ACTIVE') return false;
    const ms = msUntil(c.validBefore);
    return ms !== null && ms > 0 && ms < ONE_DAY_MS;
  }).length;

  const handleDownload = (cert) => {
    if (!cert.signedCert) return;
    const filename = `cert-${cert.serial || cert.id}.pub`;
    downloadBlob(filename, cert.signedCert);
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await revokeCertificate(revokeTarget.id);
      setRevokeTarget(null);
      fetchCerts();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to revoke certificate');
      setRevokeTarget(null);
    } finally {
      setRevoking(false);
    }
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
      key: 'serial',
      label: 'Serial',
      sortable: true,
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">
          {r.serial ? r.serial.slice(0, 16) + (r.serial.length > 16 ? '…' : '') : '-'}
        </span>
      ),
    },
    {
      key: 'issuedTo',
      label: 'Issued To',
      sortable: true,
      searchAccessor: (r) => `${r.issuedTo?.name || ''} ${r.issuedTo?.email || ''}`,
      render: (r) => (
        <div>
          <p className="text-sm font-medium text-foreground">{r.issuedTo?.name || '-'}</p>
          <p className="text-xs text-muted-foreground">{r.issuedTo?.email || r.userId}</p>
        </div>
      ),
    },
    {
      key: 'server',
      label: 'Server',
      sortable: true,
      searchAccessor: (r) => `${r.issuedFor?.hostname || ''} ${r.issuedFor?.environment || ''}`,
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
      hideBelow: 'md',
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
      sortable: true,
      render: (r) => {
        const label = validUntilLabel(r.validBefore);
        const isExpiredLabel = label === 'Expired';
        return (
          <span className="flex items-center">
            <span className={isExpiredLabel ? 'text-xs text-muted-foreground' : 'text-xs text-foreground'}>
              {label}
            </span>
            <ExpiryPill validBefore={r.validBefore} />
          </span>
        );
      },
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      searchAccessor: (r) => r.status || '',
      render: (r) => <CertStatusBadge status={r.status} />,
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        { label: 'View Details', icon: Eye, onClick: (r) => setDetailCert(r) },
        { label: 'Download .pub', icon: Download, onClick: (r) => handleDownload(r) },
        ...(canAdmin
          ? [
              { separator: true },
              {
                label: 'Revoke',
                icon: Ban,
                variant: 'destructive',
                onClick: (r) => r.status === 'ACTIVE' && setRevokeTarget(r),
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={FileKey}
        title="Certificates"
        subtitle="Short-lived SSH certificates issued by the Shellius CA."
      helpKey="certificates" />

      {expiringSoonCount > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {expiringSoonCount} of your certificate{expiringSoonCount === 1 ? '' : 's'} expire{expiringSoonCount === 1 ? 's' : ''} within 24 hours.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        data={certs}
        loading={loading}
        emptyMessage="No certificates found"
        searchPlaceholder="Search by user, server, or serial..."
        filters={filterSlot}
        serverPagination={{
          page,
          total,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => { setPageSize(size); setPage(1); },
        }}
      />

      <CertDetailModal
        cert={detailCert}
        open={!!detailCert}
        onClose={() => setDetailCert(null)}
        onDownload={handleDownload}
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
