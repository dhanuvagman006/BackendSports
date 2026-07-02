-- SportyQo schema v1
-- All ids are UUID except human-friendly codes (player_code, league invite code, coach access code).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ---------------------------------------------------------------- users & auth
CREATE TYPE user_role AS ENUM ('PLAYER', 'COACH');
CREATE TYPE gender_t  AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED');

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role           user_role NOT NULL,
  email          CITEXT UNIQUE,
  phone          TEXT UNIQUE,
  password_hash  TEXT NOT NULL,
  is_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_contact_chk CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,          -- 6-digit OTP, hashed
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

CREATE TABLE verification_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email','sms')),
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

-- ---------------------------------------------------------------- sports
CREATE TABLE sports (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT UNIQUE NOT NULL,     -- 'cricket'
  name       TEXT NOT NULL,            -- 'Cricket'
  emoji      TEXT,                     -- '🏏' (frontend shows icon/emoji)
  icon_url   TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- profiles
CREATE TABLE player_profiles (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  player_code   TEXT UNIQUE NOT NULL,           -- e.g. SQP2026123456 (server-generated)
  full_name     TEXT NOT NULL,
  dob           DATE,
  gender        gender_t NOT NULL DEFAULT 'UNDISCLOSED',
  location      TEXT,
  school_academy TEXT,
  club          TEXT,
  primary_sport_id UUID REFERENCES sports(id),
  avatar_key    TEXT,                            -- object-storage key
  qo_score      INT NOT NULL DEFAULT 0,
  bio           TEXT,
  settings      JSONB NOT NULL DEFAULT '{"notifications":true,"publicProfile":true}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_player_profiles_sport ON player_profiles(primary_sport_id);
CREATE INDEX idx_player_profiles_name_trgm ON player_profiles USING gin (to_tsvector('simple', full_name));

CREATE TABLE coach_profiles (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  coach_code   TEXT UNIQUE NOT NULL,             -- access code, e.g. SQC2026123456
  full_name    TEXT NOT NULL,
  title        TEXT DEFAULT 'Head Coach',
  academy      TEXT,                             -- 'Falcons Cricket Academy'
  location     TEXT,
  dob          DATE,
  gender       gender_t NOT NULL DEFAULT 'UNDISCLOSED',
  primary_sport_id UUID REFERENCES sports(id),
  avatar_key   TEXT,
  years_experience INT,
  is_verified_coach BOOLEAN NOT NULL DEFAULT FALSE,  -- verified badge on coach home
  bio          TEXT,
  settings     JSONB NOT NULL DEFAULT '{"notifications":true}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE coach_certifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    UUID NOT NULL REFERENCES coach_profiles(user_id) ON DELETE CASCADE,
  title       TEXT NOT NULL,                  -- 'BCCI Level 2 Coaching Certificate'
  issuer      TEXT,
  issued_on   DATE,
  document_key TEXT,                          -- uploaded proof in object storage
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_certs_coach ON coach_certifications(coach_id);

-- ---------------------------------------------------------------- leagues & teams
CREATE TYPE gender_category AS ENUM ('MENS','WOMENS','MIXED');

CREATE TABLE leagues (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_coach_id UUID NOT NULL REFERENCES coach_profiles(user_id),
  sport_id     UUID NOT NULL REFERENCES sports(id),
  name         TEXT NOT NULL,                 -- 'Falcons U16 Premier League'
  location     TEXT,                          -- 'Bangalore, Karnataka'
  gender       gender_category NOT NULL DEFAULT 'MENS',
  icon_emoji   TEXT,                          -- chosen icon
  logo_key     TEXT,                          -- or uploaded logo
  season       TEXT,                          -- 'Summer League 2024'
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','COMPLETED','ARCHIVED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_leagues_owner ON leagues(owner_coach_id);
CREATE INDEX idx_leagues_sport ON leagues(sport_id);

-- one active invite code per league; revocable + regenerable
CREATE TABLE league_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,                  -- 6-digit, matches join screen
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  max_uses    INT,                            -- NULL = unlimited
  use_count   INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_league_codes_active_code ON league_codes(code) WHERE is_active;
CREATE INDEX idx_league_codes_league ON league_codes(league_id);

CREATE TABLE teams (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id  UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,                   -- 'Falcons FC'
  icon_emoji TEXT,
  logo_key   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (league_id, name)
);
CREATE INDEX idx_teams_league ON teams(league_id);

CREATE TABLE league_memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id  UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  player_id  UUID NOT NULL REFERENCES player_profiles(user_id) ON DELETE CASCADE,
  joined_via UUID REFERENCES league_codes(id),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (league_id, player_id)
);

CREATE TABLE team_roster_memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id  UUID NOT NULL REFERENCES player_profiles(user_id) ON DELETE CASCADE,
  jersey_no  INT,
  position   TEXT,                            -- 'Batsman', 'All-rounder', 'Striker'...
  is_captain BOOLEAN NOT NULL DEFAULT FALSE,
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BENCHED','LEFT')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, player_id)
);
CREATE INDEX idx_roster_player ON team_roster_memberships(player_id);

-- ---------------------------------------------------------------- matches & stats
CREATE TABLE matches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id    UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  home_team_id UUID NOT NULL REFERENCES teams(id),
  away_team_id UUID NOT NULL REFERENCES teams(id),
  scheduled_at TIMESTAMPTZ NOT NULL,
  venue        TEXT,
  status       TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','LIVE','COMPLETED','CANCELLED')),
  home_score   TEXT,                          -- '164/6' or '3'; text keeps it sport-agnostic
  away_score   TEXT,
  result_summary TEXT,                        -- 'Falcons FC won by 24 runs'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (home_team_id <> away_team_id)
);
CREATE INDEX idx_matches_league_time ON matches(league_id, scheduled_at);

-- per player, per match line: sport-agnostic key/value stats + a Qo delta
CREATE TABLE player_stats (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id   UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id  UUID NOT NULL REFERENCES player_profiles(user_id) ON DELETE CASCADE,
  team_id    UUID NOT NULL REFERENCES teams(id),
  stats      JSONB NOT NULL DEFAULT '{}',     -- {"runs":78,"wickets":1,"catches":2,"strikeRate":132.5}
  qo_points  INT NOT NULL DEFAULT 0,          -- '+52 Qo points added to your profile'
  rating     NUMERIC(3,1),
  edited_by  UUID REFERENCES coach_profiles(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, player_id)
);
CREATE INDEX idx_player_stats_player ON player_stats(player_id);

-- season/rolling aggregates for performance dashboards ('Qo Journey' chart)
CREATE TABLE performance_metrics (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id  UUID NOT NULL REFERENCES player_profiles(user_id) ON DELETE CASCADE,
  period     DATE NOT NULL,                   -- month bucket (first of month)
  qo_score   INT NOT NULL DEFAULT 0,
  matches_played INT NOT NULL DEFAULT 0,
  aggregates JSONB NOT NULL DEFAULT '{}',     -- {"runs":312,"avg":44.6,...}
  UNIQUE (player_id, period)
);

-- ---------------------------------------------------------------- social / content
CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                   -- QO_POINTS | LEAGUE_UPDATE | SOCIAL | MATCH | ACHIEVEMENT
  title      TEXT NOT NULL,
  body       TEXT,
  emoji      TEXT,
  data       JSONB NOT NULL DEFAULT '{}',
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at DESC);

CREATE TABLE chat_threads (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      TEXT NOT NULL CHECK (scope IN ('TEAM','LEAGUE','DIRECT')),
  team_id    UUID REFERENCES teams(id) ON DELETE CASCADE,
  league_id  UUID REFERENCES leagues(id) ON DELETE CASCADE,
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_participants (
  thread_id  UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE dugout_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_id  UUID NOT NULL REFERENCES users(id),
  body       TEXT,
  attachment_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dugout_thread_time ON dugout_messages(thread_id, created_at DESC);

CREATE TABLE playbook_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id  UUID NOT NULL REFERENCES users(id),
  sport_id   UUID REFERENCES sports(id),
  team_id    UUID REFERENCES teams(id) ON DELETE CASCADE,   -- NULL = public/global item
  league_id  UUID REFERENCES leagues(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'DRILL' CHECK (kind IN ('DRILL','STRATEGY','VIDEO','NOTE')),
  title      TEXT NOT NULL,
  description TEXT,
  media_key  TEXT,
  tags       TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_playbook_sport ON playbook_items(sport_id);
CREATE INDEX idx_playbook_team ON playbook_items(team_id);

-- follows/recommendations shown on the profile screen
CREATE TABLE follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE TABLE recommendations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id    UUID NOT NULL REFERENCES player_profiles(user_id) ON DELETE CASCADE,
  from_coach_id UUID NOT NULL REFERENCES coach_profiles(user_id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, from_coach_id)
);

CREATE TABLE academy_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id  UUID NOT NULL REFERENCES player_profiles(user_id) ON DELETE CASCADE,
  academy    TEXT NOT NULL,
  role       TEXT,
  start_year INT,
  end_year   INT
);

-- updated_at trigger
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','player_profiles','coach_profiles','leagues','player_stats']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
  END LOOP;
END $$;
