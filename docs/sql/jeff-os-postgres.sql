BEGIN;

CREATE TABLE IF NOT EXISTS jeff_os_schedule_runs (
  schedule_sha256 text NOT NULL CHECK (schedule_sha256 ~ '^[a-f0-9]{64}$'),
  run_index integer NOT NULL CHECK (run_index > 0 AND run_index <= 24),
  status text NOT NULL CHECK (status IN ('reserved', 'completed')),
  receipt_sha256 text CHECK (receipt_sha256 IS NULL OR receipt_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (schedule_sha256, run_index),
  CHECK ((status = 'reserved' AND receipt_sha256 IS NULL AND completed_at IS NULL)
    OR (status = 'completed' AND receipt_sha256 IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS jeff_os_schedule_one_in_flight_idx
  ON jeff_os_schedule_runs (schedule_sha256)
  WHERE status = 'reserved';

CREATE TABLE IF NOT EXISTS jeff_agent_messages (
  message_sha256 text PRIMARY KEY CHECK (message_sha256 ~ '^[a-f0-9]{64}$'),
  recipient_sha256 text NOT NULL CHECK (recipient_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jeff_agent_messages_recipient_idx
  ON jeff_agent_messages (recipient_sha256, created_at);

CREATE INDEX IF NOT EXISTS jeff_agent_messages_expiry_idx
  ON jeff_agent_messages (expires_at);

REVOKE ALL ON TABLE jeff_os_schedule_runs FROM PUBLIC;
REVOKE ALL ON TABLE jeff_agent_messages FROM PUBLIC;

COMMIT;
