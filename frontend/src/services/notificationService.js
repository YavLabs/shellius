import api from './api';

// /notifications returns { data: { notifications, unreadCount }, meta }
export const listNotifications = (params) =>
  api.get('/notifications', { params }).then((r) => ({
    notifications: r.data?.data?.notifications ?? [],
    unreadCount: r.data?.data?.unreadCount ?? 0,
    meta: r.data?.meta,
  }));

export const markNotificationRead = (id) =>
  api
    .patch(`/notifications/${id}/read`)
    .then((r) => r.data?.data?.notification ?? r.data?.data ?? r.data);

export const markAllNotificationsRead = () =>
  api.patch('/notifications/read-all').then((r) => r.data?.data ?? r.data);
