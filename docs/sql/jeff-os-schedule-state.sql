BEGIN;

-- Stop schedule traffic while applying this additive migration.
LOCK TABLE jeff_os_schedules, jeff_os_schedule_runs IN ACCESS EXCLUSIVE MODE;

ALTER TABLE jeff_os_schedules
  ADD COLUMN IF NOT EXISTS completed_runs integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserved_run_index integer;

-- Preserve completed quota and any unknown in-flight outcome on upgrade or rerun.
UPDATE jeff_os_schedules AS schedules
SET completed_runs = COALESCE((
    SELECT MAX(run_index) FROM jeff_os_schedule_runs
    WHERE schedule_sha256 = schedules.schedule_sha256 AND status = 'completed'
  ), 0),
  reserved_run_index = (
    SELECT run_index FROM jeff_os_schedule_runs
    WHERE schedule_sha256 = schedules.schedule_sha256 AND status = 'reserved'
  );

ALTER TABLE jeff_os_schedules DROP CONSTRAINT IF EXISTS jeff_os_schedule_state_bounds;
ALTER TABLE jeff_os_schedules ADD CONSTRAINT jeff_os_schedule_state_bounds CHECK (
  completed_runs >= 0 AND completed_runs <= maximum_runs
  AND (reserved_run_index IS NULL OR (
    status = 'active' AND reserved_run_index = completed_runs + 1
    AND reserved_run_index <= maximum_runs
  ))
);

COMMIT;
