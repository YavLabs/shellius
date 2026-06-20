import api from './api';

// Detail/get/create/update routes wrap as { data: { customer } }; list route
// returns { data: result } where result is { items, total, page, limit }.
const unwrapCustomer = (r) => r.data?.data?.customer ?? r.data?.data ?? r.data;

export const listCustomers = (params) =>
  api.get('/customers', { params }).then((r) => r.data?.data ?? r.data);
export const getCustomer = (id) =>
  api.get(`/customers/${id}`).then(unwrapCustomer);
export const createCustomer = (data) =>
  api.post('/customers', data).then(unwrapCustomer);
export const updateCustomer = (id, data) =>
  api.put(`/customers/${id}`, data).then(unwrapCustomer);
export const getCustomerDeleteImpact = (id) =>
  api.get(`/customers/${id}/delete-impact`).then((r) => r.data?.data ?? r.data);
export const deleteCustomer = (id, options = {}) =>
  api.delete(`/customers/${id}`, { data: options }).then((r) => r.data?.data ?? r.data);
export const getCustomerStats = (id) =>
  api.get(`/customers/${id}/stats`).then((r) => r.data?.data ?? r.data);
