BEGIN;

CREATE TABLE IF NOT EXISTS jeff_os_schedules (
  schedule_sha256 text PRIMARY KEY CHECK (schedule_sha256 ~ '^[a-f0-9]{64}$'),
  agent_sha256 text NOT NULL CHECK (agent_sha256 ~ '^[a-f0-9]{64}$'),
  owner_sha256 text NOT NULL CHECK (owner_sha256 ~ '^[a-f0-9]{64}$'),
  owner_epoch bigint NOT NULL CHECK (owner_epoch >= 0),
  maximum_runs integer NOT NULL CHECK (maximum_runs > 0 AND maximum_runs <= 24),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'cancelled')),
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'active' AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS jeff_os_schedules_owner_idx
  ON jeff_os_schedules (agent_sha256, owner_epoch, status, created_at);

CREATE INDEX IF NOT EXISTS jeff_os_schedules_expiry_idx
  ON jeff_os_schedules (expires_at);

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
REVOKE ALL ON TABLE jeff_os_schedules FROM PUBLIC;
REVOKE ALL ON TABLE jeff_agent_messages FROM PUBLIC;

COMMIT;
