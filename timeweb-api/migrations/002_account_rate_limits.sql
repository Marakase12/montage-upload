CREATE TABLE IF NOT EXISTS account_rate_limits (
  scope varchar(64) NOT NULL,
  subject_hash char(64) NOT NULL,
  window_start timestamptz NOT NULL,
  hit_count integer NOT NULL CHECK (hit_count > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (scope, subject_hash)
);

CREATE INDEX IF NOT EXISTS account_rate_limits_updated_at_idx
  ON account_rate_limits(updated_at);
