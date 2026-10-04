BEGIN;

CREATE TABLE IF NOT EXISTS jeff_holder_challenges (
  challenge_sha256 text PRIMARY KEY CHECK (challenge_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jeff_holder_challenges_expiry_idx
  ON jeff_holder_challenges (expires_at);

CREATE TABLE IF NOT EXISTS jeff_holder_sessions (
  session_id_sha256 text PRIMARY KEY CHECK (session_id_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text CHECK (revocation_reason IS NULL OR length(revocation_reason) <= 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS jeff_holder_sessions_expiry_idx
  ON jeff_holder_sessions (expires_at);

CREATE TABLE IF NOT EXISTS jeff_holder_memory_records (
  scope_sha256 text NOT NULL CHECK (scope_sha256 ~ '^[a-f0-9]{64}$'),
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
  previous_record_sha256 text CHECK (
    previous_record_sha256 IS NULL OR previous_record_sha256 ~ '^[a-f0-9]{64}$'
  ),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_sha256, sequence_number),
  UNIQUE (record_sha256)
);

CREATE UNIQUE INDEX IF NOT EXISTS jeff_holder_memory_single_successor_idx
  ON jeff_holder_memory_records (scope_sha256, COALESCE(previous_record_sha256, ''));

CREATE TABLE IF NOT EXISTS jeff_holder_rate_limits (
  key_sha256 text PRIMARY KEY CHECK (key_sha256 ~ '^[a-f0-9]{64}$'),
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 1 AND 64),
  request_count integer NOT NULL CHECK (request_count > 0),
  window_started_at timestamptz NOT NULL,
  reset_at timestamptz NOT NULL CHECK (reset_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS jeff_holder_rate_limits_reset_idx
  ON jeff_holder_rate_limits (reset_at);

REVOKE ALL ON TABLE jeff_holder_challenges FROM PUBLIC;
REVOKE ALL ON TABLE jeff_holder_sessions FROM PUBLIC;
REVOKE ALL ON TABLE jeff_holder_memory_records FROM PUBLIC;
REVOKE ALL ON TABLE jeff_holder_rate_limits FROM PUBLIC;

COMMIT;
