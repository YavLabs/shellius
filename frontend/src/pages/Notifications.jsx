import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import PageHeader from '@/components/common/PageHeader';
import FilteredEmptyState from '@/components/shared/FilteredEmptyState';
import { appliedFilterCount, clearedFilterValues } from '@/lib/filters';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/services/notificationService';
import { relativeTime } from '@/utils/time';
import { RELATED_ROUTE } from '@/lib/notificationRoutes';
import { NOTIFICATION_META, notificationMeta } from '@/lib/notificationMeta';
import { cn } from '@/lib/utils';
import useAutoRefresh from '@/hooks/useAutoRefresh';
import useUrlFilters from '@/hooks/useUrlFilters';


/** The type's icon, dimmed once read — the same cue the dropdown uses. */
function NotificationIcon({ n }) {
  const { Icon, color, label } = notificationMeta(n.type);
  return (
    <span
      className={cn(
        'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60',
        n.isRead && 'opacity-60'
      )}
      title={label}
    >
      <Icon className={cn('h-4 w-4', color)} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Notifications() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [f, setF] = useUrlFilters({
    readState: '',
    type: '',
    createdFrom: '',
    createdTo: '',
    page: '1',
    pageSize: '20',
  });
  const page = parseInt(f.page, 10) || 1;
  const pageSize = parseInt(f.pageSize, 10) || 20;
  // `filter` stays 'all'|'unread' — the vocabulary the fetch/empty-state code
  // already used; only the URL key (`readState`, matching the drawer) differs.
  const filter = f.readState === 'unread' ? 'unread' : 'all';

  const loadedRef = useRef(false);
  const fetch = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    setError('');
    try {
      // Only the latest 100 used to load with no pager — a busy org's
      // history past that was simply gone. Now server-paginated, like every
      // other list.
      const params = { page, limit: pageSize };
      if (filter === 'unread') params.isRead = 'false';
      if (f.type) params.type = f.type;
      if (f.createdFrom) params.createdFrom = f.createdFrom;
      if (f.createdTo) params.createdTo = f.createdTo;
      const { notifications, unreadCount: count, meta } = await listNotifications(params);
      setItems(notifications);
      setUnreadCount(count);
      setTotal(meta?.total ?? notifications.length);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load notifications');
    } finally {
      setLoading(false);
      loadedRef.current = true;
    }
  }, [page, pageSize, filter, f.type, f.createdFrom, f.createdTo]);

  useEffect(() => {
    fetch();
  }, [fetch]);
  const { refresh, refreshing, lastUpdated } = useAutoRefresh(fetch);

  const handleMarkAll = async () => {
    try {
      await markAllNotificationsRead();
      fetch();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to mark all read');
    }
  };

  const openNotification = async (n) => {
    if (!n.isRead) {
      try {
        await markNotificationRead(n.id);
      } catch { /* ignore */ }
    }
    const route = RELATED_ROUTE[n.relatedType]?.(n.relatedId);
    if (route) navigate(route);
    else fetch();
  };

  const filterDefs = [
    {
      key: 'readState',
      label: 'Status',
      placeholder: 'All notifications',
      options: [
        { value: '', label: 'All notifications' },
        { value: 'unread', label: 'Unread only' },
      ],
    },
    {
      key: 'type',
      label: 'Type',
      placeholder: 'All types',
      options: [
        { value: '', label: 'All types' },
        ...Object.keys(NOTIFICATION_META).map((t) => ({ value: t, label: notificationMeta(t).label })),
      ],
    },
    { key: 'createdFrom', label: 'Created from', type: 'date' },
    { key: 'createdTo', label: 'Created to', type: 'date' },
  ];
  const filterValues = { readState: f.readState, type: f.type, createdFrom: f.createdFrom, createdTo: f.createdTo };
  const applyFilters = (next) => {
    setF({
      readState: next.readState === 'unread' ? 'unread' : '',
      type: next.type ?? '',
      createdFrom: next.createdFrom ?? '',
      createdTo: next.createdTo ?? '',
      page: '1',
    });
  };

  // Same row anatomy as the top-bar dropdown: a coloured icon for the type,
  // the title, the body underneath. The page used to show a blue "info"
  // badge for every type and only the body text, so an approval and a
  // break-glass invocation looked identical here while looking different in
  // the dropdown a few pixels above it.
  const columns = [
    {
      key: 'type',
      label: '',
      className: 'w-10',
      sortable: true,
      sortAccessor: (n) => n.type || '',
      searchAccessor: (n) => notificationMeta(n.type).label,
      mobile: {
        slot: 'leading',
        render: (n) => <NotificationIcon n={n} />,
      },
      render: (n) => <NotificationIcon n={n} />,
    },
    {
      key: 'body',
      label: 'Notification',
      searchAccessor: (n) => `${n.title || ''} ${n.body || ''}`,
      mobile: {
        slot: 'title',
        render: (n) => (
          <span className={n.isRead ? 'font-normal text-muted-foreground' : undefined}>
            {n.title || n.body || '—'}
          </span>
        ),
      },
      render: (n) => (
        <button
          type="button"
          onClick={() => openNotification(n)}
          className="group block min-w-0 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'truncate text-sm group-hover:text-primary',
                n.isRead ? 'text-foreground/80' : 'font-medium text-foreground'
              )}
            >
              {n.title || n.body || '—'}
            </span>
            {!n.isRead && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />
            )}
          </span>
          {n.title && n.body && (
            <span className="mt-0.5 block text-xs text-muted-foreground line-clamp-2">{n.body}</span>
          )}
        </button>
      ),
    },
    {
      key: 'created',
      label: 'When',
      sortable: true,
      mobile: { slot: 'secondary', render: (n) => relativeTime(n.createdAt) },
      render: (n) => (
        <span className="text-xs text-muted-foreground">{relativeTime(n.createdAt)}</span>
      ),
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Bell}
        title="Notifications"
        helpKey="notifications"
        subtitle={
          unreadCount > 0
            ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
            : 'Recent system notifications and alerts.'
        }
        onRefresh={refresh}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
        actions={[
          {
            key: 'mark-all',
            label: 'Mark all read',
            icon: CheckCheck,
            variant: 'outline',
            size: 'sm',
            onClick: handleMarkAll,
            hidden: unreadCount === 0,
          },
        ]}
      />

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        data={items}
        loading={loading}
        emptyMessage={filter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}
        emptyState={
          appliedFilterCount(filterDefs, filterValues) > 0 ? (
            <FilteredEmptyState onClear={() => applyFilters(clearedFilterValues(filterDefs))} />
          ) : undefined
        }
        // No backend free-text search on notifications — an unwired search
        // box here would silently filter nothing (DataTable skips client
        // filtering in server-paginated mode).
        showSearch={false}
        filterDefs={filterDefs}
        filterValues={filterValues}
        onFilterChange={applyFilters}
        mobile={{ onCardClick: (n) => openNotification(n), titleClamp: 2 }}
        serverPagination={{
          page,
          total,
          onPageChange: (p) => setF({ page: String(p) }),
          pageSize,
          onPageSizeChange: (size) => setF({ pageSize: String(size), page: '1' }),
        }}
      />
    </div>
  );
}

export default Notifications;
