const express = require('express');
const { z } = require('zod');
const db = require('../config/db');
const storage = require('../services/storage');
const { ok, created, asyncH, ApiError } = require('../utils/http');
const { authenticate, requireRole, validate } = require('../middleware');

const router = express.Router();
router.use(authenticate);
const uuid = z.object({ id: z.string().uuid() });

async function loadTeam(teamId) {
  const { rows: [t] } = await db.query(
    `SELECT t.*, l.owner_coach_id, l.id AS league_id FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id=$1`,
    [teamId]);
  if (!t) throw ApiError.notFound('Team not found');
  return t;
}

async function assertTeamAccess(req, team) {
  if (req.user.role === 'COACH') {
    if (team.owner_coach_id !== req.user.id) throw ApiError.forbidden('You do not manage this team');
    return;
  }
  const { rowCount } = await db.query(
    'SELECT 1 FROM league_memberships WHERE league_id=$1 AND player_id=$2', [team.league_id, req.user.id]);
  if (!rowCount) throw ApiError.forbidden('Join this league to view its teams');
}

// ---------------------------------------------------------------- GET /teams/:id/roster
router.get('/:id/roster', validate({ params: uuid }), asyncH(async (req, res) => {
  const team = await loadTeam(req.params.id);
  await assertTeamAccess(req, team);

  const { rows } = await db.query(
    `SELECT trm.id AS membership_id, trm.jersey_no, trm.position, trm.is_captain, trm.status,
            pp.user_id AS player_id, pp.player_code, pp.full_name, pp.qo_score, pp.avatar_key
     FROM team_roster_memberships trm
     JOIN player_profiles pp ON pp.user_id = trm.player_id
     WHERE trm.team_id = $1 AND trm.status <> 'LEFT'
     ORDER BY trm.is_captain DESC, pp.full_name`, [req.params.id]);

  ok(res, {
    team: {
      id: team.id, name: team.name, icon: team.icon_emoji,
      logoUrl: await storage.publicUrl(team.logo_key), leagueId: team.league_id,
    },
    roster: await Promise.all(rows.map(async (r) => ({
      membershipId: r.membership_id,
      playerId: r.player_id,
      playerCode: r.player_code,
      fullName: r.full_name,
      avatarUrl: await storage.publicUrl(r.avatar_key),
      qoScore: r.qo_score,
      jerseyNo: r.jersey_no,
      position: r.position,
      isCaptain: r.is_captain,
      status: r.status,
    }))),
  });
}));

// ---------------------------------------------------------------- GET /teams/:id/summary
router.get('/:id/summary', validate({ params: uuid }), asyncH(async (req, res) => {
  const team = await loadTeam(req.params.id);
  await assertTeamAccess(req, team);
  const { rows: [s] } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM team_roster_memberships WHERE team_id=$1 AND status='ACTIVE') AS roster,
       (SELECT COUNT(*) FROM matches WHERE (home_team_id=$1 OR away_team_id=$1) AND status='COMPLETED') AS played,
       (SELECT COUNT(*) FROM matches WHERE (home_team_id=$1 OR away_team_id=$1) AND status='SCHEDULED') AS upcoming,
       (SELECT COALESCE(AVG(pp.qo_score),0)::int FROM team_roster_memberships trm
          JOIN player_profiles pp ON pp.user_id=trm.player_id
          WHERE trm.team_id=$1 AND trm.status='ACTIVE') AS avg_qo`, [req.params.id]);
  ok(res, {
    teamId: team.id,
    name: team.name,
    rosterCount: Number(s.roster),
    matchesPlayed: Number(s.played),
    upcomingMatches: Number(s.upcoming),
    averageQoScore: Number(s.avg_qo),
  });
}));

// ---------------------------------------------------------------- POST /teams/:id/players (coach assigns player to roster)
router.post('/:id/players', requireRole('COACH'), validate({
  params: uuid,
  body: z.object({
    playerId: z.string().uuid(),
    jerseyNo: z.number().int().min(0).max(999).optional(),
    position: z.string().max(40).optional(),
    isCaptain: z.boolean().optional(),
  }),
}), asyncH(async (req, res) => {
  const team = await loadTeam(req.params.id);
  if (team.owner_coach_id !== req.user.id) throw ApiError.forbidden();

  const { rowCount: inLeague } = await db.query(
    'SELECT 1 FROM league_memberships WHERE league_id=$1 AND player_id=$2', [team.league_id, req.body.playerId]);
  if (!inLeague) throw ApiError.badRequest('Player must join the league first');

  const { rows: [m] } = await db.query(
    `INSERT INTO team_roster_memberships (team_id, player_id, jersey_no, position, is_captain)
     VALUES ($1,$2,$3,$4,COALESCE($5,false))
     ON CONFLICT (team_id, player_id)
       DO UPDATE SET status='ACTIVE', jersey_no=EXCLUDED.jersey_no, position=EXCLUDED.position, is_captain=EXCLUDED.is_captain
     RETURNING id`, [req.params.id, req.body.playerId, req.body.jerseyNo || null, req.body.position || null, req.body.isCaptain]);
  created(res, { membershipId: m.id });
}));

// ---------------------------------------------------------------- PATCH /teams/:id/players/:playerId/stats (coach)
// Upserts a per-match stat line and applies the Qo delta to the player's profile.
router.patch('/:id/players/:playerId/stats', requireRole('COACH'), validate({
  params: z.object({ id: z.string().uuid(), playerId: z.string().uuid() }),
  body: z.object({
    matchId: z.string().uuid(),
    stats: z.record(z.union([z.number(), z.string()])),   // {"runs":78,"wickets":1,"strikeRate":132.5}
    qoPoints: z.number().int().min(-500).max(500).default(0),
    rating: z.number().min(0).max(10).optional(),
  }),
}), asyncH(async (req, res) => {
  const team = await loadTeam(req.params.id);
  if (team.owner_coach_id !== req.user.id) throw ApiError.forbidden();

  const { matchId, stats, qoPoints, rating } = req.body;
  const { rows: [match] } = await db.query(
    'SELECT id FROM matches WHERE id=$1 AND (home_team_id=$2 OR away_team_id=$2)', [matchId, req.params.id]);
  if (!match) throw ApiError.badRequest('Match does not involve this team');

  const result = await db.tx(async (c) => {
    const { rows: [existing] } = await c.query(
      'SELECT id, qo_points FROM player_stats WHERE match_id=$1 AND player_id=$2 FOR UPDATE',
      [matchId, req.params.playerId]);

    let row;
    if (existing) {
      ({ rows: [row] } = await c.query(
        `UPDATE player_stats SET stats=$1, qo_points=$2, rating=$3, edited_by=$4
         WHERE id=$5 RETURNING *`,
        [JSON.stringify(stats), qoPoints, rating || null, req.user.id, existing.id]));
    } else {
      ({ rows: [row] } = await c.query(
        `INSERT INTO player_stats (match_id, player_id, team_id, stats, qo_points, rating, edited_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [matchId, req.params.playerId, req.params.id, JSON.stringify(stats), qoPoints, rating || null, req.user.id]));
    }

    // keep the profile Qo score consistent with the sum of match deltas
    const delta = qoPoints - (existing?.qo_points || 0);
    if (delta !== 0) {
      await c.query('UPDATE player_profiles SET qo_score = GREATEST(0, qo_score + $1) WHERE user_id=$2',
        [delta, req.params.playerId]);
      await c.query(
        `INSERT INTO notifications (user_id, type, title, body, emoji, data)
         VALUES ($1,'QO_POINTS','Qo Points Updated', $2, '⚡', jsonb_build_object('matchId',$3::text,'delta',$4::int))`,
        [req.params.playerId, `${delta > 0 ? '+' : ''}${delta} Qo points added to your profile`, matchId, delta]);
    }
    return row;
  });

  ok(res, {
    id: result.id, matchId: result.match_id, playerId: result.player_id,
    stats: result.stats, qoPoints: result.qo_points, rating: result.rating,
    updatedAt: result.updated_at,
  });
}));

module.exports = router;
