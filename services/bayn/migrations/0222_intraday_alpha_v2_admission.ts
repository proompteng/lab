import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * Admit the three-engine disjoint concurrent intraday alpha strategy (bayn.intraday-alpha-policy.v2)
 * and the multi-sleeve Sandbox risk policy (bayn.execution-risk-policy.v6, $180k gross cap)
 * alongside existing v1 and legacy policies without disrupting active authority.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DO $migration$
    DECLARE
      definition text;
      constraint_row record;
      previous text;
      replacement text;
    BEGIN
      FOR constraint_row IN SELECT conrelid::regclass AS relation, conname AS name, pg_get_constraintdef(oid) AS ddl
        FROM pg_constraint
        WHERE (conrelid = 'authority_generations'::regclass AND conname IN (
          'authority_generations_strategy_parameter_schema_version_check',
          'authority_generations_strategy_contract_check'
        ))
      LOOP
        IF strpos(constraint_row.ddl, '''bayn.intraday-alpha-policy.v1''::text') = 0
            OR strpos(constraint_row.ddl, '''bayn.intraday-alpha-policy.v2''') > 0 THEN
          RAISE EXCEPTION 'unexpected intraday-alpha v2 authority constraint predecessor: %', constraint_row.name
            USING ERRCODE = '55000';
        END IF;
        definition := replace(constraint_row.ddl, ' NOT VALID', '');
        definition := replace(
          definition,
          '''bayn.intraday-alpha-policy.v1''::text',
          '''bayn.intraday-alpha-policy.v1''::text, ''bayn.intraday-alpha-policy.v2''::text'
        );
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',
          constraint_row.relation, constraint_row.name, constraint_row.name, definition);
      END LOOP;

      SELECT pg_get_constraintdef(oid) INTO STRICT definition
        FROM pg_constraint
        WHERE conrelid = 'intraday_candidate_observations'::regclass
          AND conname = 'intraday_candidate_observations_check';
      IF strpos(definition, '''bayn.intraday-alpha-observation.v1''::text') = 0
          OR strpos(definition, '''bayn.intraday-alpha-observation.v2''') > 0 THEN
        RAISE EXCEPTION 'unexpected intraday-alpha v2 observation constraint predecessor' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, ' NOT VALID', '');
      definition := replace(
        definition,
        '''bayn.intraday-alpha-observation.v1''::text',
        '''bayn.intraday-alpha-observation.v1''::text, ''bayn.intraday-alpha-observation.v2''::text'
      );
      EXECUTE 'ALTER TABLE intraday_candidate_observations DROP CONSTRAINT intraday_candidate_observations_check, '
        || 'ADD CONSTRAINT intraday_candidate_observations_check ' || definition || ' NOT VALID';

      definition := pg_get_functiondef('enforce_entry_policy_identity()'::regprocedure);
      IF strpos(definition, '''bayn.intraday-alpha-policy.v1''') = 0
          OR strpos(definition, '''bayn.intraday-alpha-policy.v2''') > 0 THEN
        RAISE EXCEPTION 'unexpected intraday-alpha v2 entry policy guard predecessor' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(
        definition,
        '''bayn.intraday-alpha-policy.v1''',
        '''bayn.intraday-alpha-policy.v1'', ''bayn.intraday-alpha-policy.v2'''
      );

      definition := pg_get_functiondef('enforce_strategy_protection_plan()'::regprocedure);
      IF strpos(definition, '''bayn.intraday-alpha-target.v1''') = 0
          OR strpos(definition, '''bayn.intraday-alpha-target.v2''') > 0 THEN
        RAISE EXCEPTION 'unexpected intraday-alpha v2 protection guard predecessor' USING ERRCODE = '55000';
      END IF;
      definition := replace(
        definition,
        '''bayn.intraday-alpha-target.v1''',
        '''bayn.intraday-alpha-target.v1'', ''bayn.intraday-alpha-target.v2'''
      );
      EXECUTE definition;

      SELECT pg_get_functiondef('admit_system_qualification_registration()'::regprocedure) INTO STRICT definition;
      previous := $previous$AND (policy #>> '{riskPolicy,maxGrossExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxNetExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxDailyLossMicros}')::numeric BETWEEN 0 AND 5000000000
      AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric BETWEEN 0 AND 10000000000
      AND ((policy #>> '{riskPolicy,schemaVersion}' = 'bayn.execution-risk-policy.v4'
        AND (((policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric = 200000000000 AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 5000000000)
          OR ((policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric = 1000000000000 AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 10000000000)))
        OR (policy #>> '{riskPolicy,schemaVersion}' = 'bayn.execution-risk-policy.v5'
          AND policy #> '{riskPolicy,maxDailyTradedNotionalMicros}' = 'null'::jsonb
          AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 10000000000))$previous$;
      replacement := $replacement$AND (policy #>> '{riskPolicy,maxNetExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxDailyLossMicros}')::numeric BETWEEN 0 AND 5000000000
      AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric BETWEEN 0 AND 10000000000
      AND (((policy #>> '{riskPolicy,schemaVersion}' = 'bayn.execution-risk-policy.v4'
          AND (policy #>> '{riskPolicy,maxGrossExposureMicros}')::numeric BETWEEN 0 AND 100000000000
          AND (((policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric = 200000000000 AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 5000000000)
            OR ((policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric = 1000000000000 AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 10000000000)))
        OR (policy #>> '{riskPolicy,schemaVersion}' = 'bayn.execution-risk-policy.v5'
          AND (policy #>> '{riskPolicy,maxGrossExposureMicros}')::numeric BETWEEN 0 AND 100000000000
          AND policy #> '{riskPolicy,maxDailyTradedNotionalMicros}' = 'null'::jsonb
          AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 10000000000)
        OR (policy #>> '{riskPolicy,schemaVersion}' = 'bayn.execution-risk-policy.v6'
          AND (policy #>> '{riskPolicy,maxGrossExposureMicros}')::numeric BETWEEN 0 AND 180000000000
          AND policy #> '{riskPolicy,maxDailyTradedNotionalMicros}' = 'null'::jsonb
          AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 10000000000)))$replacement$;
      IF strpos(definition, previous) = 0 THEN
        RAISE EXCEPTION 'unexpected prior qualification risk policy for v6 admission' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(definition, previous, replacement);
    END $migration$`
  yield* sql`CREATE INDEX intraday_candidate_observations_alpha_v2_window
    ON intraday_candidate_observations (
      cycle_id, (payload #>> '{portfolio,purpose}'), (payload #>> '{manifest,rangeEndAt}')
    ) WHERE payload ->> 'schemaVersion' = 'bayn.intraday-alpha-observation.v2'`
  yield* sql`CREATE INDEX intraday_candidate_observations_alpha_v2_entry_window
    ON intraday_candidate_observations (
      (payload #>> '{portfolio,purpose}'), (payload #>> '{manifest,rangeEndAt}') DESC, cycle_id
    ) WHERE payload ->> 'schemaVersion' = 'bayn.intraday-alpha-observation.v2'`
})
