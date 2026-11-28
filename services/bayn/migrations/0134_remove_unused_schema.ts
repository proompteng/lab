import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SET LOCAL lock_timeout = '5s'`
  yield* sql`LOCK TABLE broker_events, broker_errors, rate_limits,
    opening_drive_qualification_locks, opening_drive_qualification_replay_versions,
    opening_drive_qualification_results, opening_drive_qualification_session_replays
    IN ACCESS EXCLUSIVE MODE`
  yield* sql`DO $cutover$ BEGIN
    IF EXISTS (SELECT 1 FROM broker_errors)
      OR EXISTS (SELECT 1 FROM rate_limits)
      OR EXISTS (SELECT 1 FROM broker_events WHERE event_kind IN ('ERROR', 'RATE_LIMIT'))
      OR EXISTS (SELECT 1 FROM opening_drive_qualification_locks)
      OR EXISTS (SELECT 1 FROM opening_drive_qualification_replay_versions)
      OR EXISTS (SELECT 1 FROM opening_drive_qualification_results)
      OR EXISTS (SELECT 1 FROM opening_drive_qualification_session_replays)
    THEN
      RAISE EXCEPTION 'unused schema cutover requires empty retired tables and no retired broker events'
        USING ERRCODE = '55000';
    END IF;
  END $cutover$`
  yield* sql`ALTER TABLE broker_events DROP CONSTRAINT broker_events_event_kind_check,
    ADD CONSTRAINT broker_events_event_kind_check CHECK (event_kind IN ('ACCOUNT', 'POSITION', 'ORDER', 'FILL'))`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_broker_event_payload()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE payload_count integer;
    BEGIN
      SELECT count(*) INTO payload_count FROM (
        SELECT event_id FROM account_snapshots WHERE event_id = NEW.event_id
        UNION ALL SELECT event_id FROM positions WHERE event_id = NEW.event_id
        UNION ALL SELECT event_id FROM orders WHERE event_id = NEW.event_id
        UNION ALL SELECT event_id FROM fills WHERE event_id = NEW.event_id
      ) AS payloads;
      IF payload_count <> 1 THEN
        RAISE EXCEPTION 'broker event % must have exactly one typed payload', NEW.event_id USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $function$`
  yield* sql`DROP TABLE broker_errors, rate_limits,
    opening_drive_qualification_session_replays, opening_drive_qualification_replay_versions,
    opening_drive_qualification_results, opening_drive_qualification_locks`
})
