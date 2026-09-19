/** Where a notification leads, by its related record type (Notifications page, Activity). */
export const RELATED_ROUTE = {
  AccessRequest: () => `/access-requests`,
  Certificate: () => `/certificates`,
  Session: () => `/sessions`,
  Server: (id) => `/servers/${id}`,
  Customer: (id) => `/customers/${id}`,
  User: () => `/admin/users`,
};
