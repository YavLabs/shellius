import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Download,
  Filter as FilterIcon,
  X,
  ScrollText,
  Search,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { auditCategoryTone } from '@/lib/badgeTones';
import UserCell from '@/components/shared/UserCell';
import EntityLink from '@/components/EntityLink';
import EntityPicker from '@/components/shared/EntityPicker';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { listAudit, exportAudit, getAuditFacets } from '@/services/auditService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime, formatDateTime } from '@/utils/time';
import { formatLabel } from '@/utils/format';
import { can } from '@/lib/permissions';
import useIsMobile from '@/hooks/useIsMobile';
import FilterControl from '@/components/shared/FilterControl';
import useMobilePages from '@/hooks/useMobilePages';
import useAutoRefresh from '@/hooks/useAutoRefresh';
import useUrlFilters from '@/hooks/useUrlFilters';
import { MobileCard, MobileCardList, MobileCardSkeleton, MobileEmptyCard } from '@/components/mobile/MobileCard';
import { MobileFiltersButton, MobileLoadMore, MobileSearch } from '@/components/mobile/MobileListControls';
import Avatar from '@/components/ui/Avatar';

// ---------------------------------------------------------------------------
// Action category (for the badge's color only) — the action's own prefix
// before the first '.', e.g. 'access_request.submit' → 'access_request'.
// This used to be a second, hand-maintained list of every action; it drifted
// (missing ~13 real resource types, a stale 'Policy' where the backend
// writes 'AccessPolicy') and doubled as the Action filter's option list. The
// filter options now come from the backend's own facets (see below); an
// unrecognised prefix here just falls back to a neutral badge tone.
// ---------------------------------------------------------------------------

function ActionBadge({ action }) {
  const category = (action || '').split('.')[0];
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

const AUDIT_FILTER_DEFAULTS = {
  q: '',
  action: '',
  resourceType: '',
  actorId: '',
  ip: '',
  resourceId: '',
  startDate: '',
  endDate: '',
  page: '1',
};

function AuditLog() {
  const { user } = useAuth();
  const canExport = can(user, 'audit.export');
  const isMobile = useIsMobile();

  const [f, setF] = useUrlFilters(AUDIT_FILTER_DEFAULTS);
  const page = parseInt(f.page, 10) || 1;

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Distinct action / resourceType values actually present for the org
  // (routes/audit.js GET /facets) — the pickers below offer exactly what the
  // backend can write, never a hard-coded list that drifts from it.
  const [actions, setActions] = useState([]);
  const [resourceTypes, setResourceTypes] = useState([]);
  useEffect(() => {
    getAuditFacets()
      .then((d) => {
        setActions(d.actions || []);
        setResourceTypes(d.resourceTypes || []);
      })
      .catch(() => {});
  }, []);

  const [expandedRow, setExpandedRow] = useState(null);
  const [exporting, setExporting] = useState(false);

  // Debounced search — the search box used to fire one request per
  // keystroke. DataTable's own search box debounces at 200ms; this page
  // keeps a bespoke table (for the expand-row metadata viewer) so it isn't
  // wired through DataTable, but the same debounce applies here directly.
  const [searchRaw, setSearchRaw] = useState(f.q);
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchRaw !== f.q) setF({ q: searchRaw, page: '1' });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchRaw]);
  // Keep the box in sync when the URL changes from elsewhere (Clear, back/forward).
  useEffect(() => { setSearchRaw(f.q); }, [f.q]);

  const loadedRef = useRef(false);
  const fetchData = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    setError('');
    try {
      const params = { page, limit: pageSize };
      if (f.q) params.search = f.q;
      if (f.action) params.action = f.action;
      if (f.resourceType) params.resourceType = f.resourceType;
      if (f.actorId) params.actorId = f.actorId;
      if (f.ip) params.ip = f.ip;
      if (f.resourceId) params.resourceId = f.resourceId;
      if (f.startDate) params.startDate = f.startDate;
      if (f.endDate) params.endDate = f.endDate;

      const resp = await listAudit(params);
      setItems(resp.data?.items || []);
      setTotal(resp.meta?.total ?? 0);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load audit log.');
    } finally {
      setLoading(false);
      loadedRef.current = true;
    }
  }, [page, pageSize, f.q, f.action, f.resourceType, f.actorId, f.ip, f.resourceId, f.startDate, f.endDate]);

  useEffect(() => { fetchData(); }, [fetchData]);
  const { refresh, refreshing, lastUpdated } = useAutoRefresh(fetchData);

  const handleExport = async (format) => {
    setExporting(true);
    try {
      const params = {};
      if (f.q) params.search = f.q;
      if (f.action) params.action = f.action;
      if (f.resourceType) params.resourceType = f.resourceType;
      if (f.actorId) params.actorId = f.actorId;
      if (f.ip) params.ip = f.ip;
      if (f.resourceId) params.resourceId = f.resourceId;
      if (f.startDate) params.startDate = f.startDate;
      if (f.endDate) params.endDate = f.endDate;
      await exportAudit(format, params);
    } catch (err) {
      setError(err.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  const clearFilters = () => {
    setSearchRaw('');
    setF({
      q: '', action: '', resourceType: '', actorId: '', ip: '', resourceId: '', startDate: '', endDate: '', page: '1',
    });
    setExpandedRow(null);
  };

  // Row-level "filter to this resource" — jump straight to every other
  // event on the same resource without hand-typing its id.
  const filterToResource = (item) => {
    if (!item.resourceId) return;
    setF({ resourceId: item.resourceId, resourceType: item.resourceType || '', page: '1' });
    setExpandedRow(null);
  };

  const hasFilters = f.q || f.action || f.resourceType || f.actorId || f.ip || f.resourceId || f.startDate || f.endDate;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // AuditLog uses a bespoke table to support expand-row metadata viewer.
  // The DataTable v2 `filters` slot is used for the filter bar, and we wire
  // `serverPagination` for the standard pagination footer. The table body
  // is rendered manually to support the expand/collapse row pattern.

  // Action options sorted alphabetically so same-prefix actions cluster
  // together (e.g. every access_request.* action sits next to the others) —
  // a lightweight stand-in for real grouping; the drawer's select is already
  // searchable, so typing "access" narrows straight to the cluster.
  const actionOptions = [...actions].sort().map((a) => ({ value: a, label: formatLabel(a) }));
  const resourceTypeOptions = [...resourceTypes].sort().map((t) => ({ value: t, label: t }));

  // Mobile: the non-search filters, stacked in the Filters sheet.
  const mobileFilterCount = [f.action, f.resourceType, f.actorId, f.ip, f.resourceId, f.startDate, f.endDate].filter(Boolean).length;
  const dateInputCls =
    'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring';
  const mobileFilters = (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Action</label>
        <SearchableSelect
          value={f.action}
          onChange={(v) => setF({ action: v, page: '1' })}
          placeholder="All actions"
          searchable
          clearable={false}
          options={[{ value: '', label: 'All actions' }, ...actionOptions]}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Resource type</label>
        <SearchableSelect
          value={f.resourceType}
          onChange={(v) => setF({ resourceType: v, page: '1' })}
          placeholder="All types"
          searchable
          clearable={false}
          options={[{ value: '', label: 'All types' }, ...resourceTypeOptions]}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Actor</label>
        <EntityPicker kind="users" value={f.actorId} onChange={(v) => setF({ actorId: v, page: '1' })} anyLabel="Any actor" />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">IP address</label>
        <Input
          type="text"
          value={f.ip}
          onChange={(e) => setF({ ip: e.target.value, page: '1' })}
          placeholder="Contains…"
          className="h-11 text-base"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Resource ID</label>
        <Input
          type="text"
          value={f.resourceId}
          onChange={(e) => setF({ resourceId: e.target.value, page: '1' })}
          placeholder="Exact resource id…"
          className="h-11 text-base"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <label className="mb-1 block text-xs text-muted-foreground">From</label>
          <input type="date" value={f.startDate} onChange={(e) => setF({ startDate: e.target.value, page: '1' })} className={dateInputCls} />
        </div>
        <div className="min-w-0">
          <label className="mb-1 block text-xs text-muted-foreground">To</label>
          <input type="date" value={f.endDate} onChange={(e) => setF({ endDate: e.target.value, page: '1' })} className={dateInputCls} />
        </div>
      </div>
    </>
  );

  // Phones scroll: every page loaded so far, next one on scroll.
  const mobileItems = useMobilePages({ rows: items, page, loading, enabled: isMobile });

  const mobileList = (
    <div className="space-y-3">
      <MobileSearch
        value={searchRaw}
        onChange={setSearchRaw}
        placeholder="Search actions, actors, resources, IPs..."
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
            const actorName = item.actorId ? item.actorName || item.actorEmail || item.actorId : 'System';
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
                    {item.actorId ? (
                      <EntityLink to={`/admin/users?highlight=${item.actorId}`} entityType="user" entityName={actorName} icon={false}>
                        {actorName}
                      </EntityLink>
                    ) : (
                      actorName
                    )}{' '}
                    · <span title={formatDateTime(item.createdAt)}>{relativeTime(item.createdAt)}</span>
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
                        <div className="mb-1 flex items-center justify-between">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Resource ID</p>
                          <button
                            type="button"
                            onClick={() => filterToResource(item)}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <FilterIcon className="h-3 w-3" /> Filter to this
                          </button>
                        </div>
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
          onMore={() => setF({ page: String(page + 1) })}
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
    { key: 'actorId', label: 'Actor', type: 'entity', entity: 'users', placeholder: 'Any actor' },
    {
      key: 'action',
      label: 'Action',
      placeholder: 'All actions',
      searchable: true,
      options: [{ value: '', label: 'All actions' }, ...actionOptions],
    },
    {
      key: 'resourceType',
      label: 'Resource type',
      placeholder: 'All types',
      searchable: true,
      options: [{ value: '', label: 'All types' }, ...resourceTypeOptions],
    },
    { key: 'ip', label: 'IP address', type: 'text', placeholder: 'Contains…' },
    { key: 'resourceId', label: 'Resource ID', type: 'text', placeholder: 'Exact resource id…' },
    { key: 'startDate', label: 'From', type: 'date' },
    { key: 'endDate', label: 'To', type: 'date' },
  ];

  const filterValues = {
    actorId: f.actorId,
    action: f.action,
    resourceType: f.resourceType,
    ip: f.ip,
    resourceId: f.resourceId,
    startDate: f.startDate,
    endDate: f.endDate,
  };

  const applyFilters = (next) => {
    setF({
      actorId: next.actorId ?? '',
      action: next.action ?? '',
      resourceType: next.resourceType ?? '',
      ip: next.ip ?? '',
      resourceId: next.resourceId ?? '',
      startDate: next.startDate ?? '',
      endDate: next.endDate ?? '',
      page: '1',
    });
  };

  const desktopToolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchRaw}
          onChange={(e) => setSearchRaw(e.target.value)}
          placeholder="Search actions, actors, resources, IPs..."
          aria-label="Search actions, actors, resources, IPs"
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
        onRefresh={refresh}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
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
                          <span className="flex items-center gap-1.5 text-xs text-foreground">
                            <ResourceRef item={item} />
                            {item.resourceId && (
                              <button
                                type="button"
                                title="Filter to this resource"
                                onClick={(e) => { e.stopPropagation(); filterToResource(item); }}
                                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              >
                                <FilterIcon className="h-3 w-3" />
                              </button>
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
        onPageChange={(p) => setF({ page: String(p) })}
        onPageSizeChange={(size) => { setPageSize(size); setF({ page: '1' }); }}
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
