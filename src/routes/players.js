const express = require('express');
const { z } = require('zod');
const db = require('../config/db');
const storage = require('../services/storage');
const { ok, asyncH, ApiError, pagination, pageMeta } = require('../utils/http');
const { authenticate, requireRole, validate } = require('../middleware');

const router = express.Router();
router.use(authenticate);

const uuid = z.object({ id: z.string().uuid() });

/** Players may only read their own aggregate screens; coaches may read players in their leagues. */
async function assertCanViewPlayer(req, playerId) {
  if (req.user.role === 'PLAYER') {
    if (req.user.id !== playerId) throw ApiError.forbidden();
    return;
  }
  const { rowCount } = await db.query(
    `SELECT 1 FROM league_memberships lm
     JOIN leagues l ON l.id = lm.league_id
     WHERE lm.player_id = $1 AND l.owner_coach_id = $2 LIMIT 1`,
    [playerId, req.user.id],
  );
  if (!rowCount) throw ApiError.forbidden('This player is not in any of your leagues');
}

// NOTE: static paths ('/discover', '/') are registered BEFORE the '/:id/...'
// patterns so a future single-segment '/:id' route can never shadow them
// (a shadowed '/discover' surfaces in the app as a confusing 404).
// ---------------------------------------------------------------- GET /players/search  (coach: select-players screen)
// ---------------------------------------------------------------- GET /players/discover
// Leaderboard-style discovery for the Dugout screen. Any authenticated user.
// Only players who keep their profile public are listed.
router.get('/discover', asyncH(async (req, res) => {
  const { limit, offset, page } = pagination(req);
  const sport = (req.query.sport || '').trim();
  const q = (req.query.q || '').trim();
  const params = [];
  let where = `(pp.settings->>'publicProfile')::boolean IS DISTINCT FROM false`;
  if (sport) {
    params.push(sport);
    where += ` AND s.name ILIKE $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (pp.full_name ILIKE $${params.length} OR pp.player_code ILIKE $${params.length})`;
  }
  params.push(req.user.id);
  const meIdx = params.length;
  params.push(limit, offset);

  const { rows } = await db.query(
    `SELECT pp.user_id AS id, pp.full_name AS "fullName", pp.player_code AS "playerCode",
            pp.qo_score AS "qoScore", pp.school_academy AS academy, pp.location,
            pp.avatar_key, u.is_verified AS verified,
            s.name AS sport, s.emoji AS "sportEmoji",
            (SELECT COUNT(*) FROM follows f WHERE f.followee_id = pp.user_id) AS followers,
            EXISTS(SELECT 1 FROM follows f2 WHERE f2.follower_id = $${meIdx} AND f2.followee_id = pp.user_id) AS "isFollowing",
            EXISTS(SELECT 1 FROM recommendations rc WHERE rc.from_coach_id = $${meIdx} AND rc.player_id = pp.user_id) AS "isRecommended",
            (SELECT COUNT(*) FROM player_stats ps WHERE ps.player_id = pp.user_id) AS "matchesPlayed",
            COUNT(*) OVER() AS total
     FROM player_profiles pp
     JOIN users u ON u.id = pp.user_id
     LEFT JOIN sports s ON s.id = pp.primary_sport_id
     WHERE ${where}
     ORDER BY pp.qo_score DESC, pp.full_name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  const total = rows.length ? Number(rows[0].total) : 0;
  const data = [];
  for (const r of rows) {
    data.push({
      id: r.id,
      fullName: r.fullName,
      playerCode: r.playerCode,
      qoScore: r.qoScore,
      academy: r.academy,
      location: r.location,
      avatarUrl: await storage.publicUrl(r.avatar_key),
      verified: r.verified,
      sport: r.sport,
      sportEmoji: r.sportEmoji,
      followers: Number(r.followers),
      isFollowing: r.isFollowing === true,
      isRecommended: r.isRecommended === true,
      matchesPlayed: Number(r.matchesPlayed),
    });
  }
  ok(res, data, pageMeta(page, limit, total));
}));

// ---------------------------------------------------------------- GET /players (coach: select-players screen)
router.get('/', requireRole('COACH'), asyncH(async (req, res) => {
  const { limit, offset, page } = pagination(req);
  const q = (req.query.q || '').trim();
  const params = [req.user.id];
  let where = `l.owner_coach_id = $1`;
  if (q) { params.push(`%${q}%`); where += ` AND (pp.full_name ILIKE $${params.length} OR pp.player_code ILIKE $${params.length})`; }
  params.push(limit, offset);

  const { rows } = await db.query(
    `SELECT DISTINCT ON (pp.user_id)
            pp.user_id AS id, pp.player_code AS "playerId", pp.full_name AS "fullName",
            pp.qo_score AS "qoScore", pp.avatar_key,
            s.emoji AS "sportEmoji", s.name AS "sportName",
            t.name AS "teamName", trm.position, trm.status AS roster_status,
            lm.joined_at AS "joinedAt",
            EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = pp.user_id) AS "isFollowing",
            EXISTS(SELECT 1 FROM recommendations rc WHERE rc.from_coach_id = $1 AND rc.player_id = pp.user_id) AS "isRecommended",
            (SELECT COUNT(*) FROM follows f2 WHERE f2.followee_id = pp.user_id) AS followers,
            COUNT(*) OVER() AS total
     FROM player_profiles pp
     JOIN league_memberships lm ON lm.player_id = pp.user_id
     JOIN leagues l ON l.id = lm.league_id
     LEFT JOIN sports s ON s.id = pp.primary_sport_id
     LEFT JOIN team_roster_memberships trm
            ON trm.player_id = pp.user_id AND trm.status = 'ACTIVE'
     LEFT JOIN teams t ON t.id = trm.team_id AND t.league_id = lm.league_id
     WHERE ${where}
     ORDER BY pp.user_id, t.name NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  const data = await Promise.all(rows.map(async (r) => ({
    id: r.id, playerId: r.playerId, fullName: r.fullName, qoScore: r.qoScore,
    avatarUrl: await storage.publicUrl(r.avatar_key),
    sportEmoji: r.sportEmoji, sportName: r.sportName,
    teamName: r.teamName, position: r.position,
    onTeam: r.roster_status === 'ACTIVE',
    isFollowing: r.isFollowing === true,
    isRecommended: r.isRecommended === true,
    followers: Number(r.followers || 0),
    joinedAt: r.joinedAt,
  })));
  ok(res, data, pageMeta(page, limit, rows[0]?.total || 0));
}));


// ---------------------------------------------------------------- GET /players/:id/home
router.get('/:id/home', validate({ params: uuid }), asyncH(async (req, res) => {
  const playerId = req.params.id;
  await assertCanViewPlayer(req, playerId);

  const [{ rows: [p] }, { rows: [membership] }, { rows: [nextMatch] }, { rows: notifications }, { rows: [counts] }] =
    await Promise.all([
      db.query(
        `SELECT pp.player_code, pp.full_name, pp.qo_score, pp.avatar_key,
                s.id AS sport_id, s.name AS sport_name, s.emoji AS sport_emoji
         FROM player_profiles pp LEFT JOIN sports s ON s.id = pp.primary_sport_id
         WHERE pp.user_id = $1`, [playerId]),
      db.query(
        `SELECT l.id AS league_id, l.name AS league_name, l.icon_emoji, l.logo_key, l.gender, l.season,
                t.id AS team_id, t.name AS team_name, t.icon_emoji AS team_emoji
         FROM league_memberships lm
         JOIN leagues l ON l.id = lm.league_id AND l.status = 'ACTIVE'
         LEFT JOIN team_roster_memberships trm
                ON trm.player_id = lm.player_id AND trm.status = 'ACTIVE'
         LEFT JOIN teams t ON t.id = trm.team_id AND t.league_id = l.id
         WHERE lm.player_id = $1
         ORDER BY lm.joined_at DESC LIMIT 1`, [playerId]),
      db.query(
        `SELECT m.id, m.scheduled_at, m.venue,
                ht.name AS home_team, ht.icon_emoji AS home_emoji,
                at.name AS away_team, at.icon_emoji AS away_emoji
         FROM matches m
         JOIN teams ht ON ht.id = m.home_team_id
         JOIN teams at ON at.id = m.away_team_id
         WHERE m.status = 'SCHEDULED' AND m.scheduled_at > now()
           AND (m.home_team_id IN (SELECT team_id FROM team_roster_memberships WHERE player_id=$1 AND status='ACTIVE')
             OR m.away_team_id IN (SELECT team_id FROM team_roster_memberships WHERE player_id=$1 AND status='ACTIVE'))
         ORDER BY m.scheduled_at ASC LIMIT 1`, [playerId]),
      db.query(
        `SELECT id, type, title, body, emoji, is_read AS "isRead", created_at AS "createdAt"
         FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`, [playerId]),
      db.query(
        `SELECT COUNT(*) FILTER (WHERE NOT is_read) AS unread FROM notifications WHERE user_id = $1`, [playerId]),
    ]);

  if (!p) throw ApiError.notFound('Player not found');

  ok(res, {
    greeting: `Hi, ${p.full_name.split(' ')[0]}!`,
    player: {
      id: playerId,
      playerId: p.player_code,
      fullName: p.full_name,
      avatarUrl: await storage.publicUrl(p.avatar_key),
      qoScore: p.qo_score,
      sport: p.sport_id ? { id: p.sport_id, name: p.sport_name, emoji: p.sport_emoji } : null,
    },
    activeLeague: membership ? {
      id: membership.league_id,
      name: membership.league_name,          // e.g. "Falcons U16 Premier League"
      icon: membership.icon_emoji,
      logoUrl: await storage.publicUrl(membership.logo_key),
      gender: membership.gender,
      season: membership.season,
      team: membership.team_id
        ? { id: membership.team_id, name: membership.team_name, icon: membership.team_emoji }
        : null,                              // frontend falls back to "Not in a team"
    } : null,                                // frontend falls back to "Join a league to get started"
    upcomingMatch: nextMatch ? {
      id: nextMatch.id,
      scheduledAt: nextMatch.scheduled_at,
      venue: nextMatch.venue,
      homeTeam: { name: nextMatch.home_team, icon: nextMatch.home_emoji },
      awayTeam: { name: nextMatch.away_team, icon: nextMatch.away_emoji },
    } : null,
    notifications: { unreadCount: Number(counts.unread), recent: notifications },
  });
}));

// ---------------------------------------------------------------- GET /players/:id/profile
router.get('/:id/profile', validate({ params: uuid }), asyncH(async (req, res) => {
  const playerId = req.params.id;
  await assertCanViewPlayer(req, playerId);

  const [{ rows: [p] }, { rows: history }, { rows: recs }, { rows: [social] }] = await Promise.all([
    db.query(
      `SELECT pp.*, u.email, u.phone, u.is_verified, s.name AS sport_name, s.emoji AS sport_emoji
       FROM player_profiles pp
       JOIN users u ON u.id = pp.user_id
       LEFT JOIN sports s ON s.id = pp.primary_sport_id
       WHERE pp.user_id = $1`, [playerId]),
    db.query(`SELECT id, academy, role, start_year AS "startYear", end_year AS "endYear"
              FROM academy_history WHERE player_id=$1 ORDER BY start_year DESC NULLS LAST`, [playerId]),
    db.query(`SELECT r.id, r.text, r.created_at AS "createdAt", cp.full_name AS "coachName", cp.title AS "coachTitle"
              FROM recommendations r JOIN coach_profiles cp ON cp.user_id = r.from_coach_id
              WHERE r.player_id=$1 ORDER BY r.created_at DESC`, [playerId]),
    db.query(`SELECT
                (SELECT COUNT(*) FROM follows WHERE followee_id=$1) AS followers,
                (SELECT COUNT(*) FROM follows WHERE follower_id=$1) AS following`, [playerId]),
  ]);
  if (!p) throw ApiError.notFound('Player not found');

  ok(res, {
    id: playerId,
    playerId: p.player_code,
    fullName: p.full_name,
    isVerified: p.is_verified === true,
    avatarUrl: await storage.publicUrl(p.avatar_key),
    dob: p.dob,
    gender: p.gender,
    location: p.location,
    schoolAcademy: p.school_academy,
    club: p.club,
    bio: p.bio,
    qoScore: p.qo_score,
    sport: p.sport_name ? { name: p.sport_name, emoji: p.sport_emoji } : null,
    followers: Number(social.followers),
    following: Number(social.following),
    academyHistory: history,
    recommendations: recs,
    settings: p.settings,
  });
}));

// ---------------------------------------------------------------- GET /players/:id/performance
// Powers the performance screen: Qo score, Qo Journey chart, recent match cards.
router.get('/:id/performance', validate({ params: uuid }), asyncH(async (req, res) => {
  const playerId = req.params.id;
  await assertCanViewPlayer(req, playerId);

  const [{ rows: [p] }, { rows: journey }, { rows: recent }, { rows: [rank] }] = await Promise.all([
    db.query('SELECT qo_score FROM player_profiles WHERE user_id=$1', [playerId]),
    db.query(
      `SELECT to_char(period, 'Mon') AS label, period, qo_score AS "qoScore", matches_played AS "matchesPlayed", aggregates
       FROM performance_metrics WHERE player_id=$1 ORDER BY period ASC LIMIT 12`, [playerId]),
    db.query(
      `SELECT ps.id, ps.stats, ps.qo_points AS "qoPoints", ps.rating,
              m.id AS "matchId", m.scheduled_at AS "playedAt", m.result_summary AS "resultSummary",
              myt.name AS "teamName",
              CASE WHEN m.home_team_id = ps.team_id THEN at.name ELSE ht.name END AS opponent
       FROM player_stats ps
       JOIN matches m ON m.id = ps.match_id
       JOIN teams myt ON myt.id = ps.team_id
       JOIN teams ht ON ht.id = m.home_team_id
       JOIN teams at ON at.id = m.away_team_id
       WHERE ps.player_id = $1 AND m.status = 'COMPLETED'
       ORDER BY m.scheduled_at DESC LIMIT 10`, [playerId]),
    // Rank among all players of the leagues this player belongs to
    db.query(
      `WITH my_leagues AS (SELECT league_id FROM league_memberships WHERE player_id = $1),
            peers AS (SELECT DISTINCT lm.player_id, pp.qo_score
                      FROM league_memberships lm
                      JOIN player_profiles pp ON pp.user_id = lm.player_id
                      WHERE lm.league_id IN (SELECT league_id FROM my_leagues))
       SELECT (SELECT COUNT(*) + 1 FROM peers
               WHERE qo_score > (SELECT qo_score FROM player_profiles WHERE user_id = $1)) AS position,
              (SELECT COUNT(*) FROM peers) AS total`, [playerId]),
  ]);
  if (!p) throw ApiError.notFound('Player not found');

  const totalPeers = Number(rank?.total || 0);
  ok(res, {
    qoScore: p.qo_score,
    ranking: totalPeers > 0
      ? { position: Number(rank.position), totalPlayers: totalPeers }
      : null,
    qoJourney: journey,          // [{label:'Jan', qoScore: 640, ...}]
    recentMatches: recent.map((r) => ({
      id: r.id,
      matchId: r.matchId,
      opponent: `vs ${r.opponent}`,   // matches the 'vs Thunder Strikers' card
      playedAt: r.playedAt,
      resultSummary: r.resultSummary,
      stats: r.stats,                 // {"runs":78,"wickets":1,...}
      qoPoints: r.qoPoints,
      rating: r.rating,
    })),
  });
}));




// ---------------------------------------------------------------- POST /players/:id/follow
router.post('/:id/follow', validate({ params: uuid }), asyncH(async (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id) throw ApiError.badRequest('You cannot follow yourself');
  const { rowCount } = await db.query('SELECT 1 FROM player_profiles WHERE user_id=$1', [targetId]);
  if (!rowCount) throw ApiError.notFound('Player not found');
  await db.query(
    `INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)
     ON CONFLICT (follower_id, followee_id) DO NOTHING`, [req.user.id, targetId]);
  ok(res, { following: true });
}));

// ---------------------------------------------------------------- DELETE /players/:id/follow
router.delete('/:id/follow', validate({ params: uuid }), asyncH(async (req, res) => {
  await db.query('DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2', [req.user.id, req.params.id]);
  ok(res, { following: false });
}));

// ---------------------------------------------------------------- POST /players/:id/recommend
// "Recommend Players": a coach recommends a player to clubs & leagues.
// Recorded in `recommendations` (one row per coach/player pair; repeat calls
// refresh it) and the player is notified the first time a given coach
// recommends them.
router.post('/:id/recommend', requireRole('COACH'), validate({
  params: uuid,
  body: z.object({ note: z.string().max(300).optional() }).optional(),
}), asyncH(async (req, res) => {
  const playerId = req.params.id;
  const { rows: [player] } = await db.query(
    'SELECT full_name FROM player_profiles WHERE user_id=$1', [playerId]);
  if (!player) throw ApiError.notFound('Player not found');
  const { rows: [coach] } = await db.query(
    'SELECT full_name FROM coach_profiles WHERE user_id=$1', [req.user.id]);

  // `text` is what the player profile screen shows under "Recommendations".
  const text = (req.body?.note || '').trim()
    || `Recommended to clubs & leagues by Coach ${coach?.full_name || ''}`.trim();

  const { rows: [rec] } = await db.query(
    `INSERT INTO recommendations (player_id, from_coach_id, text) VALUES ($1,$2,$3)
     ON CONFLICT (player_id, from_coach_id)
       DO UPDATE SET text = EXCLUDED.text, created_at = now()
     RETURNING (xmax = 0) AS inserted`, [playerId, req.user.id, text]);

  if (rec.inserted) {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, body, emoji, data)
       VALUES ($1,'SOCIAL',$2,$3,$4,$5)`,
      [playerId,
       'You got recommended! 🌟',
       `Coach ${coach?.full_name || 'A coach'} recommended you to clubs & leagues.`,
       '🌟',
       JSON.stringify({ kind: 'RECOMMENDATION', coachId: req.user.id })]);
  }
  ok(res, { recommended: true, alreadyRecommended: !rec.inserted });
}));

module.exports = router;
