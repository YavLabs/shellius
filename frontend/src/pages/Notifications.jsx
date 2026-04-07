import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import Badge from '@/components/shared/Badge';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  User: () => `/users`,
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
    <Select value={filter} onValueChange={setFilter}>
      <SelectTrigger className="w-[160px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All notifications</SelectItem>
        <SelectItem value="unread">Unread only</SelectItem>
      </SelectContent>
    </Select>
  );

  const columns = [
    {
      key: 'status',
      label: '',
      className: 'w-8',
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
      render: (n) => (
        <Badge variant="outline" className="text-[10px] uppercase">
          {n.type || 'info'}
        </Badge>
      ),
    },
    {
      key: 'body',
      label: 'Message',
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
      >
        {unreadCount > 0 && (
          <Button variant="outline" size="sm" onClick={handleMarkAll}>
            <CheckCheck className="mr-2 h-4 w-4" /> Mark all read
          </Button>
        )}
      </PageHeader>

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
      />
    </div>
  );
}

export default Notifications;
