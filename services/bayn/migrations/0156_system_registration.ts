import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE system_qualification_origin (
    program text PRIMARY KEY CHECK (program = 'BAYN_SYSTEM_QUALIFICATION'),
    prior_attempt_count integer NOT NULL CHECK (prior_attempt_count BETWEEN 0 AND 1000000),
    prior_attempt_hash text NOT NULL CHECK (prior_attempt_hash ~ '^[0-9a-f]{64}$'),
    history_evidence_text text NOT NULL,
    history_evidence_hash text NOT NULL CHECK (
      history_evidence_hash = encode(sha256(convert_to(history_evidence_text, 'UTF8')), 'hex')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (jsonb_typeof(history_evidence_text::jsonb) = 'object'
      AND history_evidence_text::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.system-qualification-history.v1'
      AND history_evidence_text::jsonb->>'program' IS NOT DISTINCT FROM program
      AND jsonb_typeof(history_evidence_text::jsonb->'attempts') IS NOT DISTINCT FROM 'array'
      AND jsonb_array_length(history_evidence_text::jsonb->'attempts') IS NOT DISTINCT FROM prior_attempt_count
      AND prior_attempt_hash IS NOT DISTINCT FROM CASE WHEN prior_attempt_count = 0 THEN history_evidence_hash
        ELSE history_evidence_text::jsonb->'attempts'->-1->>'planHash' END)
  )`
  yield* sql`CREATE FUNCTION admit_system_qualification_origin() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE audited_at timestamptz;
  BEGIN
    NEW.created_at := clock_timestamp();
    audited_at := (NEW.history_evidence_text::jsonb->>'auditedAt')::timestamptz;
    IF audited_at IS NULL OR audited_at > NEW.created_at THEN
      RAISE EXCEPTION 'qualification history audit cannot be absent or in the future' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER system_qualification_origin_admission BEFORE INSERT ON system_qualification_origin
    FOR EACH ROW EXECUTE FUNCTION admit_system_qualification_origin()`
  yield* sql`CREATE TABLE system_qualification_registrations (
    registration_hash text PRIMARY KEY CHECK (registration_hash ~ '^[0-9a-f]{64}$'),
    program text NOT NULL REFERENCES system_qualification_origin(program),
    attempt_index integer NOT NULL CHECK (attempt_index BETWEEN 1 AND 1000000),
    prior_attempt_hash text NOT NULL CHECK (prior_attempt_hash ~ '^[0-9a-f]{64}$'),
    registered_at timestamptz NOT NULL,
    first_open_at timestamptz NOT NULL,
    last_close_at timestamptz NOT NULL,
    payload_text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (program, attempt_index),
    CHECK (registration_hash = encode(sha256(convert_to(payload_text, 'UTF8')), 'hex')),
    CHECK (registered_at < first_open_at AND first_open_at < last_close_at),
    CHECK (jsonb_typeof(payload_text::jsonb) = 'object'
      AND payload_text::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.system-registration.v2'
      AND jsonb_typeof(payload_text::jsonb->'costAllocationPlans') IS NOT DISTINCT FROM 'array'
      AND payload_text::jsonb->>'environment' IS NOT DISTINCT FROM 'PAPER'
      AND payload_text::jsonb->>'program' IS NOT DISTINCT FROM program
      AND (payload_text::jsonb->>'attemptIndex')::integer IS NOT DISTINCT FROM attempt_index
      AND payload_text::jsonb->>'priorAttemptHash' IS NOT DISTINCT FROM prior_attempt_hash
      AND (payload_text::jsonb->>'registeredAt')::timestamptz IS NOT DISTINCT FROM registered_at
      AND (payload_text::jsonb #>> '{calendar,sessions,0,openAt}')::timestamptz IS NOT DISTINCT FROM first_open_at
      AND (payload_text::jsonb #>> '{calendar,sessions,19,closeAt}')::timestamptz IS NOT DISTINCT FROM last_close_at
      AND jsonb_array_length(payload_text::jsonb #> '{calendar,sessions}') IS NOT DISTINCT FROM 20
      AND jsonb_array_length(payload_text::jsonb->'policies') IS NOT DISTINCT FROM 4)
  )`
  yield* sql`CREATE FUNCTION admit_system_qualification_registration() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE prior_index integer; prior_hash text; deployed_count integer; deployed_matches boolean; risk_bounded boolean;
  BEGIN
    SELECT bool_and((
      jsonb_typeof(policy->'riskPolicy') = 'object'
      AND policy #>> '{riskPolicy,schemaVersion}' = 'bayn.execution-risk-policy.v4'
      AND (policy #>> '{riskPolicy,maxOrderNotionalMicros}')::numeric BETWEEN 0 AND 40000000000
      AND (policy #>> '{riskPolicy,maxSymbolExposureMicros}')::numeric BETWEEN 0 AND 40000000000
      AND (policy #>> '{riskPolicy,maxGrossExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxNetExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric BETWEEN 0 AND 200000000000
    ) IS TRUE) INTO risk_bounded FROM jsonb_array_elements(NEW.payload_text::jsonb->'policies') policy;
    IF risk_bounded IS NOT TRUE THEN
      RAISE EXCEPTION 'registered risk exceeds the frozen qualification ceilings or lacks material' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), bool_and(
      policy->>'strategyHash' IS NOT DISTINCT FROM '3da39b009a0cb2052b007ae9ba51f448c16b69281a37cf5ffe122314f1d801af'
      AND policy->>'parametersHash' IS NOT DISTINCT FROM 'cd004b8b43e50dde70ba70fb43deff19c5c65d60f4455e84a2e8df9991c0335f'
      AND policy->>'protocolHash' IS NOT DISTINCT FROM 'f38c7d47dc0b8eedb13da1ae7e29faa3da2ce8983fee05f4a2c89dc0ec59eb97'
    ) INTO deployed_count, deployed_matches
      FROM jsonb_array_elements(NEW.payload_text::jsonb->'policies') policy
      WHERE policy->>'policy' = 'DEPLOYED_BAYN';
    IF deployed_count <> 1 OR deployed_matches IS NOT TRUE THEN
      RAISE EXCEPTION 'deployed control must preserve the frozen pre-Jev identity' USING ERRCODE = '23514';
    END IF;
    SELECT prior_attempt_count, prior_attempt_hash INTO STRICT prior_index, prior_hash
      FROM system_qualification_origin WHERE program = NEW.program FOR UPDATE;
    SELECT attempt_index, registration_hash INTO prior_index, prior_hash
      FROM system_qualification_registrations WHERE program = NEW.program ORDER BY attempt_index DESC LIMIT 1;
    IF NOT FOUND THEN
      SELECT prior_attempt_count, prior_attempt_hash INTO STRICT prior_index, prior_hash
        FROM system_qualification_origin WHERE program = NEW.program;
    END IF;
    IF NEW.attempt_index <> prior_index + 1 OR NEW.prior_attempt_hash <> prior_hash THEN
      RAISE EXCEPTION 'qualification attempt must extend the immutable history' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := clock_timestamp();
    IF NEW.registered_at > NEW.created_at OR NEW.first_open_at <= NEW.created_at THEN
      RAISE EXCEPTION 'qualification must be registered before its first open' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER system_qualification_registration_admission BEFORE INSERT ON system_qualification_registrations
    FOR EACH ROW EXECUTE FUNCTION admit_system_qualification_registration()`
  yield* sql`CREATE FUNCTION check_system_registration_commit_deadline() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    IF clock_timestamp() >= NEW.first_open_at THEN
      RAISE EXCEPTION 'registration committed after the first open' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE CONSTRAINT TRIGGER system_registration_commit_deadline AFTER INSERT ON system_qualification_registrations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_system_registration_commit_deadline()`
  for (const table of ['system_qualification_origin', 'system_qualification_registrations']) {
    yield* sql.unsafe(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`)
    yield* sql.unsafe(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`)
  }
})
