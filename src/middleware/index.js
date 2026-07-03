const jwt = require('jsonwebtoken');
const { ZodError } = require('zod');
const config = require('../config');
const { ApiError } = require('../utils/http');

/** Verifies "Authorization: Bearer <access token>" and sets req.user = { id, role }. */
const authenticate = (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(ApiError.unauthorized());
  try {
    const payload = jwt.verify(token, config.jwt.accessSecret);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(ApiError.unauthorized('Invalid or expired token'));
  }
};

/** requireRole('COACH') — role-based access control. */
const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!roles.includes(req.user.role)) {
    return next(ApiError.forbidden(`This action requires role: ${roles.join(' or ')}`));
  }
  next();
};

/** validate({ body: schema, query: schema, params: schema }) using zod. */
const validate = (schemas) => (req, _res, next) => {
  try {
    for (const key of ['body', 'query', 'params']) {
      if (schemas[key]) req[key] = schemas[key].parse(req[key]);
    }
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      return next(ApiError.badRequest('Validation failed',
        err.errors.map((e) => ({ field: e.path.join('.'), message: e.message }))));
    }
    next(err);
  }
};

/** Final error handler — the single place error JSON is produced. */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }
  // Multer upload errors (file too large, unexpected field) → 400
  if (err.name === 'MulterError') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: err.code === 'LIMIT_FILE_SIZE'
          ? 'File is too large'
          : `Upload error: ${err.message}`,
      },
    });
  }
  // Postgres unique violation → 409
  if (err.code === '23505') {
    return res.status(409).json({
      success: false,
      error: { code: 'CONFLICT', message: 'A record with those details already exists' },
    });
  }
  req.log?.error?.(err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
  });
};

const notFound = (req, res) => res.status(404).json({
  success: false,
  error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.originalUrl}` },
});

module.exports = { authenticate, requireRole, validate, errorHandler, notFound };
