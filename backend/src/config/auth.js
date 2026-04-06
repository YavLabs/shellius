import config from './index.js';

const authConfig = {
  secret: config.jwt.secret,
  refreshSecret: config.jwt.refreshSecret,
  expiry: config.jwt.expiry,
  refreshExpiry: config.jwt.refreshExpiry,
};

export default authConfig;
