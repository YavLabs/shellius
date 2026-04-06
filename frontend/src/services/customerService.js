import api from './api';

export const listCustomers = (params) =>
  api.get('/customers', { params }).then((r) => r.data.data);
export const getCustomer = (id) =>
  api.get(`/customers/${id}`).then((r) => r.data.data);
export const createCustomer = (data) =>
  api.post('/customers', data).then((r) => r.data.data);
export const updateCustomer = (id, data) =>
  api.put(`/customers/${id}`, data).then((r) => r.data.data);
export const deleteCustomer = (id) =>
  api.delete(`/customers/${id}`).then((r) => r.data.data);
export const getCustomerStats = (id) =>
  api.get(`/customers/${id}/stats`).then((r) => r.data.data);
