/** Where a notification leads, by its related record type (Notifications page, Activity). */
export const RELATED_ROUTE = {
  // Deep-links into the request's own detail modal (AccessRequests.jsx
  // supports ?request=<id>), not just the list.
  AccessRequest: (id) => (id ? `/access-requests?request=${id}` : `/access-requests`),
  Certificate: () => `/certificates`,
  Session: () => `/sessions`,
  Server: (id) => `/servers/${id}`,
  Customer: (id) => `/customers/${id}`,
  // No standalone user detail page — same deep link Users.jsx's own row
  // actions and the Audit Log use.
  User: (id) => (id ? `/admin/users?highlight=${id}` : `/admin/users`),
};
