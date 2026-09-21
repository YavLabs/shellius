import { Fragment, useState, useEffect, useCallback } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Download,
  Filter,
  X,
  ScrollText,
  Search,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { auditCategoryTone } from '@/lib/badgeTones';
import UserCell from '@/components/shared/UserCell';
import EntityLink from '@/components/EntityLink';
import DataTable from '@/components/shared/DataTable';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { listAudit, exportAudit } from '@/services/auditService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime, formatDateTime } from '@/utils/time';
import { formatLabel } from '@/utils/format';
import { can } from '@/lib/permissions';
import useIsMobile from '@/hooks/useIsMobile';
import FilterControl from '@/components/shared/FilterControl';
import useMobilePages from '@/hooks/useMobilePages';
import { MobileCard, MobileCardList, MobileCardSkeleton, MobileEmptyCard } from '@/components/mobile/MobileCard';
import { MobileFiltersButton, MobileLoadMore, MobileSearch } from '@/components/mobile/MobileListControls';
import Avatar from '@/components/ui/Avatar';

// ---------------------------------------------------------------------------
// Action category configuration
// ---------------------------------------------------------------------------

const ACTION_CATEGORIES = {
  auth: {
    label: 'Auth',
    actions: ['auth.login', 'auth.logout', 'auth.sso', 'auth.device_approve'],
  },
  user: {
    label: 'User',
    actions: ['user.create', 'user.update', 'user.delete'],
  },
  group: {
    label: 'Group',
    actions: ['group.create', 'group.update', 'group.delete'],
  },
  server: {
    label: 'Server',
    actions: ['server.create', 'server.update', 'server.delete', 'server.health_check'],
  },
  customer: {
    label: 'Customer',
    actions: ['customer.create', 'customer.update', 'customer.delete'],
  },
  policy: {
    label: 'Policy',
    actions: ['policy.create', 'policy.update', 'policy.delete'],
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
  },
  cert: {
    label: 'Certificate',
    actions: ['cert.issue', 'cert.revoke'],
  },
  ca: {
    label: 'CA',
    actions: ['ca.generate', 'ca.rotate'],
  },
  session: {
    label: 'Session',
    actions: ['session.start', 'session.end', 'session.terminate'],
  },
  org: {
    label: 'Org',
    actions: ['org.update'],
  },
  connector: {
    label: 'Connector',
    actions: ['connector.create', 'connector.sync'],
  },
};

const ACTION_CATEGORY_MAP = {};
for (const [key, cat] of Object.entries(ACTION_CATEGORIES)) {
  for (const action of cat.actions) {
    ACTION_CATEGORY_MAP[action] = key;
  }
}

function ActionBadge({ action }) {
  const category = ACTION_CATEGORY_MAP[action];
  return <Badge tone={auditCategoryTone(category)}>{action}</Badge>;
}

/**
 * ResourceRef — the audit log's "Resource" cell. auditService.list() already
 * computes `resourceLabel` (server display name, customer name, etc.) and
 * `resourceLink` (a route that actually exists for that resource type, or
 * null when there's only a list page to fall back to / nothing to link).
 * EntityLink itself degrades to plain text when the viewer can't open it.
 */
function ResourceRef({ item }) {
  const label = item.resourceLabel || item.resourceType;
  if (!label) return <span className="text-muted-foreground">-</span>;
  if (!item.resourceLink) return <span>{label}</span>;
  return (
    <EntityLink to={item.resourceLink} entityType={item.resourceType?.toLowerCase()} entityName={label}>
      {label}
    </EntityLink>
  );
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

function AuditLog() {
  const { user } = useAuth();
  const canExport = can(user, 'audit.export');
  const isMobile = useIsMobile();

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
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
      const params = { page, limit: pageSize };
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
  }, [page, pageSize, search, actionFilter, resourceTypeFilter, actorSearch, startDate, endDate]);

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
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

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
      key: 'actor',
      label: 'Actor',
      render: (item) => (
        <UserCell
          user={item.actorId ? { name: item.actorName, email: item.actorEmail, avatarUrl: item.actorAvatarUrl } : null}
          fallback="System"
        />
      ),
    },
    {
      key: 'resource',
      label: 'Resource',
      render: (item) => (
        <span className="text-xs text-foreground">
          {item.resourceLabel || item.resourceType || '-'}
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

  // Mobile: the non-search filters, stacked in the Filters sheet.
  const mobileFilterCount = [actionFilter, resourceTypeFilter, actorSearch, startDate, endDate].filter(Boolean).length;
  const dateInputCls =
    'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring';
  const mobileFilters = (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Action</label>
        <SearchableSelect
          value={actionFilter}
          onChange={(v) => handleFilterChange(setActionFilter)(v)}
          searchable={false}
          clearable={false}
          options={[
            { value: '', label: 'All actions' },
            ...Object.entries(ACTION_CATEGORIES).flatMap(([, cat]) =>
              cat.actions.map((action) => ({ value: action, label: formatLabel(action) }))
            ),
          ]}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Resource type</label>
        <SearchableSelect
          value={resourceTypeFilter}
          onChange={(v) => handleFilterChange(setResourceTypeFilter)(v)}
          placeholder="All types"
          searchable={false}
          clearable={false}
          options={[{ value: '', label: 'All types' }, ...RESOURCE_TYPES.map((t) => ({ value: t, label: t }))]}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Actor ID</label>
        <Input
          type="text"
          value={actorSearch}
          onChange={(e) => handleFilterChange(setActorSearch)(e.target.value)}
          placeholder="User ID..."
          className="h-11 text-base"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <label className="mb-1 block text-xs text-muted-foreground">From</label>
          <input type="date" value={startDate} onChange={(e) => handleFilterChange(setStartDate)(e.target.value)} className={dateInputCls} />
        </div>
        <div className="min-w-0">
          <label className="mb-1 block text-xs text-muted-foreground">To</label>
          <input type="date" value={endDate} onChange={(e) => handleFilterChange(setEndDate)(e.target.value)} className={dateInputCls} />
        </div>
      </div>
    </>
  );

  // Phones scroll: every page loaded so far, next one on scroll.
  const mobileItems = useMobilePages({ rows: items, page, loading, enabled: isMobile });

  const mobileList = (
    <div className="space-y-3">
      <MobileSearch
        value={search}
        onChange={(v) => handleFilterChange(setSearch)(v)}
        placeholder="Search actions, resources..."
      />
      <div className="flex items-center gap-2">
        <MobileFiltersButton filters={mobileFilters} activeCount={mobileFilterCount} onReset={clearFilters} />
        {hasFilters && (
          <Button variant="ghost" className="h-10 px-3 text-muted-foreground" onClick={clearFilters}>
            <X className="mr-1 h-4 w-4" /> Clear
          </Button>
        )}
      </div>
      {loading && (page <= 1 || mobileItems.length === 0) ? (
        <MobileCardSkeleton count={6} withLeading />
      ) : mobileItems.length === 0 ? (
        <MobileEmptyCard>No audit log entries found.</MobileEmptyCard>
      ) : (
        <MobileCardList>
          {mobileItems.map((item) => {
            const isExpanded = expandedRow === item.id;
            const actor = item.actorId ? item.actorName || item.actorEmail || item.actorId : 'System';
            return (
              <MobileCard
                key={item.id}
                leading={<Avatar name={item.actorId ? item.actorName : 'System'} email={item.actorEmail} avatarUrl={item.actorAvatarUrl} size="md" />}
                title={
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <ActionBadge action={item.action} />
                    <span className="min-w-0 break-all text-sm">
                      <ResourceRef item={item} />
                    </span>
                  </span>
                }
                secondary={
                  <span>
                    {actor} · <span title={formatDateTime(item.createdAt)}>{relativeTime(item.createdAt)}</span>
                  </span>
                }
                meta={[
                  item.ipAddress ? (
                    <span key="ip" className="font-mono text-xs text-muted-foreground">{item.ipAddress}</span>
                  ) : null,
                  <span key="more" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    {isExpanded ? 'Hide details' : 'Details'}
                  </span>,
                ]}
                onClick={() => setExpandedRow(isExpanded ? null : item.id)}
              >
                {isExpanded && (
                  <div className="mt-3 space-y-1 border-t border-border pt-3" onClick={(e) => e.stopPropagation()}>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Full timestamp</p>
                    <p className="mb-3 font-mono text-xs text-foreground">{formatDateTime(item.createdAt)}</p>
                    {item.actorId && (
                      <>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Actor ID</p>
                        <p className="mb-3 break-all font-mono text-xs text-foreground">{item.actorId}</p>
                      </>
                    )}
                    {item.resourceId && (
                      <>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Resource ID</p>
                        <p className="mb-3 break-all font-mono text-xs text-foreground">{item.resourceId}</p>
                      </>
                    )}
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Metadata</p>
                    <MetadataPanel metadata={item.metadata} />
                  </div>
                )}
              </MobileCard>
            );
          })}
        </MobileCardList>
      )}
      {mobileItems.length > 0 && (
        <MobileLoadMore
          shown={mobileItems.length}
          total={total}
          hasMore={page < totalPages}
          loading={loading}
          onMore={() => setPage(page + 1)}
        />
      )}
    </div>
  );

  // Build the filter JSX for the DataTable filters slot
  // The audit log's filters were a bordered card above the table holding a
  // search box, two text inputs, two selects and two date fields — the
  // widest, tallest piece of chrome in the app, permanently occupying the
  // space where the log should be. Search stays on the toolbar; the rest
  // moved into the shared drawer.
  const filterDefs = [
    { key: 'actorSearch', label: 'Actor ID', type: 'text', placeholder: 'User ID…' },
    {
      key: 'action',
      label: 'Action',
      placeholder: 'All actions',
      searchable: true,
      options: [
        { value: '', label: 'All actions' },
        ...Object.entries(ACTION_CATEGORIES).flatMap(([, cat]) =>
          cat.actions.map((action) => ({ value: action, label: formatLabel(action) }))
        ),
      ],
    },
    {
      key: 'resourceType',
      label: 'Resource type',
      placeholder: 'All types',
      searchable: true,
      options: [{ value: '', label: 'All types' }, ...RESOURCE_TYPES.map((t) => ({ value: t, label: t }))],
    },
    { key: 'startDate', label: 'From', type: 'date' },
    { key: 'endDate', label: 'To', type: 'date' },
  ];

  const filterValues = {
    actorSearch,
    action: actionFilter,
    resourceType: resourceTypeFilter,
    startDate,
    endDate,
  };

  const applyFilters = (next) => {
    setActorSearch(next.actorSearch ?? '');
    setActionFilter(next.action ?? '');
    setResourceTypeFilter(next.resourceType ?? '');
    setStartDate(next.startDate ?? '');
    setEndDate(next.endDate ?? '');
    setPage(1);
  };

  const desktopToolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => handleFilterChange(setSearch)(e.target.value)}
          placeholder="Search actions, resources..."
          aria-label="Search actions, resources"
          className="h-9 pl-9"
          type="search"
        />
      </div>
      <FilterControl defs={filterDefs} values={filterValues} onChange={applyFilters} />
    </div>
  );

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={ScrollText}
        title="Audit Log"
        subtitle="Immutable record of all system events."
        helpKey="audit-log"
        actions={[
          {
            key: 'export',
            label: exporting ? 'Exporting...' : 'Export',
            icon: Download,
            variant: 'outline',
            disabled: exporting,
            hidden: !canExport,
            items: [
              { key: 'csv', label: 'Export as CSV', icon: Download, onClick: () => handleExport('csv') },
              { key: 'json', label: 'Export as JSON', icon: Download, onClick: () => handleExport('json') },
            ],
          },
        ]}
      />

      {/* Filter panel (not inside DataTable — rendered as a standalone block) */}
      {!isMobile && desktopToolbar}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {isMobile && mobileList}

      {/* Bespoke table with expand-row support */}
      {!isMobile && (<>
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
                    <Fragment key={item.id}>
                      <tr
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
                          <UserCell
                            user={
                              item.actorId
                                ? { id: item.actorId, name: item.actorName, email: item.actorEmail, avatarUrl: item.actorAvatarUrl }
                                : null
                            }
                            fallback="System"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs text-foreground">
                            <ResourceRef item={item} />
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
                    </Fragment>
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
        pageSize={pageSize}
        totalPages={totalPages}
        onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
      />
      </>)}
    </div>
  );
}

// Minimal pagination footer matching DataTable v2 style
function AuditPagination({ page, total, pageSize, totalPages, onPageChange, onPageSizeChange }) {
  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
      <span className="whitespace-nowrap tabular-nums">
        Showing {startRow}–{endRow} of {total}
      </span>
      <div className="flex items-center gap-3">
        {onPageSizeChange && (
          <div className="flex items-center gap-1.5 text-xs">
            <span>Rows</span>
            <SearchableSelect
              className="h-8 w-[72px]"
              value={String(pageSize)}
              onChange={(v) => onPageSizeChange(Number(v))}
              searchable={false}
              clearable={false}
              options={[10, 25, 50, 100].map((n) => ({ value: String(n), label: String(n) }))}
            />
          </div>
        )}
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
