const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../config/db');
const config = require('../config');
const { ok, created, asyncH, ApiError } = require('../utils/http');
const { validate, authenticate } = require('../middleware');
const { newPlayerCode, newCoachCode, generateUnique, randDigits } = require('../utils/codes');

const router = express.Router();

// ---------------------------------------------------------------- helpers
const credentials = z.object({
  email: z.string().email().optional(),
  phone: z.string().regex(/^\+?[0-9]{8,15}$/).optional(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
}).refine((d) => d.email || d.phone, { message: 'Provide an email or phone number' });

const signAccess = (user) => jwt.sign(
  { sub: user.id, role: user.role },
  config.jwt.accessSecret,
  { expiresIn: config.jwt.accessTtl },
);

async function issueRefresh(userId) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expires = new Date(Date.now() + config.jwt.refreshTtlDays * 864e5);
  await db.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [userId, hash, expires],
  );
  return raw;
}

async function tokenBundle(user) {
  return {
    accessToken: signAccess(user),
    refreshToken: await issueRefresh(user.id),
    tokenType: 'Bearer',
    expiresIn: 900,
  };
}

// ---------------------------------------------------------------- register
// POST /auth/register/player
router.post('/register/player', validate({
  body: credentials.and(z.object({
    fullName: z.string().min(2).max(80),
    sportId: z.string().uuid().optional(),   // chosen on the select-sport screen
  })),
}), asyncH(async (req, res) => {
  const { email, phone, password, fullName, sportId } = req.body;
  const passwordHash = await bcrypt.hash(password, 12);

  const result = await db.tx(async (c) => {
    const { rows: [user] } = await c.query(
      `INSERT INTO users (role, email, phone, password_hash) VALUES ('PLAYER',$1,$2,$3) RETURNING id, role`,
      [email || null, phone || null, passwordHash],
    );
    const playerCode = await generateUnique(newPlayerCode, async (code) => {
      const { rowCount } = await c.query('SELECT 1 FROM player_profiles WHERE player_code=$1', [code]);
      return rowCount > 0;
    });
    await c.query(
      `INSERT INTO player_profiles (user_id, player_code, full_name, primary_sport_id) VALUES ($1,$2,$3,$4)`,
      [user.id, playerCode, fullName, sportId || null],
    );
    return { user, playerCode };
  });

  created(res, {
    userId: result.user.id,
    role: 'PLAYER',
    playerId: result.playerCode,   // shown on "Your Player ID is Ready!" screen
    ...(await tokenBundle(result.user)),
  });
}));

// POST /auth/register/coach
router.post('/register/coach', validate({
  body: credentials.and(z.object({
    fullName: z.string().min(2).max(80),
    academy: z.string().max(120).optional(),
    sportId: z.string().uuid().optional(),
  })),
}), asyncH(async (req, res) => {
  const { email, phone, password, fullName, academy, sportId } = req.body;
  const passwordHash = await bcrypt.hash(password, 12);

  const result = await db.tx(async (c) => {
    const { rows: [user] } = await c.query(
      `INSERT INTO users (role, email, phone, password_hash) VALUES ('COACH',$1,$2,$3) RETURNING id, role`,
      [email || null, phone || null, passwordHash],
    );
    const coachCode = await generateUnique(newCoachCode, async (code) => {
      const { rowCount } = await c.query('SELECT 1 FROM coach_profiles WHERE coach_code=$1', [code]);
      return rowCount > 0;
    });
    await c.query(
      `INSERT INTO coach_profiles (user_id, coach_code, full_name, academy, primary_sport_id) VALUES ($1,$2,$3,$4,$5)`,
      [user.id, coachCode, fullName, academy || null, sportId || null],
    );
    return { user, coachCode };
  });

  created(res, {
    userId: result.user.id,
    role: 'COACH',
    coachCode: result.coachCode,   // used by the access-code screen
    ...(await tokenBundle(result.user)),
  });
}));

// ---------------------------------------------------------------- login / logout / refresh
// POST /auth/login  { identifier: email-or-phone, password }
router.post('/login', validate({
  body: z.object({ identifier: z.string().min(3), password: z.string().min(1) }),
}), asyncH(async (req, res) => {
  const { identifier, password } = req.body;
  const { rows: [user] } = await db.query(
    `SELECT id, role, password_hash, is_active FROM users WHERE email = $1 OR phone = $1`,
    [identifier],
  );
  if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
    throw ApiError.unauthorized('Incorrect email/phone or password');
  }
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  ok(res, { userId: user.id, role: user.role, ...(await tokenBundle(user)) });
}));

// POST /auth/refresh  { refreshToken }
router.post('/refresh', validate({
  body: z.object({ refreshToken: z.string().min(20) }),
}), asyncH(async (req, res) => {
  const hash = crypto.createHash('sha256').update(req.body.refreshToken).digest('hex');
  const { rows: [row] } = await db.query(
    `SELECT rt.id, rt.user_id, u.role FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()`,
    [hash],
  );
  if (!row) throw ApiError.unauthorized('Invalid refresh token');
  // rotate
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
  ok(res, { userId: row.user_id, role: row.role, ...(await tokenBundle({ id: row.user_id, role: row.role })) });
}));

// POST /auth/logout  { refreshToken }
router.post('/logout', authenticate, asyncH(async (req, res) => {
  if (req.body?.refreshToken) {
    const hash = crypto.createHash('sha256').update(req.body.refreshToken).digest('hex');
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND user_id = $2', [hash, req.user.id]);
  } else {
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
  }
  ok(res, { loggedOut: true });
}));

// ---------------------------------------------------------------- forgot / reset password
// POST /auth/forgot-password { identifier } — always 200 to avoid account enumeration
router.post('/forgot-password', validate({
  body: z.object({ identifier: z.string().min(3) }),
}), asyncH(async (req, res) => {
  const { rows: [user] } = await db.query('SELECT id, email, phone FROM users WHERE email=$1 OR phone=$1', [req.body.identifier]);
  if (user) {
    const otp = randDigits(6);
    const hash = crypto.createHash('sha256').update(otp).digest('hex');
    await db.query(
      'INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES ($1,$2, now() + interval \'15 minutes\')',
      [user.id, hash],
    );
    // TODO: deliver via email/SMS provider. Logged in dev so the flow is testable.
    if (config.env !== 'production') req.log?.info?.({ otp }, 'password reset OTP (dev only)');
  }
  ok(res, { message: 'If that account exists, a reset code has been sent.' });
}));

// POST /auth/reset-password { identifier, code, newPassword }
router.post('/reset-password', validate({
  body: z.object({ identifier: z.string().min(3), code: z.string().length(6), newPassword: z.string().min(8) }),
}), asyncH(async (req, res) => {
  const { identifier, code, newPassword } = req.body;
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  const { rows: [row] } = await db.query(
    `SELECT pr.id, pr.user_id FROM password_resets pr
     JOIN users u ON u.id = pr.user_id
     WHERE (u.email=$1 OR u.phone=$1) AND pr.code_hash=$2 AND pr.used_at IS NULL AND pr.expires_at > now()
     ORDER BY pr.created_at DESC LIMIT 1`,
    [identifier, hash],
  );
  if (!row) throw ApiError.badRequest('Invalid or expired reset code');
  await db.tx(async (c) => {
    await c.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(newPassword, 12), row.user_id]);
    await c.query('UPDATE password_resets SET used_at = now() WHERE id=$1', [row.id]);
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL', [row.user_id]);
  });
  ok(res, { message: 'Password updated. Please log in again.' });
}));

// ---------------------------------------------------------------- verification & social stubs
// POST /auth/verify { identifier, code } — marks account verified ("verification sent" screen)
router.post('/verify', validate({
  body: z.object({ identifier: z.string().min(3), code: z.string().length(6) }),
}), asyncH(async (req, res) => {
  const hash = crypto.createHash('sha256').update(req.body.code).digest('hex');
  const { rows: [row] } = await db.query(
    `SELECT vt.id, vt.user_id FROM verification_tokens vt
     JOIN users u ON u.id = vt.user_id
     WHERE (u.email=$1 OR u.phone=$1) AND vt.code_hash=$2 AND vt.used_at IS NULL AND vt.expires_at > now()
     ORDER BY vt.expires_at DESC LIMIT 1`,
    [req.body.identifier, hash],
  );
  if (!row) throw ApiError.badRequest('Invalid or expired verification code');
  await db.tx(async (c) => {
    await c.query('UPDATE users SET is_verified = TRUE WHERE id=$1', [row.user_id]);
    await c.query('UPDATE verification_tokens SET used_at = now() WHERE id=$1', [row.id]);
  });
  ok(res, { verified: true });
}));

// POST /auth/social/:provider — placeholder matching the social buttons in the UI
router.post('/social/:provider', (req, res) => {
  res.status(501).json({
    success: false,
    error: { code: 'NOT_IMPLEMENTED', message: `${req.params.provider} login is not enabled yet` },
  });
});

module.exports = router;
