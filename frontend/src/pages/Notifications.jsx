import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import { Badge } from '@/components/ui/badge';
import { formatLabel } from '@/utils/format';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/services/notificationService';
import { relativeTime } from '@/utils/time';

const RELATED_ROUTE = {
  AccessRequest: () => `/access-requests`,
  Certificate: () => `/certificates`,
  Session: () => `/sessions`,
  Server: (id) => `/servers/${id}`,
  Customer: (id) => `/customers/${id}`,
  User: () => `/admin/users`,
};

function Notifications() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');

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

  const filterSlot = (
    <SearchableSelect
      className="w-[160px]"
      value={filter}
      onChange={setFilter}
      searchable={false}
      clearable={false}
      options={[
        { value: 'all', label: 'All notifications' },
        { value: 'unread', label: 'Unread only' },
      ]}
    />
  );

  const columns = [
    {
      key: 'status',
      label: '',
      className: 'w-8',
      mobile: {
        slot: 'leading',
        render: (n) => (
          <span
            className={`mt-1.5 inline-block h-2.5 w-2.5 rounded-full ${n.isRead ? 'bg-muted-foreground/20' : 'bg-primary'}`}
            title={n.isRead ? 'Read' : 'Unread'}
          />
        ),
      },
      render: (n) =>
        n.isRead ? (
          <span className="h-2 w-2 rounded-full bg-transparent" />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-primary" title="Unread" />
        ),
    },
    {
      key: 'type',
      label: 'Type',
      sortable: true,
      searchAccessor: (n) => n.type || '',
      mobile: { slot: 'meta', order: 1 },
      render: (n) => (
        <Badge tone="info" variant="outline">
          {formatLabel(n.type || 'info')}
        </Badge>
      ),
    },
    {
      key: 'body',
      label: 'Message',
      mobile: {
        slot: 'title',
        render: (n) => (
          <span className={n.isRead ? 'font-normal text-muted-foreground' : undefined}>{n.body || n.title || '—'}</span>
        ),
      },
      render: (n) => (
        <button
          onClick={() => openNotification(n)}
          className="text-left text-sm text-foreground hover:text-primary"
        >
          {n.body || n.title || '—'}
        </button>
      ),
    },
    {
      key: 'related',
      label: 'Related',
      hideBelow: 'md',
      mobile: { slot: 'meta', order: 2, render: (n) => n.relatedType || null },
      render: (n) => (
        <span className="text-xs text-muted-foreground">
          {n.relatedType ? `${n.relatedType}` : '—'}
        </span>
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
        data={items}
        loading={loading}
        emptyMessage={filter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}
        searchPlaceholder="Search notifications..."
        filters={filterSlot}
        mobile={{ onCardClick: (n) => openNotification(n) }}
      />
    </div>
  );
}

export default Notifications;
