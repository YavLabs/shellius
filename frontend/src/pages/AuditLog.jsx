import { useState, useEffect, useCallback } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Download,
  Filter,
  X,
  ScrollText,
  Search,
} from 'lucide-react';
import Badge from '@/components/shared/Badge';
import DataTable from '@/components/shared/DataTable';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { listAudit, exportAudit } from '@/services/auditService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime, formatDateTime } from '@/utils/time';

// ---------------------------------------------------------------------------
// Action category configuration
// ---------------------------------------------------------------------------

const ACTION_CATEGORIES = {
  auth: {
    label: 'Auth',
    actions: ['auth.login', 'auth.logout', 'auth.sso', 'auth.device_approve'],
    badgeClass: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  },
  user: {
    label: 'User',
    actions: ['user.create', 'user.update', 'user.delete'],
    badgeClass: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
  },
  group: {
    label: 'Group',
    actions: ['group.create', 'group.update', 'group.delete'],
    badgeClass: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
  },
  server: {
    label: 'Server',
    actions: ['server.create', 'server.update', 'server.delete', 'server.health_check'],
    badgeClass: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20',
  },
  customer: {
    label: 'Customer',
    actions: ['customer.create', 'customer.update', 'customer.delete'],
    badgeClass: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20',
  },
  policy: {
    label: 'Policy',
    actions: ['policy.create', 'policy.update', 'policy.delete'],
    badgeClass: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  },
  access_request: {
    label: 'Access Request',
    actions: [
      'access_request.submit',
      'access_request.approve',
      'access_request.deny',
      'access_request.expire',
      'access_request.revoke',
    ],
    badgeClass: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  },
  cert: {
    label: 'Certificate',
    actions: ['cert.issue', 'cert.revoke'],
    badgeClass: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
  },
  ca: {
    label: 'CA',
    actions: ['ca.generate', 'ca.rotate'],
    badgeClass: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
  },
  session: {
    label: 'Session',
    actions: ['session.start', 'session.end', 'session.terminate'],
    badgeClass: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
  },
  org: {
    label: 'Org',
    actions: ['org.update'],
    badgeClass: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20',
  },
  connector: {
    label: 'Connector',
    actions: ['connector.create', 'connector.sync'],
    badgeClass: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20',
  },
};

const ACTION_BADGE_MAP = {};
for (const cat of Object.values(ACTION_CATEGORIES)) {
  for (const action of cat.actions) {
    ACTION_BADGE_MAP[action] = cat.badgeClass;
  }
}

function ActionBadge({ action }) {
  const badgeClass = ACTION_BADGE_MAP[action] || 'bg-muted text-foreground border-border';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badgeClass}`}>
      {action}
    </span>
  );
}

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

const RESOURCE_TYPES = [
  'User', 'Group', 'Customer', 'Server', 'Certificate', 'CaKeyPair',
  'Policy', 'AccessRequest', 'Session', 'CloudConnector', 'Organization',
];

function MetadataPanel({ metadata }) {
  if (!metadata) {
    return <span className="text-xs text-muted-foreground italic">No metadata</span>;
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 text-xs text-foreground font-mono">
      {JSON.stringify(metadata, null, 2)}
    </pre>
  );
}

const PAGE_SIZE = 25;
const selectCls = 'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function AuditLog() {
  const { user } = useAuth();
  const canExport = isAtLeast(user, 'super_admin');

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [resourceTypeFilter, setResourceTypeFilter] = useState('');
  const [actorSearch, setActorSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [expandedRow, setExpandedRow] = useState(null);
  const [exporting, setExporting] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: PAGE_SIZE };
      if (search) params.search = search;
      if (actionFilter) params.action = actionFilter;
      if (resourceTypeFilter) params.resourceType = resourceTypeFilter;
      if (actorSearch) params.actorId = actorSearch;
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;

      const resp = await listAudit(params);
      setItems(resp.data?.items || []);
      setTotal(resp.meta?.total ?? 0);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load audit log.');
    } finally {
      setLoading(false);
    }
  }, [page, search, actionFilter, resourceTypeFilter, actorSearch, startDate, endDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleFilterChange = (setter) => (value) => {
    setter(value);
    setPage(1);
    setExpandedRow(null);
  };

  const handleExport = async (format) => {
    setExporting(true);
    try {
      const params = {};
      if (actionFilter) params.action = actionFilter;
      if (resourceTypeFilter) params.resourceType = resourceTypeFilter;
      if (actorSearch) params.actorId = actorSearch;
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      await exportAudit(format, params);
    } catch (err) {
      setError(err.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  const clearFilters = () => {
    setSearch('');
    setActionFilter('');
    setResourceTypeFilter('');
    setActorSearch('');
    setStartDate('');
    setEndDate('');
    setPage(1);
    setExpandedRow(null);
  };

  const hasFilters = search || actionFilter || resourceTypeFilter || actorSearch || startDate || endDate;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // AuditLog uses a bespoke table to support expand-row metadata viewer.
  // The DataTable v2 `filters` slot is used for the filter bar, and we wire
  // `serverPagination` for the standard pagination footer. The table body
  // is rendered manually to support the expand/collapse row pattern.

  const columns = [
    {
      key: 'createdAt',
      label: 'Timestamp',
      sortable: false,
      render: (item) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap" title={formatDateTime(item.createdAt)}>
          {relativeTime(item.createdAt)}
        </span>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      render: (item) => <ActionBadge action={item.action} />,
    },
    {
      key: 'actorId',
      label: 'Actor',
      render: (item) => (
        <span className="font-mono text-xs text-muted-foreground">
          {item.actorId ? item.actorId.slice(0, 8) + '...' : <span className="italic">system</span>}
        </span>
      ),
    },
    {
      key: 'resource',
      label: 'Resource',
      render: (item) => (
        <span className="text-xs text-foreground">
          {item.resourceType}
          {item.resourceId && (
            <span className="ml-1 font-mono text-muted-foreground">
              :{item.resourceId.slice(0, 8)}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'ipAddress',
      label: 'IP',
      render: (item) => (
        <span className="font-mono text-xs text-muted-foreground">{item.ipAddress || '-'}</span>
      ),
    },
    {
      key: '_expand',
      label: '',
      className: 'w-8',
      render: (item) => {
        const isExpanded = expandedRow === item.id;
        return isExpanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        );
      },
    },
  ];

  // Build the filter JSX for the DataTable filters slot
  const filterSlot = (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4 w-full">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Filter className="h-3.5 w-3.5" />
        Filters
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="ml-auto h-6 px-2 text-xs text-muted-foreground"
          >
            <X className="mr-1 h-3 w-3" />
            Clear
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {/* Free-text search */}
        <div className="min-w-48 flex-1">
          <label className="mb-1 block text-xs text-muted-foreground">Search</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => handleFilterChange(setSearch)(e.target.value)}
              placeholder="Search actions, resources..."
              className="pl-9"
            />
          </div>
        </div>

        {/* Actor search */}
        <div className="min-w-36">
          <label className="mb-1 block text-xs text-muted-foreground">Actor ID</label>
          <Input
            type="text"
            value={actorSearch}
            onChange={(e) => handleFilterChange(setActorSearch)(e.target.value)}
            placeholder="User ID..."
          />
        </div>

        {/* Action filter — native select for optgroup support */}
        <div className="min-w-44">
          <label className="mb-1 block text-xs text-muted-foreground">Action</label>
          <select
            value={actionFilter}
            onChange={(e) => handleFilterChange(setActionFilter)(e.target.value)}
            className={selectCls}
          >
            <option value="">All actions</option>
            {Object.entries(ACTION_CATEGORIES).map(([catKey, cat]) => (
              <optgroup key={catKey} label={cat.label}>
                {cat.actions.map((action) => (
                  <option key={action} value={action}>{action}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Resource type filter */}
        <div className="min-w-36">
          <label className="mb-1 block text-xs text-muted-foreground">Resource Type</label>
          <Select
            value={resourceTypeFilter || '_all'}
            onValueChange={(v) => handleFilterChange(setResourceTypeFilter)(v === '_all' ? '' : v)}
          >
            <SelectTrigger className="w-full"><SelectValue placeholder="All types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_all">All types</SelectItem>
              {RESOURCE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Date range */}
        <div className="min-w-36">
          <label className="mb-1 block text-xs text-muted-foreground">From</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => handleFilterChange(setStartDate)(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="min-w-36">
          <label className="mb-1 block text-xs text-muted-foreground">To</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => handleFilterChange(setEndDate)(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={ScrollText} title="Audit Log" subtitle="Immutable record of all system events.">
        {canExport && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={exporting}>
                <Download className="mr-2 h-4 w-4" />
                {exporting ? 'Exporting...' : 'Export'}
                <ChevronDown className="ml-2 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => handleExport('csv')}>Export as CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('json')}>Export as JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </PageHeader>

      {/* Filter panel (not inside DataTable — rendered as a standalone block) */}
      {filterSlot}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Bespoke table with expand-row support */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                  Timestamp
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Action
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Actor
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Resource
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  IP
                </th>
                <th className="w-8 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 7 }).map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    {[1, 2, 3, 4, 5, 6].map((j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No audit log entries found.
                  </td>
                </tr>
              ) : (
                items.map((item) => {
                  const isExpanded = expandedRow === item.id;
                  return (
                    <>
                      <tr
                        key={item.id}
                        onClick={() => setExpandedRow(isExpanded ? null : item.id)}
                        className="border-b border-border cursor-pointer transition-colors hover:bg-accent/30 last:border-0"
                      >
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="text-xs text-muted-foreground" title={formatDateTime(item.createdAt)}>
                            {relativeTime(item.createdAt)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <ActionBadge action={item.action} />
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs text-muted-foreground">
                            {item.actorId
                              ? item.actorId.slice(0, 8) + '...'
                              : <span className="italic">system</span>}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs text-foreground">
                            {item.resourceType}
                            {item.resourceId && (
                              <span className="ml-1 font-mono text-muted-foreground">
                                :{item.resourceId.slice(0, 8)}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs text-muted-foreground">
                            {item.ipAddress || '-'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {isExpanded ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr key={`${item.id}-expanded`} className="border-b border-border bg-muted/20">
                          <td colSpan={6} className="px-6 py-4">
                            <div className="space-y-1">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Full timestamp
                              </p>
                              <p className="text-xs text-foreground font-mono mb-3">
                                {formatDateTime(item.createdAt)}
                              </p>
                              {item.actorId && (
                                <>
                                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    Actor ID
                                  </p>
                                  <p className="text-xs text-foreground font-mono mb-3">{item.actorId}</p>
                                </>
                              )}
                              {item.resourceId && (
                                <>
                                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    Resource ID
                                  </p>
                                  <p className="text-xs text-foreground font-mono mb-3">{item.resourceId}</p>
                                </>
                              )}
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Metadata
                              </p>
                              <MetadataPanel metadata={item.metadata} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Standard pagination footer via DataTable v2 — rendered as a small helper component */}
      <AuditPagination
        page={page}
        total={total}
        pageSize={PAGE_SIZE}
        totalPages={totalPages}
        onPageChange={setPage}
      />
    </div>
  );
}

// Minimal pagination footer matching DataTable v2 style
function AuditPagination({ page, total, pageSize, totalPages, onPageChange }) {
  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
      <span className="whitespace-nowrap tabular-nums">
        Showing {startRow}–{endRow} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export default AuditLog;
