import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Freeze the last predecessor receipts while copying and checking them in the migration transaction.
  yield* sql`LOCK TABLE broker_notification_receipts IN ACCESS EXCLUSIVE MODE`
  yield* sql`INSERT INTO broker_source_events(account_id,event_id,source_revision,received_at,recorded_at,event_kind)
    SELECT account_id,event_id,source_revision,received_at,recorded_at,'LEGACY_RECEIPT'
    FROM broker_notification_receipts
    ON CONFLICT (account_id,event_id) DO NOTHING`
  yield* sql`INSERT INTO broker_source_event_projections(account_id,event_id,source_revision,outcome,reason,observed_at)
    SELECT legacy.account_id,legacy.event_id,legacy.source_revision,'RECONCILE_REQUIRED','LEGACY_RECEIPT',legacy.received_at
    FROM broker_notification_receipts legacy
    JOIN broker_source_events source USING (account_id,event_id)
    WHERE source.event_kind = 'LEGACY_RECEIPT'
    ON CONFLICT (account_id,event_id) DO NOTHING`
  yield* sql`DO $migration$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM broker_notification_receipts legacy
      LEFT JOIN broker_source_events source USING (account_id,event_id)
      LEFT JOIN broker_source_event_projections projection USING (account_id,event_id)
      WHERE (source.event_kind,source.source_revision,source.received_at,source.recorded_at)
          IS DISTINCT FROM ('LEGACY_RECEIPT',legacy.source_revision,legacy.received_at,legacy.recorded_at)
         OR (projection.outcome,projection.reason,projection.source_revision,projection.observed_at)
          IS DISTINCT FROM ('RECONCILE_REQUIRED','LEGACY_RECEIPT',legacy.source_revision,legacy.received_at)
    ) THEN
      RAISE EXCEPTION 'legacy broker notification receipt conflicts with retained source or projection evidence'
        USING ERRCODE = '23514';
    END IF;
  END $migration$`

  yield* sql`CREATE OR REPLACE FUNCTION enforce_order_provider_version() RETURNS trigger AS $function$
  DECLARE
    source_id text;
    source_parts text[];
    canonical_updated_at text;
  BEGIN
    SELECT source_event_id INTO source_id
    FROM broker_events
    WHERE event_id = NEW.event_id AND account_id = NEW.account_id AND event_kind = 'ORDER' AND broker = 'ALPACA';
    IF source_id IS NULL THEN
      RAISE EXCEPTION 'order event does not identify an ALPACA order source' USING ERRCODE = '23514';
    END IF;

    source_parts := regexp_match(
      source_id,
      '^(order:.*):([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:[.]([0-9]{1,9}))?Z$'
    );
    IF source_parts IS NULL OR source_parts[1] <> 'order:' || NEW.broker_order_id THEN
      RAISE EXCEPTION 'order source identity does not match the order payload' USING ERRCODE = '23514';
    END IF;
    canonical_updated_at := source_parts[2] || '.' || rpad(COALESCE(source_parts[3],''),9,'0') || 'Z';
    IF NEW.broker_updated_at IS DISTINCT FROM canonical_updated_at THEN
      RAISE EXCEPTION 'order provider version does not match the source identity' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END
  $function$ LANGUAGE plpgsql`
  yield* sql`DROP TABLE broker_notification_receipts`
})
