import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`DO $cutover$
    BEGIN
      IF EXISTS (SELECT 1 FROM intents WHERE state <> 'TERMINAL') OR EXISTS (
        SELECT 1 FROM autonomous_cycles WHERE terminal_at IS NULL AND decision_hash IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (intent_id, operation) event_type
          FROM mutation_events
          ORDER BY intent_id, operation, sequence DESC
        ) latest
        WHERE event_type IN ('SUBMIT_STARTED', 'SUBMIT_UNKNOWN', 'CANCEL_STARTED', 'CANCEL_UNKNOWN', 'RECOVERY_UNKNOWN')
      ) THEN
        RAISE EXCEPTION 'explicit LIMIT decision cutover requires settled intents, bound cycles and broker mutations'
          USING ERRCODE = '55000';
      END IF;
    END $cutover$`
  yield* sql`ALTER TABLE autonomous_cycle_shadow_decisions
    DROP CONSTRAINT autonomous_cycle_decisions_schema_version_check,
    DROP CONSTRAINT autonomous_cycle_decisions_document_check,
    ADD CONSTRAINT autonomous_cycle_decisions_schema_version_check CHECK (
      schema_version IN ('bayn.observe-shadow-decision.v2', 'bayn.paper-cycle-decision.v2')
    ) NOT VALID,
    ADD CONSTRAINT autonomous_cycle_decisions_document_check CHECK (COALESCE(
      document ->> 'schemaVersion' = schema_version
      AND (
        (schema_version = 'bayn.observe-shadow-decision.v2'
          AND document ->> 'mode' = 'OBSERVE' AND document ->> 'dispatchable' = 'false')
        OR (schema_version = 'bayn.paper-cycle-decision.v2'
          AND document ->> 'mode' = 'PAPER'
          AND (document ->> 'dispatchable' = 'true'
            OR (document ->> 'dispatchable' = 'false' AND jsonb_typeof(document -> 'riskBlock') = 'object')))
      )
      AND document #>> '{bindings,cycleId}' = cycle_id
      AND (document ->> 'createdAt')::timestamptz = created_at,
      false
    )) NOT VALID`
  yield* sql`ALTER TABLE autonomous_cycle_paper_closures
    ADD CONSTRAINT autonomous_cycle_closures_decision_version_check CHECK (COALESCE(
      document #>> '{document,schemaVersion}' = 'bayn.paper-cycle-decision.v2', false
    )) NOT VALID`
  yield* sql`ALTER TABLE autonomous_cycle_paper_close_replans
    ADD CONSTRAINT autonomous_cycle_replans_decision_version_check CHECK (COALESCE(
      document #>> '{document,schemaVersion}' = 'bayn.paper-cycle-decision.v2', false
    )) NOT VALID`
  yield* sql`DO $decision_guards$
    DECLARE
      signature text;
      definition text;
      retired constant text := 'bayn.paper-cycle-decision.v1';
      current constant text := 'bayn.paper-cycle-decision.v2';
    BEGIN
      FOREACH signature IN ARRAY ARRAY[
        'paper_cycle_generation_is_superseded(text,text)',
        'paper_cycle_completion_evidence_matches(text,text,timestamptz)',
        'enforce_autonomous_cycle_lifecycle()'
      ] LOOP
        definition := pg_get_functiondef(signature::regprocedure);
        IF (length(definition) - length(replace(definition, retired, ''))) <> length(retired) THEN
          RAISE EXCEPTION 'expected exactly one retired decision guard in %', signature USING ERRCODE = '55000';
        END IF;
        EXECUTE replace(definition, retired, current);
      END LOOP;
    END $decision_guards$`
})
