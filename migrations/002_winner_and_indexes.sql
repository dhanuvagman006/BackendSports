-- Winner tracking so standings can be computed reliably
ALTER TABLE matches ADD COLUMN IF NOT EXISTS winner_team_id uuid REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_matches_winner ON matches(winner_team_id);
