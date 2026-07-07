-- League type: grassroots "gully" leagues vs professional ones.
-- Asked while creating a league (e.g. cricket: Gully or Professional).
-- Nullable so existing leagues stay valid.
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS league_type TEXT
  CHECK (league_type IN ('GULLY', 'PROFESSIONAL'));
