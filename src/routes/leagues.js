const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const db = require('../config/db');
const storage = require('../services/storage');
const { ok, created, asyncH, ApiError, pagination, pageMeta } = require('../utils/http');
const { authenticate, requireRole, validate } = require('../middleware');
const { newLeagueCode, generateUnique } = require('../utils/codes');

const router = express.Router();
router.use(authenticate);
const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) return cb(null, true);
    cb(ApiError.badRequest('Only PNG, JPG or WEBP images are allowed'));
  },
});
const uuid = z.object({ id: z.string().uuid() });

const genderMap = { "Men's": 'MENS', "Women's": 'WOMENS', Mixed: 'MIXED', MENS: 'MENS', WOMENS: 'WOMENS', MIXED: 'MIXED' };

async function assertLeagueOwner(leagueId, coachId) {
  const { rows: [l] } = await db.query('SELECT id, owner_coach_id FROM leagues WHERE id=$1', [leagueId]);
  if (!l) throw ApiError.notFound('League not found');
  if (l.owner_coach_id !== coachId) throw ApiError.forbidden('You do not own this league');
  return l;
}

async function issueCode(client, leagueId) {
  const code = await generateUnique(newLeagueCode, async (c) => {
    const { rowCount } = await client.query('SELECT 1 FROM league_codes WHERE code=$1 AND is_active', [c]);
    return rowCount > 0;
  });
  const { rows: [row] } = await client.query(
    `INSERT INTO league_codes (league_id, code) VALUES ($1,$2) RETURNING id, code, created_at`,
    [leagueId, code],
  );
  return row;
}

// ---------------------------------------------------------------- POST /leagues (coach)
// multipart/form-data: payload (JSON string) + logo (file, optional) + teamLogo_0..n (optional)
const createLeagueSchema = z.object({
  name: z.string().min(3).max(100),
  location: z.string().max(120).optional(),
  gender: z.string().transform((g) => genderMap[g] || 'MENS'),
  sportId: z.string().uuid(),
  iconEmoji: z.string().max(8).optional(),
  season: z.string().max(60).optional(),
  teams: z.array(z.object({
    name: z.string().min(1).max(60),
    iconEmoji: z.string().max(8).optional(),
  })).min(2, 'A league needs at least 2 teams').max(32),
});

router.post('/', requireRole('COACH'), uploadMw.any(), asyncH(async (req, res) => {
  let payload;
  try { payload = createLeagueSchema.parse(JSON.parse(req.body.payload || '{}')); }
  catch (e) { throw ApiError.badRequest('Invalid league payload', e.errors); }

  const files = Object.fromEntries((req.files || []).map((f) => [f.fieldname, f]));
  const logoKey = files.logo ? await storage.upload('league-logos', files.logo) : null;

  const result = await db.tx(async (c) => {
    const { rows: [league] } = await c.query(
      `INSERT INTO leagues (owner_coach_id, sport_id, name, location, gender, icon_emoji, logo_key, season)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, payload.sportId, payload.name, payload.location || null,
       payload.gender, payload.iconEmoji || null, logoKey, payload.season || null],
    );

    const teams = [];
    for (let i = 0; i < payload.teams.length; i++) {
      const t = payload.teams[i];
      const teamLogoKey = files[`teamLogo_${i}`] ? await storage.upload('team-logos', files[`teamLogo_${i}`]) : null;
      const { rows: [team] } = await c.query(
        `INSERT INTO teams (league_id, name, icon_emoji, logo_key) VALUES ($1,$2,$3,$4)
         RETURNING id, name, icon_emoji AS "icon", logo_key`,
        [league.id, t.name, t.iconEmoji || null, teamLogoKey],
      );
      teams.push(team);
    }

    const code = await issueCode(c, league.id);
    return { league, teams, code };
  });

  created(res, {
    id: result.league.id,
    name: result.league.name,
    location: result.league.location,
    gender: result.league.gender,
    icon: result.league.icon_emoji,
    logoUrl: await storage.publicUrl(result.league.logo_key),
    season: result.league.season,
    status: result.league.status,
    teams: await Promise.all(result.teams.map(async (t) => ({
      id: t.id, name: t.name, icon: t.icon, logoUrl: await storage.publicUrl(t.logo_key),
    }))),
    leagueCode: result.code.code,     // feeds the "share league code" screen
    createdAt: result.league.created_at,
  });
}));

// ---------------------------------------------------------------- POST /leagues/join (player)
router.post('/join', requireRole('PLAYER'), validate({
  body: z.object({ code: z.string().regex(/^\d{6}$/, 'League code is 6 digits') }),
}), asyncH(async (req, res) => {
  const result = await db.tx(async (c) => {
    const { rows: [codeRow] } = await c.query(
      `SELECT lc.id, lc.league_id, lc.max_uses, lc.use_count, l.name, l.status
       FROM league_codes lc JOIN leagues l ON l.id = lc.league_id
       WHERE lc.code = $1 AND lc.is_active AND lc.revoked_at IS NULL
         AND (lc.expires_at IS NULL OR lc.expires_at > now())
       FOR UPDATE`, [req.body.code]);
    if (!codeRow) throw ApiError.badRequest('Invalid or expired league code');
    if (codeRow.status !== 'ACTIVE') throw ApiError.badRequest('This league is not accepting players right now');
    if (codeRow.max_uses && codeRow.use_count >= codeRow.max_uses) throw ApiError.badRequest('This league code has reached its limit');

    const { rowCount: already } = await c.query(
      'SELECT 1 FROM league_memberships WHERE league_id=$1 AND player_id=$2', [codeRow.league_id, req.user.id]);
    if (already) throw ApiError.conflict('You have already joined this league');

    await c.query(
      'INSERT INTO league_memberships (league_id, player_id, joined_via) VALUES ($1,$2,$3)',
      [codeRow.league_id, req.user.id, codeRow.id]);
    await c.query('UPDATE league_codes SET use_count = use_count + 1 WHERE id=$1', [codeRow.id]);

    // notify the coach
    await c.query(
      `INSERT INTO notifications (user_id, type, title, body, emoji, data)
       SELECT l.owner_coach_id, 'LEAGUE_UPDATE', 'New player joined',
              pp.full_name || ' joined ' || l.name, '🎉',
              jsonb_build_object('leagueId', l.id, 'playerId', pp.user_id)
       FROM leagues l, player_profiles pp
       WHERE l.id = $1 AND pp.user_id = $2::uuid`, [codeRow.league_id, req.user.id]);

    return codeRow;
  });

  ok(res, { joined: true, league: { id: result.league_id, name: result.name } });
}));

// ---------------------------------------------------------------- GET /leagues/:id
router.get('/:id', validate({ params: uuid }), asyncH(async (req, res) => {
  const { rows: [l] } = await db.query(
    `SELECT l.*, s.name AS sport_name, s.emoji AS sport_emoji,
            cp.full_name AS coach_name,
            (SELECT COUNT(*) FROM teams t WHERE t.league_id = l.id) AS team_count,
            (SELECT COUNT(*) FROM league_memberships lm WHERE lm.league_id = l.id) AS player_count,
            (SELECT COUNT(*) FROM matches m WHERE m.league_id = l.id AND m.status='COMPLETED') AS matches_played
     FROM leagues l
     JOIN sports s ON s.id = l.sport_id
     JOIN coach_profiles cp ON cp.user_id = l.owner_coach_id
     WHERE l.id = $1`, [req.params.id]);
  if (!l) throw ApiError.notFound('League not found');

  // access: owner coach, or player who is a member
  if (req.user.role === 'COACH' && l.owner_coach_id !== req.user.id) throw ApiError.forbidden();
  if (req.user.role === 'PLAYER') {
    const { rowCount } = await db.query('SELECT 1 FROM league_memberships WHERE league_id=$1 AND player_id=$2', [l.id, req.user.id]);
    if (!rowCount) throw ApiError.forbidden('Join this league to view it');
  }

  ok(res, {
    id: l.id,
    name: l.name,
    location: l.location,
    gender: l.gender,
    icon: l.icon_emoji,
    logoUrl: await storage.publicUrl(l.logo_key),
    season: l.season,
    status: l.status,
    sport: { name: l.sport_name, emoji: l.sport_emoji },
    coach: { name: l.coach_name },
    counts: { teams: Number(l.team_count), players: Number(l.player_count), matchesPlayed: Number(l.matches_played) },
    createdAt: l.created_at,
  });
}));

// ---------------------------------------------------------------- GET /leagues/:id/teams
router.get('/:id/teams', validate({ params: uuid }), asyncH(async (req, res) => {
  const { rows: [lg] } = await db.query('SELECT id, owner_coach_id FROM leagues WHERE id=$1', [req.params.id]);
  if (!lg) throw ApiError.notFound('League not found');
  if (req.user.role === 'COACH' && lg.owner_coach_id !== req.user.id) throw ApiError.forbidden();
  if (req.user.role === 'PLAYER') {
    const { rowCount } = await db.query(
      'SELECT 1 FROM league_memberships WHERE league_id=$1 AND player_id=$2', [lg.id, req.user.id]);
    if (!rowCount) throw ApiError.forbidden('Join this league to view its teams');
  }
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.icon_emoji AS icon, t.logo_key,
            COUNT(trm.id) FILTER (WHERE trm.status='ACTIVE') AS roster_count
     FROM teams t
     LEFT JOIN team_roster_memberships trm ON trm.team_id = t.id
     WHERE t.league_id = $1
     GROUP BY t.id ORDER BY t.name`, [req.params.id]);
  ok(res, await Promise.all(rows.map(async (t) => ({
    id: t.id, name: t.name, icon: t.icon,
    logoUrl: await storage.publicUrl(t.logo_key),
    rosterCount: Number(t.roster_count),
  }))));
}));

// ---------------------------------------------------------------- GET /leagues/:id/standings
router.get('/:id/standings', validate({ params: uuid }), asyncH(async (req, res) => {
  const { rows: [l] } = await db.query('SELECT id, owner_coach_id FROM leagues WHERE id=$1', [req.params.id]);
  if (!l) throw ApiError.notFound('League not found');
  if (req.user.role === 'COACH' && l.owner_coach_id !== req.user.id) throw ApiError.forbidden();
  if (req.user.role === 'PLAYER') {
    const { rowCount } = await db.query('SELECT 1 FROM league_memberships WHERE league_id=$1 AND player_id=$2', [l.id, req.user.id]);
    if (!rowCount) throw ApiError.forbidden('Join this league to view it');
  }

  const { rows } = await db.query(
    `SELECT t.id, t.name, t.icon_emoji, t.logo_key,
            COUNT(m.id) AS played,
            COUNT(m.id) FILTER (WHERE m.winner_team_id = t.id) AS wins,
            COUNT(m.id) FILTER (WHERE m.winner_team_id IS NOT NULL AND m.winner_team_id <> t.id) AS losses,
            COUNT(m.id) FILTER (WHERE m.winner_team_id IS NULL) AS draws
     FROM teams t
     LEFT JOIN matches m ON m.league_id = t.league_id AND m.status = 'COMPLETED'
                        AND (m.home_team_id = t.id OR m.away_team_id = t.id)
     WHERE t.league_id = $1
     GROUP BY t.id
     ORDER BY (COUNT(m.id) FILTER (WHERE m.winner_team_id = t.id)) DESC, t.name ASC`,
    [req.params.id]);

  const data = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    data.push({
      rank: i + 1,
      teamId: r.id,
      name: r.name,
      icon: r.icon_emoji,
      logoUrl: await storage.publicUrl(r.logo_key),
      played: Number(r.played),
      wins: Number(r.wins),
      losses: Number(r.losses),
      draws: Number(r.draws),
      points: Number(r.wins) * 2 + Number(r.draws),
    });
  }
  ok(res, data);
}));

// ---------------------------------------------------------------- code management (coach, owner only)
// GET /leagues/:id/code — current active code
router.get('/:id/code', requireRole('COACH'), validate({ params: uuid }), asyncH(async (req, res) => {
  await assertLeagueOwner(req.params.id, req.user.id);
  const { rows: [code] } = await db.query(
    `SELECT code, use_count AS "useCount", max_uses AS "maxUses", expires_at AS "expiresAt", created_at AS "createdAt"
     FROM league_codes WHERE league_id=$1 AND is_active ORDER BY created_at DESC LIMIT 1`, [req.params.id]);
  if (!code) throw ApiError.notFound('No active code — rotate to create one');
  ok(res, code);
}));

// POST /leagues/:id/code/rotate — revoke current, issue new (revocable codes)
router.post('/:id/code/rotate', requireRole('COACH'), validate({ params: uuid }), asyncH(async (req, res) => {
  await assertLeagueOwner(req.params.id, req.user.id);
  const row = await db.tx(async (c) => {
    await c.query('UPDATE league_codes SET is_active=FALSE, revoked_at=now() WHERE league_id=$1 AND is_active', [req.params.id]);
    return issueCode(c, req.params.id);
  });
  ok(res, { code: row.code, createdAt: row.created_at });
}));

// POST /leagues/:id/share — returns share payload for the share-sheet on the share-code screen
router.post('/:id/share', requireRole('COACH'), validate({ params: uuid }), asyncH(async (req, res) => {
  await assertLeagueOwner(req.params.id, req.user.id);
  const { rows: [row] } = await db.query(
    `SELECT l.name, lc.code FROM leagues l
     JOIN league_codes lc ON lc.league_id = l.id AND lc.is_active
     WHERE l.id = $1 ORDER BY lc.created_at DESC LIMIT 1`, [req.params.id]);
  if (!row) throw ApiError.notFound('No active code for this league');
  ok(res, {
    code: row.code,
    message: `Join my league "${row.name}" on SportyQo! Use code ${row.code} in the app.`,
    deepLink: `sportyqo://join?code=${row.code}`,
  });
}));

// ---------------------------------------------------------------- GET /leagues (mine)
router.get('/', asyncH(async (req, res) => {
  const { limit, offset, page } = pagination(req);
  const isCoach = req.user.role === 'COACH';
  const { rows } = await db.query(
    isCoach
      ? `SELECT l.*, s.emoji AS sport_emoji, COUNT(*) OVER() AS total,
                (SELECT COUNT(*) FROM league_memberships lm WHERE lm.league_id=l.id) AS players,
                (SELECT COUNT(*) FROM teams t WHERE t.league_id=l.id) AS teams
         FROM leagues l JOIN sports s ON s.id=l.sport_id
         WHERE l.owner_coach_id = $1 ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`
      : `SELECT l.*, s.emoji AS sport_emoji, COUNT(*) OVER() AS total,
                (SELECT COUNT(*) FROM league_memberships lm2 WHERE lm2.league_id=l.id) AS players,
                (SELECT COUNT(*) FROM teams t WHERE t.league_id=l.id) AS teams
         FROM league_memberships lm
         JOIN leagues l ON l.id = lm.league_id
         JOIN sports s ON s.id = l.sport_id
         WHERE lm.player_id = $1 ORDER BY lm.joined_at DESC LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]);

  const data = await Promise.all(rows.map(async (l) => ({
    id: l.id, name: l.name, location: l.location, gender: l.gender,
    icon: l.icon_emoji, sportEmoji: l.sport_emoji,
    logoUrl: await storage.publicUrl(l.logo_key),
    status: l.status, season: l.season,
    counts: { players: Number(l.players), teams: Number(l.teams) },
    createdAt: l.created_at,
  })));
  ok(res, data, pageMeta(page, limit, rows[0]?.total || 0));
}));

module.exports = router;
