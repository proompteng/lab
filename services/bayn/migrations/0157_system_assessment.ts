import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE mutation_events ADD COLUMN routing jsonb,
    ADD CONSTRAINT mutation_routing_contract CHECK (routing IS NULL OR (
      jsonb_typeof(routing) = 'object'
      AND routing - ARRAY['startedAt', 'requestDispatchedAt', 'completedAt'] = '{}'::jsonb
      AND (routing ? 'startedAt') AND (routing ? 'completedAt')
      AND (routing ? 'requestDispatchedAt')
      AND (routing->'requestDispatchedAt' = 'null'::jsonb OR (
        jsonb_typeof(routing->'requestDispatchedAt') = 'string'
        AND (routing->>'startedAt')::timestamptz <= (routing->>'requestDispatchedAt')::timestamptz
        AND (routing->>'requestDispatchedAt')::timestamptz <= (routing->>'completedAt')::timestamptz))
      AND jsonb_typeof(routing->'startedAt') = 'string' AND jsonb_typeof(routing->'completedAt') = 'string'
      AND (routing->>'startedAt')::timestamptz <= (routing->>'completedAt')::timestamptz
      AND (routing->>'completedAt')::timestamptz <= occurred_at
      AND event_type IN ('SUBMIT_ACCEPTED', 'SUBMIT_REJECTED', 'SUBMIT_UNKNOWN', 'CANCEL_ACCEPTED', 'CANCEL_UNKNOWN')
    ))`
  yield* sql`CREATE FUNCTION check_mutation_routing_admission() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE admitted_at timestamptz;
  BEGIN
    IF NEW.routing IS NULL THEN RETURN NEW; END IF;
    SELECT occurred_at INTO STRICT admitted_at FROM mutation_events
      WHERE mutation_id = NEW.mutation_id AND intent_id = NEW.intent_id AND operation = NEW.operation AND sequence = 1;
    IF (NEW.routing->>'startedAt')::timestamptz < admitted_at THEN
      RAISE EXCEPTION 'broker routing precedes mutation admission' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER mutation_routing_admission BEFORE INSERT ON mutation_events
    FOR EACH ROW EXECUTE FUNCTION check_mutation_routing_admission()`
  yield* sql`CREATE TABLE system_evidence_cuts (
    source_cut_hash text PRIMARY KEY CHECK (source_cut_hash ~ '^[0-9a-f]{64}$'),
    registration_hash text NOT NULL REFERENCES system_qualification_registrations(registration_hash),
    as_of timestamptz NOT NULL,
    payload_text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (source_cut_hash = encode(sha256(convert_to(payload_text, 'UTF8')), 'hex')),
    CHECK (jsonb_typeof(payload_text::jsonb) = 'object'
      AND payload_text::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.system-source-cut.v2'
      AND payload_text::jsonb->>'registrationHash' IS NOT DISTINCT FROM registration_hash
      AND (payload_text::jsonb->>'asOf')::timestamptz IS NOT DISTINCT FROM as_of)
  )`
  yield* sql`CREATE TABLE system_replay_execution_receipts (
    receipt_hash text PRIMARY KEY CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
    registration_hash text NOT NULL REFERENCES system_qualification_registrations(registration_hash),
    source_cut_hash text NOT NULL REFERENCES system_evidence_cuts(source_cut_hash),
    container_id text NOT NULL CHECK (container_id ~ '^[0-9a-f]{64}$'),
    report_file_hash text NOT NULL CHECK (report_file_hash ~ '^[0-9a-f]{64}$'),
    payload_text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (receipt_hash = encode(sha256(convert_to(payload_text, 'UTF8')), 'hex')),
    CHECK (jsonb_typeof(payload_text::jsonb) = 'object'
      AND payload_text::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.replay-execution-receipt.v1'
      AND payload_text::jsonb->>'registrationHash' IS NOT DISTINCT FROM registration_hash
      AND payload_text::jsonb->>'sourceCutHash' IS NOT DISTINCT FROM source_cut_hash
      AND payload_text::jsonb->>'containerId' IS NOT DISTINCT FROM container_id
      AND payload_text::jsonb->>'reportFileHash' IS NOT DISTINCT FROM report_file_hash
      AND payload_text::jsonb->>'assurance' IS NOT DISTINCT FROM 'TRUSTED_CONTAINER_DAEMON_OBSERVATION')
  )`
  yield* sql`CREATE FUNCTION check_system_replay_execution_scope() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE source_cut system_evidence_cuts; definition jsonb; captured timestamptz; started timestamptz; finished timestamptz;
  BEGIN
    SELECT * INTO STRICT source_cut FROM system_evidence_cuts WHERE source_cut_hash = NEW.source_cut_hash;
    SELECT policy INTO STRICT definition FROM system_qualification_registrations registration,
      json_array_elements(registration.payload_text::json->'policies') policy
      WHERE registration.registration_hash = NEW.registration_hash
        AND encode(sha256(convert_to(policy::text, 'UTF8')), 'hex') = NEW.payload_text::jsonb->>'policyDefinitionHash';
    NEW.created_at := clock_timestamp();
    captured := (NEW.payload_text::jsonb->>'capturedAt')::timestamptz;
    started := (NEW.payload_text::jsonb->>'startedAt')::timestamptz;
    finished := (NEW.payload_text::jsonb->>'finishedAt')::timestamptz;
    IF source_cut.registration_hash <> NEW.registration_hash
      OR captured IS NULL OR started IS NULL OR finished IS NULL
      OR started < source_cut.created_at OR finished < started OR captured < finished OR captured > NEW.created_at
      OR NEW.payload_text::jsonb #>> '{image,imageDigest}' IS DISTINCT FROM 'sha256:' || (definition->>'imageDigest')
      OR NEW.payload_text::jsonb #>> '{image,sourceRevision}' IS DISTINCT FROM definition->>'sourceRevision'
      OR NEW.payload_text::jsonb #>> '{image,policyDefinitionHash}' IS DISTINCT FROM NEW.payload_text::jsonb->>'policyDefinitionHash' THEN
      RAISE EXCEPTION 'replay execution differs from the retained source cut or registered image' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER system_replay_execution_scope BEFORE INSERT ON system_replay_execution_receipts
    FOR EACH ROW EXECUTE FUNCTION check_system_replay_execution_scope()`
  yield* sql`CREATE TABLE system_assessment_receipts (
    assessment_hash text PRIMARY KEY CHECK (assessment_hash ~ '^[0-9a-f]{64}$'),
    registration_hash text NOT NULL REFERENCES system_qualification_registrations(registration_hash),
    source_cut_hash text NOT NULL REFERENCES system_evidence_cuts(source_cut_hash),
    as_of timestamptz NOT NULL,
    verdict text NOT NULL CHECK (verdict IN ('QUALIFIED_PAPER', 'REJECTED', 'INCONCLUSIVE')),
    input_text text NOT NULL,
    assessment_text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (assessment_hash = encode(sha256(convert_to(assessment_text, 'UTF8')), 'hex')),
    CHECK (jsonb_typeof(assessment_text::jsonb) = 'object'
      AND assessment_text::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.system-assessment.v1'
      AND assessment_text::jsonb->>'registrationHash' IS NOT DISTINCT FROM registration_hash
      AND assessment_text::jsonb->>'sourceCutHash' IS NOT DISTINCT FROM source_cut_hash
      AND (assessment_text::jsonb->>'asOf')::timestamptz IS NOT DISTINCT FROM as_of
      AND assessment_text::jsonb->>'verdict' IS NOT DISTINCT FROM verdict
      AND assessment_text::jsonb->>'inputHash' IS NOT DISTINCT FROM encode(sha256(convert_to(input_text, 'UTF8')), 'hex')),
    CHECK (verdict <> 'QUALIFIED_PAPER' OR (
      assessment_text::jsonb->>'evidenceComplete' IS NOT DISTINCT FROM 'true'
      AND assessment_text::jsonb #>> '{numerical,verdict}' IS NOT DISTINCT FROM 'NUMERICAL_TARGETS_PASSED'
      AND assessment_text::jsonb #>> '{reliability,status}' IS NOT DISTINCT FROM 'MEETS_TARGET'
      AND assessment_text::jsonb #>> '{realism,status}' IS NOT DISTINCT FROM 'SUPPORTED'
      AND assessment_text::jsonb #>> '{safety,pass}' IS NOT DISTINCT FROM 'true'
      AND assessment_text::jsonb->'missing' IS NOT DISTINCT FROM '[]'::jsonb
      AND assessment_text::jsonb->'violations' IS NOT DISTINCT FROM '[]'::jsonb))
  )`
  yield* sql`CREATE FUNCTION check_system_source_cut_scope() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE registration system_qualification_registrations;
  BEGIN
    SELECT * INTO STRICT registration FROM system_qualification_registrations WHERE registration_hash = NEW.registration_hash;
    NEW.created_at := clock_timestamp();
    IF NEW.as_of < registration.created_at OR NEW.as_of > NEW.created_at THEN
      RAISE EXCEPTION 'source cut must follow registration and cannot be in the future' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER system_source_cut_scope BEFORE INSERT ON system_evidence_cuts
    FOR EACH ROW EXECUTE FUNCTION check_system_source_cut_scope()`
  yield* sql`CREATE FUNCTION check_system_assessment_scope() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE registration system_qualification_registrations; source_cut system_evidence_cuts;
  BEGIN
    SELECT * INTO STRICT registration FROM system_qualification_registrations WHERE registration_hash = NEW.registration_hash;
    SELECT * INTO STRICT source_cut FROM system_evidence_cuts WHERE source_cut_hash = NEW.source_cut_hash;
    NEW.created_at := clock_timestamp();
    IF NEW.as_of < registration.created_at OR NEW.as_of > NEW.created_at
      OR source_cut.registration_hash <> NEW.registration_hash OR source_cut.as_of <> NEW.as_of
      OR NEW.input_text::jsonb->'registration' IS DISTINCT FROM registration.payload_text::jsonb
      OR NEW.assessment_text::jsonb->>'registrationReceiptHash' IS DISTINCT FROM registration.registration_hash
      OR (NEW.verdict = 'QUALIFIED_PAPER' AND NEW.as_of < registration.last_close_at) THEN
      RAISE EXCEPTION 'assessment evidence cut or registration differs' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER system_assessment_scope BEFORE INSERT ON system_assessment_receipts
    FOR EACH ROW EXECUTE FUNCTION check_system_assessment_scope()`
  yield* sql`CREATE TABLE execution_controller_observations (
    observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    controller_key text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status jsonb NOT NULL CHECK (jsonb_typeof(status) = 'object')
  )`
  yield* sql`CREATE INDEX execution_controller_observations_time ON execution_controller_observations(controller_key, recorded_at)`
  yield* sql`CREATE INDEX jev_batch_plans_assessment_window ON jev_batch_plans(authority_generation_hash, (payload->>'observedAt'))`
  yield* sql`CREATE TABLE system_durable_observations (
    registration_hash text NOT NULL REFERENCES system_qualification_registrations(registration_hash),
    kind text NOT NULL CHECK (kind IN ('DECISION', 'RECONCILIATION', 'MUTATION', 'CONTROLLER', 'BATCH')),
    source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    source_at timestamptz NOT NULL,
    witnessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    correct boolean NOT NULL,
    PRIMARY KEY(registration_hash, kind, source_hash),
    CHECK (witnessed_at >= source_at)
  )`
  yield* sql`CREATE FUNCTION system_evidence_source_committed(source_xid xid) RETURNS boolean LANGUAGE plpgsql AS $function$
  DECLARE snapshot_upper numeric; source_number numeric; full_source numeric;
  BEGIN
    source_number := source_xid::text::numeric;
    IF source_number < 3 THEN RETURN false; END IF;
    -- Resolve a recent visible row into the snapshot's 64-bit epoch; ambiguous old and current writes stay unknown.
    snapshot_upper := pg_snapshot_xmax(pg_current_snapshot())::text::numeric;
    full_source := snapshot_upper - mod(snapshot_upper, 4294967296) + source_number;
    IF full_source >= snapshot_upper THEN full_source := full_source - 4294967296; END IF;
    IF full_source < 3 OR snapshot_upper - full_source >= 2147483648 THEN RETURN false; END IF;
    RETURN coalesce(pg_xact_status(full_source::text::xid8) = 'committed', false);
  END $function$`
  yield* sql`CREATE FUNCTION retain_execution_controller_observation() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE registration record; account text; controller_identity text; generation text;
  BEGIN
    IF NEW.last_receipt_hash IS NOT NULL AND jsonb_typeof(NEW.last_pass) = 'object'
      AND (TG_OP = 'INSERT' OR NEW.last_receipt_hash IS DISTINCT FROM OLD.last_receipt_hash
        OR NEW.last_sequence IS DISTINCT FROM OLD.last_sequence OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
        OR NEW.last_pass IS DISTINCT FROM OLD.last_pass OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash) THEN
      INSERT INTO execution_controller_observations(controller_key, status) VALUES (NEW.controller_key, to_jsonb(NEW));
    END IF;
    FOR registration IN SELECT * FROM system_qualification_registrations
      WHERE first_open_at <= clock_timestamp() AND last_close_at + interval '1 day' >= clock_timestamp()
        AND payload_text::jsonb #>> '{obligations,configuration,controllerPlanHash}' = NEW.plan_hash LOOP
      SELECT policy->>'authorityGenerationHash' INTO generation
        FROM jsonb_array_elements(registration.payload_text::jsonb->'policies') policy WHERE policy->>'policy' = 'JEV';
      SELECT account_id, broker_identity_hash INTO account, controller_identity FROM authority_generations WHERE generation_hash = generation;
      IF account IS NULL OR controller_identity IS DISTINCT FROM NEW.controller_key THEN CONTINUE; END IF;
      INSERT INTO system_durable_observations(registration_hash, kind, source_hash, source_at, correct)
        SELECT registration.registration_hash, 'CONTROLLER', observation.status->>'last_receipt_hash',
          (observation.status->>'completed_at')::timestamptz, true
        FROM execution_controller_observations observation
        WHERE observation.controller_key = NEW.controller_key AND observation.status->>'plan_hash' = NEW.plan_hash
          AND observation.status->>'last_receipt_hash' IS NOT NULL AND jsonb_typeof(observation.status->'last_pass') = 'object'
          AND ((observation.status->>'completed_at')::timestamptz BETWEEN registration.first_open_at AND registration.last_close_at
            OR (observation.status #>> '{last_pass,executionIssuedAt}')::timestamptz BETWEEN registration.first_open_at AND registration.last_close_at)
          AND (observation.status->>'completed_at')::timestamptz <= clock_timestamp()
          AND system_evidence_source_committed(observation.xmin)
        ON CONFLICT DO NOTHING;
      INSERT INTO system_durable_observations(registration_hash, kind, source_hash, source_at, correct)
        SELECT registration.registration_hash, 'BATCH', result.payload->>'resultHash',
          (result.payload->>'completedAt')::timestamptz, true
        FROM jev_batch_results result JOIN jev_batch_plans plan USING(batch_id)
          JOIN autonomous_cycles cycle ON cycle.cycle_id = plan.cycle_id
        WHERE cycle.account_id = account AND plan.authority_generation_hash = generation
          AND plan.payload->>'observedAt' >= to_char(registration.first_open_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AND plan.payload->>'observedAt' < to_char(registration.last_close_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AND (result.payload->>'completedAt')::timestamptz <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM system_durable_observations prior
            WHERE prior.registration_hash = registration.registration_hash AND prior.kind = 'BATCH'
              AND prior.source_hash = result.result_hash)
          AND system_evidence_source_committed(result.xmin) AND system_evidence_source_committed(plan.xmin)
          AND system_evidence_source_committed(cycle.xmin)
        ON CONFLICT DO NOTHING;
      INSERT INTO system_durable_observations(registration_hash, kind, source_hash, source_at, correct)
        SELECT registration.registration_hash, 'DECISION', decision.decision_hash, (decision.document->>'createdAt')::timestamptz, true
        FROM (
          SELECT shadow.cycle_id, shadow.decision_hash, shadow.document, shadow.xmin::text AS source_xid
            FROM autonomous_cycle_shadow_decisions shadow JOIN autonomous_cycles bound
              ON bound.cycle_id = shadow.cycle_id AND bound.decision_hash = shadow.decision_hash
          UNION ALL
          SELECT cycle_id, document #>> '{document,contentHash}', document->'document', xmin::text
            FROM autonomous_cycle_paper_closures
          UNION ALL
          SELECT cycle_id, document #>> '{document,contentHash}', document->'document', xmin::text
            FROM autonomous_cycle_paper_close_replans
        ) decision JOIN autonomous_cycles cycle USING(cycle_id)
        WHERE cycle.account_id = account AND decision.document #>> '{bindings,authorityGenerationHash}' = generation
          AND (decision.document->>'createdAt')::timestamptz BETWEEN registration.first_open_at AND registration.last_close_at
          AND (decision.document->>'createdAt')::timestamptz <= clock_timestamp()
          AND system_evidence_source_committed(decision.source_xid::xid) AND system_evidence_source_committed(cycle.xmin)
        ON CONFLICT DO NOTHING;
      INSERT INTO system_durable_observations(registration_hash, kind, source_hash, source_at, correct)
        SELECT registration.registration_hash, 'RECONCILIATION', reconciliation.content_hash, reconciliation.reconciled_at,
          reconciliation.status = 'EXACT' AND NOT EXISTS (
            SELECT 1 FROM mutation_events event JOIN intents intent USING(intent_id)
            WHERE intent.account_id = account AND event.occurred_at > reconciliation.reconciled_at)
        FROM reconciliations reconciliation
        WHERE reconciliation.account_id = account AND system_evidence_source_committed(reconciliation.xmin)
          AND reconciliation.reconciled_at BETWEEN registration.first_open_at AND registration.last_close_at
        ON CONFLICT DO NOTHING;
      INSERT INTO system_durable_observations(registration_hash, kind, source_hash, source_at, correct)
        SELECT registration.registration_hash, 'MUTATION', event.event_id, event.occurred_at, true
        FROM mutation_events event JOIN intents intent USING(intent_id)
        WHERE intent.account_id = account AND intent.authority_generation_hash = generation
          AND event.occurred_at >= registration.first_open_at AND system_evidence_source_committed(event.xmin)
        ON CONFLICT DO NOTHING;
    END LOOP;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER retain_execution_controller_observation AFTER INSERT OR UPDATE ON execution_controller_status
    FOR EACH ROW EXECUTE FUNCTION retain_execution_controller_observation()`
  for (const table of [
    'system_assessment_receipts',
    'system_replay_execution_receipts',
    'system_evidence_cuts',
    'execution_controller_observations',
    'system_durable_observations',
  ]) {
    yield* sql.unsafe(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`)
    yield* sql.unsafe(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`)
  }
})
