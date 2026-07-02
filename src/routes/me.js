const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const db = require('../config/db');
const storage = require('../services/storage');
const { ok, asyncH, ApiError } = require('../utils/http');
const { authenticate, validate } = require('../middleware');

const router = express.Router();
const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(
    /^image\/(png|jpe?g|webp)$/.test(file.mimetype) ? null : new Error('Only PNG/JPG/WEBP allowed'),
    /^image\/(png|jpe?g|webp)$/.test(file.mimetype),
  ),
});

async function loadMe(userId, role) {
  const table = role === 'PLAYER' ? 'player_profiles' : 'coach_profiles';
  const { rows: [profile] } = await db.query(
    `SELECT p.*, s.name AS sport_name, s.emoji AS sport_emoji, s.slug AS sport_slug,
            u.email, u.phone, u.is_verified
     FROM ${table} p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN sports s ON s.id = p.primary_sport_id
     WHERE p.user_id = $1`, [userId]);
  if (!profile) throw ApiError.notFound('Profile not found');
  const avatarUrl = await storage.publicUrl(profile.avatar_key);
  const base = {
    userId,
    role,
    email: profile.email,
    phone: profile.phone,
    isVerified: profile.is_verified,
    fullName: profile.full_name,
    dob: profile.dob,
    gender: profile.gender,
    location: profile.location,
    avatarUrl,
    settings: profile.settings,
    sport: profile.primary_sport_id
      ? { id: profile.primary_sport_id, name: profile.sport_name, emoji: profile.sport_emoji, slug: profile.sport_slug }
      : null,
  };
  return role === 'PLAYER'
    ? { ...base, playerId: profile.player_code, qoScore: profile.qo_score, schoolAcademy: profile.school_academy, club: profile.club, bio: profile.bio }
    : { ...base, coachCode: profile.coach_code, title: profile.title, academy: profile.academy, yearsExperience: profile.years_experience, isVerifiedCoach: profile.is_verified_coach, bio: profile.bio };
}

// GET /me
router.get('/', authenticate, asyncH(async (req, res) => {
  ok(res, await loadMe(req.user.id, req.user.role));
}));

// PATCH /me/profile — role-aware partial update (create-profile & edit-profile screens)
const profilePatch = z.object({
  fullName: z.string().min(2).max(80).optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED']).optional(),
  location: z.string().max(120).optional(),
  schoolAcademy: z.string().max(120).optional(),   // player
  club: z.string().max(120).optional(),            // player
  academy: z.string().max(120).optional(),         // coach
  title: z.string().max(80).optional(),            // coach
  yearsExperience: z.number().int().min(0).max(80).optional(),
  sportId: z.string().uuid().optional(),
  bio: z.string().max(500).optional(),
  settings: z.record(z.any()).optional(),
}).strict();

router.patch('/profile', authenticate, validate({ body: profilePatch }), asyncH(async (req, res) => {
  const b = req.body;
  const isPlayer = req.user.role === 'PLAYER';
  const table = isPlayer ? 'player_profiles' : 'coach_profiles';
  const map = isPlayer
    ? { fullName: 'full_name', dob: 'dob', gender: 'gender', location: 'location', schoolAcademy: 'school_academy', club: 'club', sportId: 'primary_sport_id', bio: 'bio', settings: 'settings' }
    : { fullName: 'full_name', dob: 'dob', gender: 'gender', location: 'location', academy: 'academy', title: 'title', yearsExperience: 'years_experience', sportId: 'primary_sport_id', bio: 'bio', settings: 'settings' };

  const sets = []; const vals = [];
  for (const [key, col] of Object.entries(map)) {
    if (b[key] !== undefined) { vals.push(key === 'settings' ? JSON.stringify(b[key]) : b[key]); sets.push(`${col} = $${vals.length}`); }
  }
  if (!sets.length) throw ApiError.badRequest('Nothing to update');
  vals.push(req.user.id);
  await db.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE user_id = $${vals.length}`, vals);
  ok(res, await loadMe(req.user.id, req.user.role));
}));

// POST /me/avatar (multipart field: "avatar")
router.post('/avatar', authenticate, uploadMw.single('avatar'), asyncH(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Attach an image in the "avatar" field');
  const table = req.user.role === 'PLAYER' ? 'player_profiles' : 'coach_profiles';
  const { rows: [old] } = await db.query(`SELECT avatar_key FROM ${table} WHERE user_id=$1`, [req.user.id]);
  const key = await storage.upload('avatars', req.file);
  await db.query(`UPDATE ${table} SET avatar_key=$1 WHERE user_id=$2`, [key, req.user.id]);
  if (old?.avatar_key) storage.remove(old.avatar_key).catch(() => {});
  ok(res, { avatarUrl: await storage.publicUrl(key) });
}));

module.exports = { meRouter: router, loadMe };
