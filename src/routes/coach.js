const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const db = require('../config/db');
const storage = require('../services/storage');
const { ok, created, asyncH } = require('../utils/http');
const { authenticate, requireRole, validate } = require('../middleware');

const router = express.Router();
router.use(authenticate, requireRole('COACH'));
const uploadMw = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------------------------------------------------------------- GET /coach/dashboard  (coach home screen)
router.get('/dashboard', asyncH(async (req, res) => {
  const coachId = req.user.id;
  const [{ rows: [cp] }, { rows: leagues }, { rows: notifications }, { rows: [counts] }] = await Promise.all([
    db.query(
      `SELECT cp.*, s.name AS sport_name, s.emoji AS sport_emoji
       FROM coach_profiles cp LEFT JOIN sports s ON s.id = cp.primary_sport_id
       WHERE cp.user_id = $1`, [coachId]),
    db.query(
      `SELECT l.id, l.name, l.icon_emoji AS icon, l.logo_key, l.status, l.gender,
              (SELECT COUNT(*) FROM league_memberships lm WHERE lm.league_id=l.id) AS players,
              (SELECT COUNT(*) FROM teams t WHERE t.league_id=l.id) AS teams
       FROM leagues l WHERE l.owner_coach_id=$1 ORDER BY l.created_at DESC LIMIT 5`, [coachId]),
    db.query(
      `SELECT id, type, title, body, emoji, is_read AS "isRead", created_at AS "createdAt"
       FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`, [coachId]),
    db.query(
      `SELECT
         (SELECT COUNT(*) FROM leagues WHERE owner_coach_id=$1) AS leagues,
         (SELECT COUNT(DISTINCT lm.player_id) FROM league_memberships lm
            JOIN leagues l ON l.id=lm.league_id WHERE l.owner_coach_id=$1) AS players,
         (SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND NOT is_read) AS unread`, [coachId]),
  ]);

  ok(res, {
    coach: {
      id: coachId,
      fullName: cp.full_name,                     // "Coach Suneeth"
      title: cp.title,                            // "Head Coach"
      academy: cp.academy,                        // "Falcons Cricket Academy"
      coachCode: cp.coach_code,
      isVerified: cp.is_verified_coach,           // verified badge
      avatarUrl: await storage.publicUrl(cp.avatar_key),
      sport: cp.sport_name ? { name: cp.sport_name, emoji: cp.sport_emoji } : null,
    },
    counts: {
      leagues: Number(counts.leagues),
      players: Number(counts.players),
      unreadNotifications: Number(counts.unread),
    },
    leagues: await Promise.all(leagues.map(async (l) => ({
      id: l.id, name: l.name, icon: l.icon, status: l.status, gender: l.gender,
      logoUrl: await storage.publicUrl(l.logo_key),
      counts: { players: Number(l.players), teams: Number(l.teams) },
    }))),
    notifications: { recent: notifications },
    showCreateLeagueCta: leagues.length === 0,     // "Create your first league..." card
  });
}));

// ---------------------------------------------------------------- GET /coach/performance
// Aggregated view across the coach's leagues for the coach performance screen.
router.get('/performance', asyncH(async (req, res) => {
  const coachId = req.user.id;
  const [{ rows: [totals] }, { rows: topPlayers }, { rows: recentMatches }] = await Promise.all([
    db.query(
      `SELECT
         COUNT(DISTINCT m.id) FILTER (WHERE m.status='COMPLETED') AS matches_completed,
         COUNT(DISTINCT m.id) FILTER (WHERE m.status='SCHEDULED') AS matches_upcoming,
         COALESCE(SUM(ps.qo_points),0) AS qo_awarded
       FROM leagues l
       LEFT JOIN matches m ON m.league_id = l.id
       LEFT JOIN player_stats ps ON ps.match_id = m.id
       WHERE l.owner_coach_id = $1`, [coachId]),
    db.query(
      `SELECT pp.user_id AS id, pp.full_name AS "fullName", pp.player_code AS "playerCode",
              pp.qo_score AS "qoScore", pp.avatar_key
       FROM player_profiles pp
       JOIN league_memberships lm ON lm.player_id = pp.user_id
       JOIN leagues l ON l.id = lm.league_id
       WHERE l.owner_coach_id = $1
       GROUP BY pp.user_id ORDER BY pp.qo_score DESC LIMIT 5`, [coachId]),
    db.query(
      `SELECT m.id, m.scheduled_at AS "playedAt", m.result_summary AS "resultSummary",
              m.home_score AS "homeScore", m.away_score AS "awayScore",
              ht.name AS "homeTeam", at.name AS "awayTeam", l.name AS "leagueName"
       FROM matches m
       JOIN leagues l ON l.id = m.league_id AND l.owner_coach_id = $1
       JOIN teams ht ON ht.id = m.home_team_id
       JOIN teams at ON at.id = m.away_team_id
       WHERE m.status='COMPLETED'
       ORDER BY m.scheduled_at DESC LIMIT 10`, [coachId]),
  ]);

  ok(res, {
    totals: {
      matchesCompleted: Number(totals.matches_completed),
      matchesUpcoming: Number(totals.matches_upcoming),
      qoPointsAwarded: Number(totals.qo_awarded),
    },
    topPlayers: await Promise.all(topPlayers.map(async (p) => ({
      ...p, avatarUrl: await storage.publicUrl(p.avatar_key), avatar_key: undefined,
    }))),
    recentMatches,
  });
}));

// ---------------------------------------------------------------- certifications
// GET /coach/certifications
router.get('/certifications', asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, title, issuer, issued_on AS "issuedOn", status, document_key, created_at AS "createdAt"
     FROM coach_certifications WHERE coach_id=$1 ORDER BY created_at DESC`, [req.user.id]);
  ok(res, await Promise.all(rows.map(async (r) => ({
    ...r, documentUrl: await storage.publicUrl(r.document_key), document_key: undefined,
  }))));
}));

// POST /coach/certifications (multipart: document + fields)
router.post('/certifications', uploadMw.single('document'), validate({
  body: z.object({
    title: z.string().min(3).max(140),
    issuer: z.string().max(140).optional(),
    issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
}), asyncH(async (req, res) => {
  const documentKey = req.file ? await storage.upload('certifications', req.file) : null;
  const { rows: [row] } = await db.query(
    `INSERT INTO coach_certifications (coach_id, title, issuer, issued_on, document_key)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, title, issuer, issued_on AS "issuedOn", status, created_at AS "createdAt"`,
    [req.user.id, req.body.title, req.body.issuer || null, req.body.issuedOn || null, documentKey]);
  created(res, row);
}));

module.exports = router;
