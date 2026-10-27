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
      AND payload_text::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.system-source-cut.v4'
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
  yield* sql`CREATE TABLE execution_decision_admissions (
    event_id text NOT NULL REFERENCES mutation_events(event_id),
    decision_id text NOT NULL CHECK (decision_id ~ '^[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(event_id, decision_id)
  )`
  yield* sql`CREATE FUNCTION guard_execution_decision_admission() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    IF pg_trigger_depth() <> 2 THEN
      RAISE EXCEPTION 'decision admission evidence requires its mutation source trigger' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER execution_decision_admission_guard BEFORE INSERT ON execution_decision_admissions
    FOR EACH ROW EXECUTE FUNCTION guard_execution_decision_admission()`
  yield* sql`CREATE FUNCTION retain_submission_decision_admission() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE target intents;
  BEGIN
    IF NEW.event_type <> 'SUBMIT_STARTED' THEN RETURN NEW; END IF;
    SELECT * INTO STRICT target FROM intents WHERE intent_id = NEW.intent_id;
    INSERT INTO execution_decision_admissions(event_id, decision_id)
      SELECT NEW.event_id, source.document->>'contentHash' FROM (
        SELECT shadow.document, shadow.xmin::text AS source_xid
        FROM autonomous_cycle_shadow_decisions shadow JOIN autonomous_cycles cycle
          ON cycle.cycle_id = shadow.cycle_id AND cycle.decision_hash = shadow.decision_hash
        WHERE shadow.cycle_id = target.cycle_id
        UNION ALL
        SELECT document->'document', xmin::text FROM autonomous_cycle_paper_closures WHERE cycle_id = target.cycle_id
        UNION ALL
        SELECT document->'document', xmin::text FROM autonomous_cycle_paper_close_replans WHERE cycle_id = target.cycle_id
      ) source
      WHERE (source.document->'orderedIntentIds' ? NEW.intent_id OR (
          target.protection->>'_tag' IN ('Oco','StopLimit')
          AND target.protection->>'entryDecisionHash' = source.document->>'contentHash'
          AND EXISTS(SELECT 1 FROM risk_decisions risk WHERE risk.intent_id=target.intent_id
            AND risk.decision_id=target.risk_decision_id AND risk.outcome='APPROVED'
            AND risk.decided_at<=NEW.occurred_at AND risk.expires_at>=NEW.occurred_at
            AND system_evidence_source_committed(risk.xmin))))
        AND source.document #>> '{bindings,accountId}' = target.account_id
        AND source.document #>> '{bindings,authorityGenerationHash}' = target.authority_generation_hash
        AND source.document #>> '{bindings,strategyDecisionHash}' = target.decision_hash
        AND source.document #>> '{bindings,policyHash}' = target.policy_hash
        AND (source.document->>'createdAt')::timestamptz <= NEW.occurred_at
        AND system_evidence_source_committed(source.source_xid::xid)
      ON CONFLICT DO NOTHING;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER retain_submission_decision_admission AFTER INSERT ON mutation_events
    FOR EACH ROW EXECUTE FUNCTION retain_submission_decision_admission()`
  yield* sql`CREATE INDEX system_qualification_registration_window
    ON system_qualification_registrations(last_close_at, first_open_at)`
  yield* sql`CREATE TABLE system_pending_evidence (
    registration_hash text NOT NULL REFERENCES system_qualification_registrations(registration_hash),
    kind text NOT NULL CHECK (kind IN ('DECISION', 'RECONCILIATION', 'MUTATION', 'CONTROLLER', 'BATCH')),
    source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    source_at timestamptz NOT NULL,
    correct boolean NOT NULL,
    PRIMARY KEY(registration_hash, kind, source_hash)
  )`
  yield* sql`CREATE INDEX system_pending_evidence_due ON system_pending_evidence(registration_hash, source_at)`
  yield* sql`CREATE FUNCTION guard_system_pending_evidence() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    IF pg_trigger_depth() < 2 OR TG_OP = 'UPDATE' OR TG_OP = 'TRUNCATE' THEN
      RAISE EXCEPTION 'pending evidence is maintained by source and witness triggers' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE FUNCTION queue_system_evidence(s_kind text, s_hash text, s_at timestamptz,
    s_window_at timestamptz, s_issued_at timestamptz, s_account text, s_generation text,
    s_controller text, s_plan text, s_correct boolean) RETURNS void LANGUAGE plpgsql AS $function$
  DECLARE observed_at timestamptz := clock_timestamp();
  BEGIN
    IF s_hash IS NULL OR s_at IS NULL THEN RETURN; END IF;
    s_window_at := coalesce(s_window_at, s_at);
    -- The queue row commits with its source and deferred bindings. A later transaction supplies the witness time.
    INSERT INTO system_pending_evidence(registration_hash, kind, source_hash, source_at, correct)
      SELECT registration.registration_hash, s_kind, s_hash, s_at, s_correct
      FROM system_qualification_registrations registration
      CROSS JOIN LATERAL jsonb_array_elements(registration.payload_text::jsonb->'policies') policy
      JOIN authority_generations generation ON generation.generation_hash = policy->>'authorityGenerationHash'
      WHERE policy->>'policy' = 'JEV'
        AND registration.last_close_at >= observed_at - interval '1 day'
        AND (s_kind IN ('RECONCILIATION', 'CONTROLLER') OR generation.generation_hash = s_generation)
        AND (s_kind = 'CONTROLLER' OR generation.account_id = s_account)
        AND (s_kind <> 'CONTROLLER' OR (generation.broker_identity_hash = s_controller
          AND registration.payload_text::jsonb #>> '{obligations,configuration,controllerPlanHash}' = s_plan))
        AND ((s_kind = 'MUTATION' AND s_at >= registration.first_open_at)
          OR (s_kind = 'BATCH' AND s_window_at >= registration.first_open_at AND s_window_at < registration.last_close_at)
          OR (s_kind IN ('DECISION', 'RECONCILIATION', 'CONTROLLER')
            AND (s_window_at BETWEEN registration.first_open_at AND registration.last_close_at
              OR s_issued_at BETWEEN registration.first_open_at AND registration.last_close_at)))
        AND NOT EXISTS (SELECT 1 FROM system_durable_observations prior
          WHERE prior.registration_hash = registration.registration_hash AND prior.kind = s_kind AND prior.source_hash = s_hash)
      ON CONFLICT DO NOTHING;
  END $function$`
  yield* sql`CREATE FUNCTION enqueue_system_evidence() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE s_kind text; s_hash text; s_at timestamptz; s_window_at timestamptz; s_issued_at timestamptz;
    s_account text; s_generation text; s_controller text; s_plan text; s_document jsonb; s_correct boolean := true;
  BEGIN
    CASE TG_TABLE_NAME
      WHEN 'execution_controller_observations' THEN
        s_kind := 'CONTROLLER'; s_hash := NEW.status->>'last_receipt_hash';
        s_at := (NEW.status->>'completed_at')::timestamptz;
        s_issued_at := (NEW.status #>> '{last_pass,executionIssuedAt}')::timestamptz;
        s_controller := NEW.controller_key; s_plan := NEW.status->>'plan_hash';
        IF jsonb_typeof(NEW.status->'last_pass') IS DISTINCT FROM 'object' THEN RETURN NEW; END IF;
      WHEN 'jev_batch_results' THEN
        s_kind := 'BATCH'; s_hash := NEW.result_hash; s_at := (NEW.payload->>'completedAt')::timestamptz;
        SELECT cycle.account_id, plan.authority_generation_hash, (plan.payload->>'observedAt')::timestamptz
          INTO STRICT s_account, s_generation, s_window_at
          FROM jev_batch_plans plan JOIN autonomous_cycles cycle USING(cycle_id) WHERE plan.batch_id = NEW.batch_id;
      WHEN 'autonomous_cycle_shadow_decisions', 'autonomous_cycle_paper_closures', 'autonomous_cycle_paper_close_replans' THEN
        s_kind := 'DECISION';
        s_document := CASE WHEN TG_TABLE_NAME = 'autonomous_cycle_shadow_decisions' THEN NEW.document
          ELSE NEW.document->'document' END;
        s_hash := s_document->>'contentHash'; s_at := (s_document->>'createdAt')::timestamptz;
        s_generation := s_document #>> '{bindings,authorityGenerationHash}';
        SELECT account_id INTO STRICT s_account FROM autonomous_cycles WHERE cycle_id = NEW.cycle_id;
      WHEN 'reconciliations' THEN
        s_kind := 'RECONCILIATION'; s_hash := NEW.content_hash; s_at := NEW.reconciled_at;
        s_account := NEW.account_id; s_correct := NEW.status = 'EXACT';
      WHEN 'mutation_events' THEN
        s_kind := 'MUTATION'; s_hash := NEW.event_id; s_at := NEW.occurred_at;
        SELECT account_id, authority_generation_hash INTO STRICT s_account, s_generation
          FROM intents WHERE intent_id = NEW.intent_id;
      ELSE RAISE EXCEPTION 'unsupported evidence source %', TG_TABLE_NAME;
    END CASE;
    PERFORM queue_system_evidence(s_kind, s_hash, s_at, s_window_at, s_issued_at,
      s_account, s_generation, s_controller, s_plan, s_correct);
    RETURN NEW;
  END $function$`
  for (const table of [
    'execution_controller_observations',
    'jev_batch_results',
    'autonomous_cycle_shadow_decisions',
    'autonomous_cycle_paper_closures',
    'autonomous_cycle_paper_close_replans',
    'reconciliations',
    'mutation_events',
  ]) {
    yield* sql.unsafe(`CREATE TRIGGER ${table}_system_evidence AFTER INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION enqueue_system_evidence()`)
  }
  yield* sql`DO $migration$
  DECLARE source record; observed_at timestamptz := clock_timestamp();
  BEGIN
    -- Migration 156 may already have admitted an active registration. Retain its existing sources once.
    FOR source IN
      SELECT * FROM (
        SELECT 'BATCH' AS kind, result.result_hash AS hash, (result.payload->>'completedAt')::timestamptz AS at,
          (plan.payload->>'observedAt')::timestamptz AS window_at, cycle.account_id AS account,
          plan.authority_generation_hash AS generation, true AS correct
        FROM jev_batch_results result JOIN jev_batch_plans plan USING(batch_id)
          JOIN autonomous_cycles cycle USING(cycle_id)
        UNION ALL
        SELECT 'DECISION', shadow.decision_hash, shadow.created_at, shadow.created_at, cycle.account_id,
          shadow.document #>> '{bindings,authorityGenerationHash}', true
        FROM autonomous_cycle_shadow_decisions shadow JOIN autonomous_cycles cycle
          ON cycle.cycle_id = shadow.cycle_id AND cycle.decision_hash = shadow.decision_hash
        UNION ALL
        SELECT 'DECISION', closure.close_decision_hash, (closure.document #>> '{document,createdAt}')::timestamptz,
          (closure.document #>> '{document,createdAt}')::timestamptz, cycle.account_id,
          closure.document #>> '{document,bindings,authorityGenerationHash}', true
        FROM autonomous_cycle_paper_closures closure JOIN autonomous_cycles cycle USING(cycle_id)
        UNION ALL
        SELECT 'DECISION', replan.close_decision_hash, (replan.document #>> '{document,createdAt}')::timestamptz,
          (replan.document #>> '{document,createdAt}')::timestamptz, cycle.account_id,
          replan.document #>> '{document,bindings,authorityGenerationHash}', true
        FROM autonomous_cycle_paper_close_replans replan JOIN autonomous_cycles cycle USING(cycle_id)
        UNION ALL
        SELECT 'RECONCILIATION', content_hash, reconciled_at, reconciled_at, account_id, NULL, status = 'EXACT'
        FROM reconciliations
        UNION ALL
        SELECT 'MUTATION', event.event_id, event.occurred_at, event.occurred_at,
          intent.account_id, intent.authority_generation_hash, true
        FROM mutation_events event JOIN intents intent USING(intent_id)
      ) candidates WHERE at >= (SELECT min(first_open_at) FROM system_qualification_registrations
        WHERE last_close_at >= observed_at - interval '1 day')
    LOOP
      PERFORM queue_system_evidence(source.kind, source.hash, source.at, source.window_at, NULL,
        source.account, source.generation, NULL, NULL, source.correct);
    END LOOP;
  END $migration$`
  yield* sql`CREATE TRIGGER system_pending_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON system_pending_evidence
    FOR EACH ROW EXECUTE FUNCTION guard_system_pending_evidence()`
  yield* sql`CREATE TRIGGER system_pending_evidence_no_truncate BEFORE TRUNCATE ON system_pending_evidence
    FOR EACH STATEMENT EXECUTE FUNCTION guard_system_pending_evidence()`
  yield* sql`CREATE FUNCTION retain_execution_controller_observation() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE registration record; account text; controller_identity text; generation text;
    observed_at timestamptz := clock_timestamp();
  BEGIN
    IF NEW.last_receipt_hash IS NOT NULL AND jsonb_typeof(NEW.last_pass) = 'object'
      AND (TG_OP = 'INSERT' OR NEW.last_receipt_hash IS DISTINCT FROM OLD.last_receipt_hash
        OR NEW.last_sequence IS DISTINCT FROM OLD.last_sequence OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
        OR NEW.last_pass IS DISTINCT FROM OLD.last_pass OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash) THEN
      INSERT INTO execution_controller_observations(controller_key, status) VALUES (NEW.controller_key, to_jsonb(NEW));
    END IF;
    FOR registration IN SELECT * FROM system_qualification_registrations
      WHERE first_open_at <= observed_at AND last_close_at >= observed_at - interval '1 day'
        AND payload_text::jsonb #>> '{obligations,configuration,controllerPlanHash}' = NEW.plan_hash LOOP
      SELECT policy->>'authorityGenerationHash' INTO generation
        FROM jsonb_array_elements(registration.payload_text::jsonb->'policies') policy WHERE policy->>'policy' = 'JEV';
      SELECT account_id, broker_identity_hash INTO account, controller_identity FROM authority_generations WHERE generation_hash = generation;
      IF account IS NULL OR controller_identity IS DISTINCT FROM NEW.controller_key THEN CONTINUE; END IF;
      INSERT INTO system_durable_observations(registration_hash, kind, source_hash, source_at, correct)
          SELECT pending.registration_hash, pending.kind, pending.source_hash, pending.source_at, pending.correct
          FROM system_pending_evidence pending
          WHERE pending.registration_hash = registration.registration_hash AND pending.source_at <= observed_at
            AND system_evidence_source_committed(pending.xmin)
          ON CONFLICT DO NOTHING;
      DELETE FROM system_pending_evidence pending USING system_durable_observations witnessed
        WHERE pending.registration_hash = registration.registration_hash
          AND pending.registration_hash = witnessed.registration_hash AND pending.kind = witnessed.kind
          AND pending.source_hash = witnessed.source_hash;
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
    'execution_decision_admissions',
  ]) {
    yield* sql.unsafe(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`)
    yield* sql.unsafe(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`)
  }
})
