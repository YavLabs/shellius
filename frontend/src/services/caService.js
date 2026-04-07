import api from './api';

// /ca/public-key returns { data: { caKeyPair: { publicKey, fingerprint, ... } } }
// /ca/status returns { data: { fingerprint, certCount, ... } } (flat)
// /ca/rotate returns { data: { newKeyPair, oldKeyPairId } } (flat)
export const getPublicKey = () =>
  api
    .get('/ca/public-key')
    .then((r) => r.data?.data?.caKeyPair ?? r.data?.data ?? r.data);

export const getStatus = () =>
  api.get('/ca/status').then((r) => r.data?.data ?? r.data);

export const rotate = () =>
  api.post('/ca/rotate').then((r) => r.data?.data ?? r.data);
