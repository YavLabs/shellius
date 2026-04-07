import { useState, useRef, useEffect } from 'react';
import { Bell, BellRing, CheckCheck, CheckCircle, XCircle, Clock, Ban } from 'lucide-react';
import { useNotifications } from '@/context/NotificationContext';
import { relativeTime } from '@/utils/time';
import { cn } from '@/lib/utils';

const TYPE_META = {
  REQUEST_APPROVED: { Icon: CheckCircle, color: 'text-emerald-500' },
  REQUEST_DENIED: { Icon: XCircle, color: 'text-red-500' },
  REQUEST_PENDING: { Icon: Clock, color: 'text-amber-500' },
  REQUEST_REVOKED: { Icon: Ban, color: 'text-muted-foreground' },
  CERT_EXPIRING: { Icon: Clock, color: 'text-amber-500' },
};

function NotificationRow({ notification, onMarkRead }) {
  const meta = TYPE_META[notification.type] || { Icon: Bell, color: 'text-muted-foreground' };
  const { Icon, color } = meta;

  const handleClick = () => {
    if (!notification.isRead) {
      onMarkRead(notification.id);
    }
  };

  return (
    <button
      onClick={handleClick}
      className={cn(
        'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50',
        !notification.isRead && 'bg-accent/20'
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', color)} />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm', !notification.isRead ? 'font-medium text-foreground' : 'text-foreground/80')}>
          {notification.title}
        </p>
        {notification.body && (
          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{notification.body}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground/60">{relativeTime(notification.createdAt)}</p>
      </div>
      {!notification.isRead && (
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
      )}
    </button>
  );
}

function NotificationBell() {
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications();
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
        onClick={() => setOpen((p) => !p)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title={unreadCount > 0 ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}` : 'Notifications'}
        aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications'}
      >
        {unreadCount > 0 ? (
          <BellRing className="h-[18px] w-[18px] text-foreground" />
        ) : (
          <Bell className="h-[18px] w-[18px]" />
        )}
        {unreadCount > 0 && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-destructive px-[3px] text-[9px] font-semibold leading-none text-destructive-foreground ring-2 ring-card">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-sm font-semibold text-foreground">
                Notifications
                {unreadCount > 0 && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {unreadCount} unread
                  </span>
                )}
              </span>
              {unreadCount > 0 && (
                <button
                  onClick={() => {
                    markAllRead();
                  }}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  Mark all read
                </button>
              )}
            </div>

            <div className="max-h-80 overflow-y-auto divide-y divide-border">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
                  <Bell className="mb-2 h-8 w-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">No notifications</p>
                </div>
              ) : (
                notifications.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    onMarkRead={(id) => {
                      markRead(id);
                    }}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default NotificationBell;
