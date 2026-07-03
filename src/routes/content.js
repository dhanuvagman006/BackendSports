const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const db = require('../config/db');
const storage = require('../services/storage');
const { ok, created, asyncH, ApiError, pagination, pageMeta } = require('../utils/http');
const { authenticate, requireRole, validate } = require('../middleware');

// Playbook media: photos up to 10 MB, videos up to 100 MB (checked per-type below).
const IMAGE_RE = /^image\/(png|jpe?g|webp|gif)$/;
const VIDEO_RE = /^video\/(mp4|quicktime|webm|3gpp|x-msvideo)$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_RE.test(file.mimetype) || VIDEO_RE.test(file.mimetype)) return cb(null, true);
    cb(ApiError.badRequest('Only PNG/JPG/WEBP/GIF images or MP4/MOV/WEBM videos are allowed'));
  },
});

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
    // visible if: global COACH-authored item, OR scoped to a team/league I belong to / own,
    // OR my own item. Player-authored items are always private to their author.
    `((pi.team_id IS NULL AND pi.league_id IS NULL
        AND EXISTS (SELECT 1 FROM users au WHERE au.id = pi.author_id AND au.role = 'COACH'))
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
            pi.author_id, COALESCE(app.full_name, acp.full_name) AS author_name,
            s.name AS sport_name, s.emoji AS sport_emoji, COUNT(*) OVER() AS total
     FROM playbook_items pi
     LEFT JOIN player_profiles app ON app.user_id = pi.author_id
     LEFT JOIN coach_profiles acp ON acp.user_id = pi.author_id
     LEFT JOIN sports s ON s.id = pi.sport_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY pi.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  const data = await Promise.all(rows.map(async (r) => ({
    id: r.id, kind: r.kind, title: r.title, description: r.description, tags: r.tags,
    mediaUrl: await storage.publicUrl(r.media_key),
    sport: r.sport_name ? { name: r.sport_name, emoji: r.sport_emoji } : null,
    authorName: r.author_name,
    isMine: r.author_id === req.user.id,
    createdAt: r.createdAt,
  })));
  ok(res, data, pageMeta(page, limit, rows[0]?.total || 0));
}));

// POST /playbook — create an item, optionally with a media file.
// Accepts application/json (metadata only) OR multipart/form-data with a
// "media" file field (photo or video) plus the same metadata fields.
// Coaches can scope items to their leagues/teams; player-authored items are
// always private to the player (see the GET visibility rule above).
const playbookBody = z.object({
  title: z.string().min(3).max(140),
  description: z.string().max(2000).optional(),
  kind: z.enum(['DRILL', 'STRATEGY', 'VIDEO', 'NOTE']).optional(),
  sportId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  leagueId: z.string().uuid().optional(),
  tags: z.array(z.string().max(30)).max(10).default([]),
});

// Multipart fields arrive as strings — normalise before zod validation.
const normalizePlaybookBody = (raw) => {
  const b = { ...raw };
  for (const k of ['description', 'kind', 'sportId', 'teamId', 'leagueId']) {
    if (b[k] === '' || b[k] === 'null') delete b[k];
  }
  if (typeof b.tags === 'string') {
    try { b.tags = JSON.parse(b.tags); } catch { /* fall through */ }
    if (typeof b.tags === 'string') {
      b.tags = b.tags.split(',').map((t) => t.trim()).filter(Boolean);
    }
  }
  return b;
};

playbook.post('/', mediaUpload.single('media'), asyncH(async (req, res) => {
  const parsed = playbookBody.safeParse(normalizePlaybookBody(req.body || {}));
  if (!parsed.success) {
    throw ApiError.badRequest('Validation failed',
      parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })));
  }
  const b = parsed.data;

  const file = req.file || null;
  const isVideo = file ? VIDEO_RE.test(file.mimetype) : false;
  if (file && !isVideo && file.size > MAX_IMAGE_BYTES) {
    throw ApiError.badRequest('Images must be 10 MB or smaller');
  }
  // Default the kind from the media type when the client doesn't send one.
  const kind = b.kind || (isVideo ? 'VIDEO' : (file ? 'DRILL' : 'NOTE'));

  const isCoach = req.user.role === 'COACH';
  // Players may not scope items to teams/leagues — their items are personal.
  const teamId = isCoach ? (b.teamId || null) : null;
  const leagueId = isCoach ? (b.leagueId || null) : null;
  if (leagueId) {
    const { rowCount } = await db.query('SELECT 1 FROM leagues WHERE id=$1 AND owner_coach_id=$2', [leagueId, req.user.id]);
    if (!rowCount) throw ApiError.forbidden('Not your league');
  }
  if (teamId) {
    const { rowCount } = await db.query(
      `SELECT 1 FROM teams t JOIN leagues l ON l.id = t.league_id
       WHERE t.id=$1 AND l.owner_coach_id=$2`, [teamId, req.user.id]);
    if (!rowCount) throw ApiError.forbidden('Not your team');
  }

  const mediaKey = file ? await storage.upload('playbook', file) : null;
  try {
    const { rows: [row] } = await db.query(
      `INSERT INTO playbook_items (author_id, sport_id, team_id, league_id, kind, title, description, tags, media_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, kind, title, description, tags, media_key, created_at AS "createdAt"`,
      [req.user.id, b.sportId || null, teamId, leagueId, kind, b.title, b.description || null, b.tags, mediaKey]);
    created(res, {
      id: row.id, kind: row.kind, title: row.title, description: row.description,
      tags: row.tags, mediaUrl: await storage.publicUrl(row.media_key),
      isMine: true, createdAt: row.createdAt,
    });
  } catch (err) {
    // Don't strand the uploaded object if the insert fails.
    if (mediaKey) storage.remove(mediaKey).catch(() => {});
    throw err;
  }
}));

// DELETE /playbook/:id — author only; also removes the stored media object.
playbook.delete('/:id', validate({ params: z.object({ id: z.string().uuid() }) }), asyncH(async (req, res) => {
  const { rows: [row] } = await db.query(
    'DELETE FROM playbook_items WHERE id=$1 AND author_id=$2 RETURNING media_key', [req.params.id, req.user.id]);
  if (!row) throw ApiError.notFound('Playbook item not found');
  if (row.media_key) storage.remove(row.media_key).catch(() => {});
  ok(res, { deleted: true });
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

// POST /dugout/direct — find or create a 1:1 thread with another user.
// Allowed when the two users share a league (coach owns it / both are members).
dugout.post('/direct', validate({
  body: z.object({ userId: z.string().uuid() }),
}), asyncH(async (req, res) => {
  const otherId = req.body.userId;
  if (otherId === req.user.id) throw ApiError.badRequest('Cannot message yourself');

  const { rowCount: related } = await db.query(
    `SELECT 1
     FROM league_memberships lm
     JOIN leagues l ON l.id = lm.league_id
     WHERE (lm.player_id = $1 AND (l.owner_coach_id = $2 OR EXISTS
             (SELECT 1 FROM league_memberships x WHERE x.league_id = l.id AND x.player_id = $2)))
        OR (lm.player_id = $2 AND (l.owner_coach_id = $1 OR EXISTS
             (SELECT 1 FROM league_memberships y WHERE y.league_id = l.id AND y.player_id = $1)))
     LIMIT 1`, [req.user.id, otherId]);
  if (!related) throw ApiError.forbidden('You can only message people in your leagues');

  const { rows: [existing] } = await db.query(
    `SELECT ct.id FROM chat_threads ct
     JOIN chat_participants a ON a.thread_id = ct.id AND a.user_id = $1
     JOIN chat_participants b ON b.thread_id = ct.id AND b.user_id = $2
     WHERE ct.scope = 'DIRECT' LIMIT 1`, [req.user.id, otherId]);
  if (existing) return ok(res, { threadId: existing.id });

  const threadId = await db.tx(async (client) => {
    const { rows: [other] } = await client.query(
      `SELECT COALESCE(pp.full_name, cp2.full_name) AS name
       FROM users u
       LEFT JOIN player_profiles pp ON pp.user_id = u.id
       LEFT JOIN coach_profiles cp2 ON cp2.user_id = u.id
       WHERE u.id = $1`, [otherId]);
    const { rows: [ct] } = await client.query(
      `INSERT INTO chat_threads (scope, title) VALUES ('DIRECT', $1) RETURNING id`,
      [other?.name || 'Direct message']);
    await client.query(
      'INSERT INTO chat_participants (thread_id, user_id) VALUES ($1,$2), ($1,$3)',
      [ct.id, req.user.id, otherId]);
    return ct.id;
  });
  created(res, { threadId });
}));

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
            m.winner_team_id AS "winnerTeamId",
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

// GET /matches/:id/stats?teamId= — existing stat lines for a match (prefills the coach edit table)
matches.get('/:id/stats', requireRole('COACH'), validate({
  params: z.object({ id: z.string().uuid() }),
}), asyncH(async (req, res) => {
  const { rows: [m] } = await db.query(
    `SELECT m.id, l.owner_coach_id FROM matches m JOIN leagues l ON l.id = m.league_id WHERE m.id=$1`,
    [req.params.id]);
  if (!m) throw ApiError.notFound('Match not found');
  if (m.owner_coach_id !== req.user.id) throw ApiError.forbidden('Not your league');

  const params = [req.params.id];
  let teamFilter = '';
  if (req.query.teamId) {
    params.push(req.query.teamId);
    teamFilter = 'AND ps.team_id = $2';
  }
  const { rows } = await db.query(
    `SELECT ps.player_id AS "playerId", ps.team_id AS "teamId", ps.stats,
            ps.qo_points AS "qoPoints", ps.rating,
            pp.full_name AS "fullName", pp.player_code AS "playerCode"
     FROM player_stats ps
     JOIN player_profiles pp ON pp.user_id = ps.player_id
     WHERE ps.match_id = $1 ${teamFilter}`, params);
  ok(res, rows);
}));

// PATCH /matches/:id/result (coach records the outcome — feeds league standings)
matches.patch('/:id/result', requireRole('COACH'), validate({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    homeScore: z.string().max(30),
    awayScore: z.string().max(30),
    winnerTeamId: z.string().uuid().nullable().optional(), // null/omitted => draw
    resultSummary: z.string().max(160).optional(),
    status: z.enum(['LIVE', 'COMPLETED']).default('COMPLETED'),
  }),
}), asyncH(async (req, res) => {
  const { rows: [m] } = await db.query(
    `SELECT m.id, m.home_team_id, m.away_team_id, l.owner_coach_id
     FROM matches m JOIN leagues l ON l.id = m.league_id WHERE m.id=$1`, [req.params.id]);
  if (!m) throw ApiError.notFound('Match not found');
  if (m.owner_coach_id !== req.user.id) throw ApiError.forbidden('Not your league');
  const w = req.body.winnerTeamId ?? null;
  if (w && w !== m.home_team_id && w !== m.away_team_id) {
    throw ApiError.badRequest('winnerTeamId must be one of the two teams in this match');
  }
  const { rows: [row] } = await db.query(
    `UPDATE matches SET home_score=$2, away_score=$3, winner_team_id=$4,
            result_summary=COALESCE($5, result_summary), status=$6
     WHERE id=$1
     RETURNING id, status, home_score AS "homeScore", away_score AS "awayScore",
               winner_team_id AS "winnerTeamId", result_summary AS "resultSummary"`,
    [req.params.id, req.body.homeScore, req.body.awayScore, w, req.body.resultSummary || null, req.body.status]);
  ok(res, row);
}));

module.exports = { playbook, dugout, notifications, matches };
