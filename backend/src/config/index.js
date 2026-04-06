const config = {
  port: parseInt(process.env.PORT, 10) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-jwt-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
    expiry: '15m',
    refreshExpiry: '7d',
  },

  encryption: {
    key: process.env.SERVER_ENCRYPTION_KEY || '',
  },

  bcryptRounds: 12,
};

export default config;
