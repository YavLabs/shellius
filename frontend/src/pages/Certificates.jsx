import { useState, useEffect, useCallback, useRef } from 'react';
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
import UserCell from '@/components/shared/UserCell';
import ServerName, { serverSearchString } from '@/components/shared/ServerName';
import EntityLink from '@/components/EntityLink';
import Avatar from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/badge';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import FilteredEmptyState from '@/components/shared/FilteredEmptyState';
import { appliedFilterCount, clearedFilterValues } from '@/lib/filters';
import { listCertificates, revokeCertificate } from '@/services/certificateService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime } from '@/utils/time';
import { CERT_STATUS_LABELS } from '@/lib/labels';
import { can } from '@/lib/permissions';
import useAutoRefresh from '@/hooks/useAutoRefresh';
import useUrlFilters from '@/hooks/useUrlFilters';
import { envAccent } from '@/lib/mobileCard';
import { certificateStatusTone } from '@/lib/badgeTones';
import { CardStatus } from '@/components/mobile/MobileCard';


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
      <Badge tone="danger" className="ml-1">
        Expired
      </Badge>
    );
  }
  if (ms < ONE_DAY_MS) {
    return (
      <Badge tone="warning" className="ml-1">
        Expiring soon
      </Badge>
    );
  }
  return null;
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
    <Modal open={open} onClose={onClose} title="Certificate details" size="lg">
      <dl>
        <DetailRow label="Serial" value={cert.serial} />
        <DetailRow label="Status" value={<CertStatusBadge status={cert.status} />} />
        <DetailRow
          label="Issued to"
          value={cert.issuedTo ? <UserCell user={cert.issuedTo} /> : cert.userId}
        />
        <DetailRow
          label="Issued for"
          value={
            cert.issuedFor ? (
              <span className="flex items-center gap-2">
                <EntityLink
                  to={`/servers/${cert.issuedFor.id}`}
                  entityType="server"
                  entityName={cert.issuedFor.displayName || cert.issuedFor.hostname}
                >
                  <ServerName server={cert.issuedFor} />
                </EntityLink>
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
        <DetailRow label="Valid after" value={formatDateTime(cert.validAfter)} />
        <DetailRow label="Valid before" value={formatDateTime(cert.validBefore)} />
        <DetailRow label="Issued at" value={formatDateTime(cert.createdAt)} />
        {cert.revokedAt && (
          <DetailRow label="Revoked at" value={formatDateTime(cert.revokedAt)} />
        )}
        {cert.revokedAt && (
          <DetailRow
            label="Revoked by"
            value={cert.revokedBy ? <UserCell user={cert.revokedBy} /> : 'Unknown'}
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

const CERT_FILTER_DEFAULTS = {
  status: '',
  server: '',
  customer: '',
  user: '',
  environment: '',
  certType: '',
  startDate: '',
  endDate: '',
  q: '',
  sortBy: 'createdAt',
  sortDir: 'desc',
  page: '1',
};

function Certificates() {
  const { user } = useAuth();
  const canAdmin = can(user, 'certificates.revoke');

  const [f, setF] = useUrlFilters(CERT_FILTER_DEFAULTS);
  const page = parseInt(f.page, 10) || 1;

  const [certs, setCerts] = useState([]);
  const [total, setTotal] = useState(0);
  // Server-side, independent of the current page/filters (certificateService.list) —
  // was computed from `certs` (the current page only), so paging or filtering
  // silently changed the number.
  const [expiringSoonCount, setExpiringSoonCount] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [detailCert, setDetailCert] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);

  const loadedRef = useRef(false);
  const fetchCerts = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    setError('');
    try {
      const params = { page, limit: pageSize, sortBy: f.sortBy, sortDir: f.sortDir };
      if (f.status) params.status = f.status;
      if (f.server) params.serverId = f.server;
      if (f.customer) params.customerId = f.customer;
      if (f.user) params.userId = f.user;
      if (f.environment) params.environment = f.environment;
      if (f.certType) params.certType = f.certType;
      if (f.q) params.search = f.q;
      if (f.startDate) params.startDate = f.startDate;
      if (f.endDate) params.endDate = f.endDate;
      const resp = await listCertificates(params);
      const items = resp.data?.items || resp.data || [];
      const metaTotal = resp.meta?.total ?? resp.data?.total ?? items.length;
      setCerts(items);
      setTotal(metaTotal);
      setExpiringSoonCount(resp.data?.expiringSoonCount ?? 0);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load certificates');
    } finally {
      setLoading(false);
      loadedRef.current = true;
    }
  }, [page, pageSize, f.status, f.server, f.customer, f.user, f.environment, f.certType, f.q, f.sortBy, f.sortDir, f.startDate, f.endDate]);

  useEffect(() => { fetchCerts(); }, [fetchCerts]);

  const { refresh, refreshing, lastUpdated } = useAutoRefresh(fetchCerts);

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

  const filterDefs = [
    {
      key: 'status',
      label: 'Status',
      placeholder: 'All statuses',
      options: [
        { value: '', label: 'All statuses' },
        ...STATUSES.map((s) => ({ value: s, label: CERT_STATUS_LABELS[s] || s })),
      ],
    },
    { key: 'server', label: 'Server', type: 'entity', entity: 'servers', placeholder: 'All servers' },
    { key: 'customer', label: 'Customer', type: 'entity', entity: 'customers', placeholder: 'All customers' },
    { key: 'user', label: 'Issued to', type: 'entity', entity: 'users', placeholder: 'All users' },
    {
      key: 'certType',
      label: 'Type',
      placeholder: 'All types',
      options: [
        { value: '', label: 'All types' },
        { value: 'USER', label: 'User' },
        { value: 'HOST', label: 'Host' },
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
    { key: 'startDate', label: 'Valid until from', type: 'date' },
    { key: 'endDate', label: 'Valid until to', type: 'date' },
  ];
  const filterValues = {
    status: f.status,
    server: f.server,
    customer: f.customer,
    user: f.user,
    certType: f.certType,
    environment: f.environment,
    startDate: f.startDate,
    endDate: f.endDate,
  };
  const applyFilters = (next) => {
    setF({
      status: next.status ?? '',
      server: next.server ?? '',
      customer: next.customer ?? '',
      user: next.user ?? '',
      certType: next.certType ?? '',
      environment: next.environment ?? '',
      startDate: next.startDate ?? '',
      endDate: next.endDate ?? '',
      page: '1',
    });
  };

  const columns = [
    {
      key: 'serial',
      label: 'Serial',
      sortable: true,
      mobile: 'hidden',
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">
          {r.serial ? r.serial.slice(0, 16) + (r.serial.length > 16 ? '…' : '') : '-'}
        </span>
      ),
    },
    {
      key: 'issuedTo',
      label: 'Issued to',
      sortable: true,
      searchAccessor: (r) => `${r.issuedTo?.name || ''} ${r.issuedTo?.email || ''}`,
      mobile: { slot: 'secondary', order: 1, render: (r) => r.issuedTo?.name || r.issuedTo?.email || r.userId },
      render: (r) => <UserCell user={r.issuedTo} subtitle={r.issuedTo?.email || r.userId} />,
    },
    {
      key: 'server',
      label: 'Server',
      sortable: true,
      searchAccessor: (r) => (r.issuedFor ? serverSearchString(r.issuedFor) : ''),
      mobile: {
        slot: 'title',
        render: (r) => (
          <span className="min-w-0 break-all">
            {r.issuedFor?.displayName || r.issuedFor?.hostname || 'Any server'}
          </span>
        ),
      },
      render: (r) =>
        r.issuedFor ? (
          <span className="flex items-center gap-2">
            <EntityLink
              to={`/servers/${r.issuedFor.id}`}
              entityType="server"
              entityName={r.issuedFor.displayName || r.issuedFor.hostname}
            >
              <ServerName server={r.issuedFor} />
            </EntityLink>
            <EnvironmentBadge environment={r.issuedFor.environment} />
          </span>
        ) : (
          <span className="text-muted-foreground text-sm">-</span>
        ),
    },
    {
      key: 'principals',
      sortable: false,
      label: 'Principals',
      hideBelow: 'md',
      mobile: 'hidden',
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
      // certType is filterable (the Type filter def above) but wasn't
      // actually shown anywhere on the row.
      key: 'certType',
      sortable: false,
      label: 'Type',
      hideBelow: 'md',
      mobile: 'hidden',
      render: (r) => (
        <span className="text-xs text-muted-foreground">{r.certType || r.type || '-'}</span>
      ),
    },
    {
      key: 'validBefore',
      label: 'Valid until',
      sortable: true,
      mobile: { slot: 'meta', order: 2 },
      render: (r) => <ExpiryPill validBefore={r.validBefore} />,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      searchAccessor: (r) => r.status || '',
      // Phones: quiet status next to the "⋯" menu (DataTable `mobile.corner`).
      mobile: 'hidden',
      render: (r) => <CertStatusBadge status={r.status} />,
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        { label: 'View details', icon: Eye, onClick: (r) => setDetailCert(r) },
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
        helpKey="certificates"
        onRefresh={refresh}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
      />

      {expiringSoonCount > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {expiringSoonCount} certificate{expiringSoonCount === 1 ? '' : 's'} you can see expire{expiringSoonCount === 1 ? 's' : ''} within 24 hours — across every page and filter, not just this one.
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
        emptyState={
          appliedFilterCount(filterDefs, filterValues) > 0 ? (
            <FilteredEmptyState onClear={() => applyFilters(clearedFilterValues(filterDefs))} />
          ) : undefined
        }
        searchPlaceholder="Search by user, server, or serial..."
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
          onCardClick: (r) => setDetailCert(r),
          accent: (r) => envAccent(r.issuedFor?.environment),
          corner: (r) => <CardStatus {...certificateStatusTone(r.status)} />,
          leading: (r) => <Avatar name={r.issuedTo?.name} email={r.issuedTo?.email} avatarUrl={r.issuedTo?.avatarUrl} size="md" />,
        }}
        serverPagination={{
          page,
          total,
          onPageChange: (p) => setF({ page: String(p) }),
          pageSize,
          onPageSizeChange: (size) => { setPageSize(size); setF({ page: '1' }); },
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
        title="Revoke certificate"
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
