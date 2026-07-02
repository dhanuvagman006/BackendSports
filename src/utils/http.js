/** Consistent response envelope used by every endpoint.
 *  Success: { "success": true,  "data": ..., "meta": {...}? }
 *  Error:   { "success": false, "error": { "code", "message", "details"? } }
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  static badRequest(msg, details) { return new ApiError(400, 'BAD_REQUEST', msg, details); }
  static unauthorized(msg = 'Authentication required') { return new ApiError(401, 'UNAUTHORIZED', msg); }
  static forbidden(msg = 'You do not have permission to do that') { return new ApiError(403, 'FORBIDDEN', msg); }
  static notFound(msg = 'Resource not found') { return new ApiError(404, 'NOT_FOUND', msg); }
  static conflict(msg, details) { return new ApiError(409, 'CONFLICT', msg, details); }
}

const ok = (res, data, meta) => res.json({ success: true, data, ...(meta ? { meta } : {}) });
const created = (res, data) => res.status(201).json({ success: true, data });

/** Wrap async handlers so thrown errors reach the error middleware. */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** ?page=1&limit=20 → { limit, offset, page }; caps limit at 100. */
const pagination = (req, defaults = { page: 1, limit: 20 }) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || defaults.page);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || defaults.limit));
  return { page, limit, offset: (page - 1) * limit };
};

const pageMeta = (page, limit, total) => ({
  page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit),
});

module.exports = { ApiError, ok, created, asyncH, pagination, pageMeta };
