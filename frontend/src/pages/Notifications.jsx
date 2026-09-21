import { useState, useEffect, useCallback, useMemo } from 'react';
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
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('');

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page: 1, limit: 100 };
      if (filter === 'unread') params.isRead = 'false';
      const { notifications, unreadCount: count } = await listNotifications(params);
      setItems(notifications);
      setUnreadCount(count);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetch();
  }, [fetch]);

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
  ];
  // `filter` stays 'all'|'unread' for the fetch param; the drawer sees '' for "all".
  const filterValues = { readState: filter === 'unread' ? 'unread' : '', type: typeFilter };
  const applyFilters = (next) => {
    setFilter(next.readState === 'unread' ? 'unread' : 'all');
    setTypeFilter(next.type ?? '');
  };

  // Type is a client-side narrowing of the already-loaded page (isRead is
  // the only dimension the API filters on — see routes/notifications.js).
  const filteredItems = useMemo(
    () => (typeFilter ? items.filter((n) => n.type === typeFilter) : items),
    [items, typeFilter]
  );

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
        data={filteredItems}
        loading={loading}
        emptyMessage={filter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}
        emptyState={
          appliedFilterCount(filterDefs, filterValues) > 0 ? (
            <FilteredEmptyState onClear={() => applyFilters(clearedFilterValues(filterDefs))} />
          ) : undefined
        }
        searchPlaceholder="Search notifications..."
        filterDefs={filterDefs}
        filterValues={filterValues}
        onFilterChange={applyFilters}
        mobile={{ onCardClick: (n) => openNotification(n), titleClamp: 2 }}
      />
    </div>
  );
}

export default Notifications;
