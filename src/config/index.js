require('dotenv').config();

const required = (key) => {
  const v = process.env[key];
  if (!v && process.env.NODE_ENV === 'production') throw new Error(`Missing env: ${key}`);
  return v;
};

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8080),
  databaseUrl: required('DATABASE_URL') || 'postgres://sportyqo:sportyqo@localhost:5432/sportyqo',
  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET') || 'dev-access-secret',
    refreshSecret: required('JWT_REFRESH_SECRET') || 'dev-refresh-secret',
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtlDays: Number(process.env.JWT_REFRESH_TTL_DAYS || 30),
  },
  storage: {
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000', // MinIO in dev, S3 in prod
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'sportyqo',
    accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || '', // CDN base if set
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  },
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(','),
};
