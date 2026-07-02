-- Seed data that matches the frontend's current mock content.
-- All demo accounts share the password: Password@123
-- bcrypt hash generated with cost 12:
--   $2a$12$Cq0v0F0oQ8N4mJH3o0y2eO0m2pQ6cW7Wm6i0F5m9m3o8i7f2r7oG6  <-- replaced below by literal hash

DO $$
DECLARE
  pw TEXT := '$2a$12$OPHFzoSbNwYJuUI.OMdLiOgD62me6roRqqTz8JmxKEixU/WtkGu3C'; -- Password@123
  s_cricket UUID; s_football UUID;
  u_coach UUID; u_arjun UUID; u_rahul UUID; u_vikram UUID; u_jason UUID;
  league_id UUID; code_id UUID;
  t_falcons UUID; t_thunder UUID; t_alpha UUID; t_royal UUID;
  m_past UUID; m_past2 UUID; m_next UUID;
  thread_id UUID;
BEGIN

-- ---------------------------------------------------------------- sports (select-sport screen)
INSERT INTO sports (slug, name, emoji, sort_order) VALUES
  ('cricket',    'Cricket',    '🏏', 1),
  ('football',   'Football',   '⚽', 2),
  ('volleyball', 'Volleyball', '🏐', 3),
  ('basketball', 'Basketball', '🏀', 4),
  ('hockey',     'Hockey',     '🏑', 5),
  ('badminton',  'Badminton',  '🏸', 6),
  ('tennis',     'Tennis',     '🎾', 7),
  ('kabaddi',    'Kabaddi',    '🤼', 8)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO s_cricket  FROM sports WHERE slug='cricket';
SELECT id INTO s_football FROM sports WHERE slug='football';

IF EXISTS (SELECT 1 FROM users WHERE email='coach.suneeth@sportyqo.dev') THEN
  RAISE NOTICE 'Seed already applied, skipping';
  RETURN;
END IF;

-- ---------------------------------------------------------------- coach: "Coach Suneeth", Falcons Cricket Academy
INSERT INTO users (role, email, phone, password_hash, is_verified)
VALUES ('COACH', 'coach.suneeth@sportyqo.dev', '+919900000001', pw, TRUE)
RETURNING id INTO u_coach;
INSERT INTO coach_profiles (user_id, coach_code, full_name, title, academy, location, primary_sport_id, years_experience, is_verified_coach)
VALUES (u_coach, 'SQC2026100001', 'Coach Suneeth', 'Head Coach', 'Falcons Cricket Academy', 'Bangalore, Karnataka', s_cricket, 12, TRUE);

INSERT INTO coach_certifications (coach_id, title, issuer, issued_on, status, reviewed_at) VALUES
  (u_coach, 'BCCI Level 2 Coaching Certificate', 'BCCI', '2021-06-15', 'APPROVED', now()),
  (u_coach, 'Strength & Conditioning — Level 1', 'NSCA', '2023-02-01', 'APPROVED', now());

-- ---------------------------------------------------------------- players
INSERT INTO users (role, email, phone, password_hash, is_verified)
VALUES ('PLAYER', 'arjun@sportyqo.dev', '+919900000002', pw, TRUE) RETURNING id INTO u_arjun;
INSERT INTO player_profiles (user_id, player_code, full_name, dob, gender, location, school_academy, club, primary_sport_id, qo_score, bio)
VALUES (u_arjun, 'SQP2026100002', 'Arjun Mehta', '2010-04-12', 'MALE', 'Bangalore, Karnataka',
        'Falcons Cricket Academy', 'Falcons FC', s_cricket, 742, 'Top-order batsman. Chasing a 800 Qo score this season.');

INSERT INTO users (role, email, phone, password_hash, is_verified)
VALUES ('PLAYER', 'rahul@sportyqo.dev', '+919900000003', pw, TRUE) RETURNING id INTO u_rahul;
INSERT INTO player_profiles (user_id, player_code, full_name, dob, gender, location, school_academy, primary_sport_id, qo_score)
VALUES (u_rahul, 'SQP2026100003', 'Rahul Iyer', '2010-09-30', 'MALE', 'Bangalore, Karnataka', 'Falcons Cricket Academy', s_cricket, 615);

INSERT INTO users (role, email, phone, password_hash, is_verified)
VALUES ('PLAYER', 'vikram@sportyqo.dev', '+919900000004', pw, TRUE) RETURNING id INTO u_vikram;
INSERT INTO player_profiles (user_id, player_code, full_name, dob, gender, location, school_academy, primary_sport_id, qo_score)
VALUES (u_vikram, 'SQP2026100004', 'Vikram Rao', '2011-01-22', 'MALE', 'Mysuru, Karnataka', 'Falcons Cricket Academy', s_cricket, 580);

INSERT INTO users (role, email, phone, password_hash, is_verified)
VALUES ('PLAYER', 'jason@sportyqo.dev', '+919900000005', pw, TRUE) RETURNING id INTO u_jason;
INSERT INTO player_profiles (user_id, player_code, full_name, dob, gender, location, primary_sport_id, qo_score)
VALUES (u_jason, 'SQP2026100005', 'Jason Dsouza', '2010-11-05', 'MALE', 'Bangalore, Karnataka', s_cricket, 690);

-- academy history + recommendation (player profile screen)
INSERT INTO academy_history (player_id, academy, role, start_year, end_year) VALUES
  (u_arjun, 'Falcons Cricket Academy', 'Top-order Batsman', 2023, NULL),
  (u_arjun, 'Sunrise Sports School', 'Junior Squad', 2020, 2023);
INSERT INTO recommendations (player_id, from_coach_id, text) VALUES
  (u_arjun, u_coach, 'Arjun is one of the most consistent U16 batsmen I have coached. Excellent temperament under pressure.');
INSERT INTO follows (follower_id, followee_id) VALUES
  (u_jason, u_arjun), (u_rahul, u_arjun), (u_vikram, u_arjun), (u_arjun, u_jason);

-- ---------------------------------------------------------------- league: "Falcons U16 Premier League"
INSERT INTO leagues (owner_coach_id, sport_id, name, location, gender, icon_emoji, season)
VALUES (u_coach, s_cricket, 'Falcons U16 Premier League', 'Bangalore, Karnataka', 'MENS', '🏆', 'Summer League 2024')
RETURNING id INTO league_id;

INSERT INTO league_codes (league_id, code) VALUES (league_id, '482913') RETURNING id INTO code_id;

INSERT INTO teams (league_id, name, icon_emoji) VALUES (league_id, 'Falcons FC', '🦅') RETURNING id INTO t_falcons;
INSERT INTO teams (league_id, name, icon_emoji) VALUES (league_id, 'Thunder Strikers', '⚡') RETURNING id INTO t_thunder;
INSERT INTO teams (league_id, name, icon_emoji) VALUES (league_id, 'Alpha Warriors', '🛡️') RETURNING id INTO t_alpha;
INSERT INTO teams (league_id, name, icon_emoji) VALUES (league_id, 'Royal Challengers', '👑') RETURNING id INTO t_royal;

INSERT INTO league_memberships (league_id, player_id, joined_via) VALUES
  (league_id, u_arjun, code_id), (league_id, u_rahul, code_id),
  (league_id, u_vikram, code_id), (league_id, u_jason, code_id);

INSERT INTO team_roster_memberships (team_id, player_id, jersey_no, position, is_captain) VALUES
  (t_falcons, u_arjun, 7,  'Batsman', TRUE),
  (t_falcons, u_rahul, 11, 'All-rounder', FALSE),
  (t_falcons, u_vikram, 23,'Bowler', FALSE),
  (t_thunder, u_jason, 9,  'Batsman', TRUE);

-- ---------------------------------------------------------------- matches
INSERT INTO matches (league_id, home_team_id, away_team_id, scheduled_at, venue, status, home_score, away_score, result_summary)
VALUES (league_id, t_falcons, t_thunder, now() - interval '10 days', 'Falcons Ground, Bangalore', 'COMPLETED',
        '164/6', '140/9', 'Falcons FC won by 24 runs') RETURNING id INTO m_past;
INSERT INTO matches (league_id, home_team_id, away_team_id, scheduled_at, venue, status, home_score, away_score, result_summary)
VALUES (league_id, t_royal, t_falcons, now() - interval '4 days', 'City Stadium, Bangalore', 'COMPLETED',
        '152/8', '155/5', 'Falcons FC won by 5 wickets') RETURNING id INTO m_past2;
INSERT INTO matches (league_id, home_team_id, away_team_id, scheduled_at, venue)
VALUES (league_id, t_alpha, t_thunder, now() + interval '3 days', 'Falcons Ground, Bangalore') RETURNING id INTO m_next;
INSERT INTO matches (league_id, home_team_id, away_team_id, scheduled_at, venue)
VALUES (league_id, t_falcons, t_alpha, now() + interval '5 days', 'City Stadium, Bangalore');

-- per-match stats matching the performance screen cards ('78 Runs', '32 Runs / 2 Wickets')
INSERT INTO player_stats (match_id, player_id, team_id, stats, qo_points, rating, edited_by) VALUES
  (m_past,  u_arjun, t_falcons, '{"runs":78,"balls":59,"fours":9,"sixes":2,"strikeRate":132.2}', 52, 8.5, u_coach),
  (m_past2, u_arjun, t_falcons, '{"runs":32,"wickets":2,"overs":3,"economy":6.1}',               24, 7.2, u_coach),
  (m_past,  u_rahul, t_falcons, '{"runs":21,"wickets":1,"catches":1}',                            18, 6.8, u_coach);

-- Qo Journey (monthly buckets for the chart)
INSERT INTO performance_metrics (player_id, period, qo_score, matches_played, aggregates) VALUES
  (u_arjun, date_trunc('month', now()) - interval '5 months', 540, 2, '{"runs":96}'),
  (u_arjun, date_trunc('month', now()) - interval '4 months', 575, 3, '{"runs":141}'),
  (u_arjun, date_trunc('month', now()) - interval '3 months', 602, 2, '{"runs":88}'),
  (u_arjun, date_trunc('month', now()) - interval '2 months', 651, 3, '{"runs":167}'),
  (u_arjun, date_trunc('month', now()) - interval '1 month',  690, 2, '{"runs":110}'),
  (u_arjun, date_trunc('month', now()),                        742, 2, '{"runs":110,"wickets":2}');

-- ---------------------------------------------------------------- notifications (player home mock cards)
INSERT INTO notifications (user_id, type, title, body, emoji) VALUES
  (u_arjun, 'QO_POINTS',   'Qo Points Earned',  '+52 Qo points added to your profile', '⚡'),
  (u_arjun, 'LEAGUE_UPDATE','League Update',    'Summer League 2024 is now live!', '🏆'),
  (u_arjun, 'SOCIAL',      'New Like',          'Jason liked your match highlight', '❤️'),
  (u_arjun, 'MATCH',       'Match Scheduled',   'Alpha Warriors vs Thunder Strikers — this Saturday', '📅'),
  (u_arjun, 'ACHIEVEMENT', 'Century Club!',     'You scored 100+ in a single match 🎉', '🏅'),
  (u_coach, 'LEAGUE_UPDATE','New player joined','Arjun Mehta joined Falcons U16 Premier League', '🎉');

-- ---------------------------------------------------------------- dugout thread (team chat)
INSERT INTO chat_threads (scope, team_id, title) VALUES ('TEAM', t_falcons, 'Falcons FC Dugout') RETURNING id INTO thread_id;
INSERT INTO chat_participants (thread_id, user_id) VALUES
  (thread_id, u_coach), (thread_id, u_arjun), (thread_id, u_rahul), (thread_id, u_vikram);
INSERT INTO dugout_messages (thread_id, sender_id, body, created_at) VALUES
  (thread_id, u_coach, 'Great win on Saturday, team! Practice at 6 AM tomorrow.', now() - interval '3 days'),
  (thread_id, u_arjun, 'Thanks coach! Will be there 💪', now() - interval '3 days' + interval '10 minutes'),
  (thread_id, u_rahul, 'On it. Nets session first?', now() - interval '2 days');

-- ---------------------------------------------------------------- playbook items
INSERT INTO playbook_items (author_id, sport_id, team_id, kind, title, description, tags) VALUES
  (u_coach, s_cricket, NULL,      'DRILL',    'Front-foot Drive Drill', 'Cone-based drill for driving on the up. 3 sets of 20 balls.', '{batting,technique}'),
  (u_coach, s_cricket, t_falcons, 'STRATEGY', 'Powerplay Field Setting', 'Aggressive ring field for overs 1-6 against right-handers.', '{fielding,strategy}'),
  (u_coach, s_cricket, NULL,      'NOTE',     'Hydration Protocol',     'Every player carries 2L. Electrolytes at drinks break.', '{fitness}');

END $$;
