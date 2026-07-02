const express = require('express');
const { z } = require('zod');
const db = require('../config/db');
const storage = require('../services/storage');
const { ok, created, asyncH, ApiError, pagination, pageMeta } = require('../utils/http');
const { authenticate, requireRole, validate } = require('../middleware');

const playbook = express.Router();
const dugout = express.Router();
const notifications = express.Router();
const matches = express.Router();
[playbook, dugout, notifications, matches].forEach((r) => r.use(authenticate));

// ================================================================ PLAYBOOK
// GET /playbook?sportId=&teamId=&kind=&q=&page=&limit=
playbook.get('/', asyncH(async (req, res) => {
  const { limit, offset, page } = pagination(req);
  const params = [req.user.id];
  const clauses = [
    // visible if: global item for my sport, OR scoped to a team/league I belong to / own
    `(pi.team_id IS NULL AND pi.league_id IS NULL
      OR pi.team_id IN (SELECT team_id FROM team_roster_memberships WHERE player_id=$1 AND status='ACTIVE')
      OR pi.league_id IN (SELECT league_id FROM league_memberships WHERE player_id=$1)
      OR pi.league_id IN (SELECT id FROM leagues WHERE owner_coach_id=$1)
      OR pi.author_id = $1)`,
  ];
  if (req.query.sportId) { params.push(req.query.sportId); clauses.push(`pi.sport_id = $${params.length}`); }
  if (req.query.kind) { params.push(req.query.kind); clauses.push(`pi.kind = $${params.length}`); }
  if (req.query.q) { params.push(`%${req.query.q}%`); clauses.push(`(pi.title ILIKE $${params.length} OR pi.description ILIKE $${params.length})`); }
  params.push(limit, offset);

  const { rows } = await db.query(
    `SELECT pi.id, pi.kind, pi.title, pi.description, pi.tags, pi.media_key, pi.created_at AS "createdAt",
            s.name AS sport_name, s.emoji AS sport_emoji, COUNT(*) OVER() AS total
     FROM playbook_items pi
     LEFT JOIN sports s ON s.id = pi.sport_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY pi.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  const data = await Promise.all(rows.map(async (r) => ({
    id: r.id, kind: r.kind, title: r.title, description: r.description, tags: r.tags,
    mediaUrl: await storage.publicUrl(r.media_key),
    sport: r.sport_name ? { name: r.sport_name, emoji: r.sport_emoji } : null,
    createdAt: r.createdAt,
  })));
  ok(res, data, pageMeta(page, limit, rows[0]?.total || 0));
}));

// POST /playbook (coach)
playbook.post('/', requireRole('COACH'), validate({
  body: z.object({
    title: z.string().min(3).max(140),
    description: z.string().max(2000).optional(),
    kind: z.enum(['DRILL', 'STRATEGY', 'VIDEO', 'NOTE']).default('DRILL'),
    sportId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    leagueId: z.string().uuid().optional(),
    tags: z.array(z.string().max(30)).max(10).default([]),
  }),
}), asyncH(async (req, res) => {
  const b = req.body;
  if (b.leagueId) {
    const { rowCount } = await db.query('SELECT 1 FROM leagues WHERE id=$1 AND owner_coach_id=$2', [b.leagueId, req.user.id]);
    if (!rowCount) throw ApiError.forbidden('Not your league');
  }
  const { rows: [row] } = await db.query(
    `INSERT INTO playbook_items (author_id, sport_id, team_id, league_id, kind, title, description, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, kind, title, description, tags, created_at AS "createdAt"`,
    [req.user.id, b.sportId || null, b.teamId || null, b.leagueId || null, b.kind, b.title, b.description || null, b.tags]);
  created(res, row);
}));

// ================================================================ DUGOUT (chat)
// GET /dugout — my threads with last message preview
dugout.get('/', asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ct.id, ct.scope, ct.title,
            t.name AS team_name, t.icon_emoji AS team_icon,
            l.name AS league_name,
            lm.body AS last_body, lm.created_at AS last_at, sp.full_name AS last_sender
     FROM chat_participants cp
     JOIN chat_threads ct ON ct.id = cp.thread_id
     LEFT JOIN teams t ON t.id = ct.team_id
     LEFT JOIN leagues l ON l.id = ct.league_id
     LEFT JOIN LATERAL (
       SELECT dm.body, dm.created_at, dm.sender_id FROM dugout_messages dm
       WHERE dm.thread_id = ct.id ORDER BY dm.created_at DESC LIMIT 1
     ) lm ON TRUE
     LEFT JOIN LATERAL (
       SELECT COALESCE(pp.full_name, chp.full_name) AS full_name
       FROM users u
       LEFT JOIN player_profiles pp ON pp.user_id = u.id
       LEFT JOIN coach_profiles chp ON chp.user_id = u.id
       WHERE u.id = lm.sender_id
     ) sp ON TRUE
     WHERE cp.user_id = $1
     ORDER BY lm.created_at DESC NULLS LAST`, [req.user.id]);

  ok(res, rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    title: r.title || r.team_name || r.league_name || 'Chat',
    icon: r.team_icon || '💬',
    lastMessage: r.last_body ? { body: r.last_body, senderName: r.last_sender, at: r.last_at } : null,
  })));
}));

// GET /dugout/:id/messages?page=&limit=
dugout.get('/:id/messages', validate({ params: z.object({ id: z.string().uuid() }) }), asyncH(async (req, res) => {
  const { rowCount: member } = await db.query(
    'SELECT 1 FROM chat_participants WHERE thread_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!member) throw ApiError.forbidden('You are not in this chat');

  const { limit, offset, page } = pagination(req, { page: 1, limit: 50 });
  const { rows } = await db.query(
    `SELECT dm.id, dm.body, dm.attachment_key, dm.created_at AS "createdAt", dm.sender_id AS "senderId",
            COALESCE(pp.full_name, cp2.full_name) AS "senderName",
            COUNT(*) OVER() AS total
     FROM dugout_messages dm
     LEFT JOIN player_profiles pp ON pp.user_id = dm.sender_id
     LEFT JOIN coach_profiles cp2 ON cp2.user_id = dm.sender_id
     WHERE dm.thread_id = $1
     ORDER BY dm.created_at DESC LIMIT $2 OFFSET $3`, [req.params.id, limit, offset]);

  const data = await Promise.all(rows.map(async (r) => ({
    id: r.id, body: r.body, senderId: r.senderId, senderName: r.senderName,
    isMine: r.senderId === req.user.id,
    attachmentUrl: await storage.publicUrl(r.attachment_key),
    createdAt: r.createdAt,
  })));
  ok(res, data, pageMeta(page, limit, rows[0]?.total || 0));
}));

// POST /dugout/:id/messages
dugout.post('/:id/messages', validate({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ body: z.string().min(1).max(2000) }),
}), asyncH(async (req, res) => {
  const { rowCount: member } = await db.query(
    'SELECT 1 FROM chat_participants WHERE thread_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!member) throw ApiError.forbidden('You are not in this chat');
  const { rows: [row] } = await db.query(
    `INSERT INTO dugout_messages (thread_id, sender_id, body) VALUES ($1,$2,$3)
     RETURNING id, body, created_at AS "createdAt"`, [req.params.id, req.user.id, req.body.body]);
  created(res, { ...row, senderId: req.user.id, isMine: true });
}));

// ================================================================ NOTIFICATIONS
// GET /notifications?unread=true&page=&limit=
notifications.get('/', asyncH(async (req, res) => {
  const { limit, offset, page } = pagination(req);
  const params = [req.user.id];
  let where = 'user_id = $1';
  if (req.query.unread === 'true') where += ' AND NOT is_read';
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT id, type, title, body, emoji, data, is_read AS "isRead", created_at AS "createdAt", COUNT(*) OVER() AS total
     FROM notifications WHERE ${where}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  ok(res, rows.map(({ total, ...r }) => r), pageMeta(page, limit, rows[0]?.total || 0));
}));

// POST /notifications/read  { ids?: [] } — mark some or all read
notifications.post('/read', validate({
  body: z.object({ ids: z.array(z.string().uuid()).optional() }),
}), asyncH(async (req, res) => {
  if (req.body.ids?.length) {
    await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND id = ANY($2)', [req.user.id, req.body.ids]);
  } else {
    await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1', [req.user.id]);
  }
  ok(res, { updated: true });
}));

// ================================================================ MATCHES
// GET /matches?leagueId=&teamId=&status=
matches.get('/', asyncH(async (req, res) => {
  const { limit, offset, page } = pagination(req);
  const params = [];
  const clauses = ['TRUE'];
  if (req.query.leagueId) { params.push(req.query.leagueId); clauses.push(`m.league_id = $${params.length}`); }
  if (req.query.teamId) { params.push(req.query.teamId); clauses.push(`(m.home_team_id = $${params.length} OR m.away_team_id = $${params.length})`); }
  if (req.query.status) { params.push(req.query.status.toUpperCase()); clauses.push(`m.status = $${params.length}`); }
  params.push(limit, offset);

  const { rows } = await db.query(
    `SELECT m.id, m.scheduled_at AS "scheduledAt", m.status, m.venue,
            m.home_score AS "homeScore", m.away_score AS "awayScore", m.result_summary AS "resultSummary",
            jsonb_build_object('id', ht.id, 'name', ht.name, 'icon', ht.icon_emoji) AS "homeTeam",
            jsonb_build_object('id', at.id, 'name', at.name, 'icon', at.icon_emoji) AS "awayTeam",
            l.name AS "leagueName", COUNT(*) OVER() AS total
     FROM matches m
     JOIN teams ht ON ht.id = m.home_team_id
     JOIN teams at ON at.id = m.away_team_id
     JOIN leagues l ON l.id = m.league_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY m.scheduled_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  ok(res, rows.map(({ total, ...r }) => r), pageMeta(page, limit, rows[0]?.total || 0));
}));

// POST /matches (coach schedules a match — powers the select-match screen)
matches.post('/', requireRole('COACH'), validate({
  body: z.object({
    leagueId: z.string().uuid(),
    homeTeamId: z.string().uuid(),
    awayTeamId: z.string().uuid(),
    scheduledAt: z.string().datetime(),
    venue: z.string().max(140).optional(),
  }).refine((b) => b.homeTeamId !== b.awayTeamId, { message: 'A team cannot play itself' }),
}), asyncH(async (req, res) => {
  const b = req.body;
  const { rowCount: owner } = await db.query('SELECT 1 FROM leagues WHERE id=$1 AND owner_coach_id=$2', [b.leagueId, req.user.id]);
  if (!owner) throw ApiError.forbidden('Not your league');
  const { rows: [row] } = await db.query(
    `INSERT INTO matches (league_id, home_team_id, away_team_id, scheduled_at, venue)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, scheduled_at AS "scheduledAt", status, venue`,
    [b.leagueId, b.homeTeamId, b.awayTeamId, b.scheduledAt, b.venue || null]);
  created(res, row);
}));

module.exports = { playbook, dugout, notifications, matches };
