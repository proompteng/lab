import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * Admit the two-phase intraday alpha strategy (bayn.intraday-alpha-policy.v1) alongside
 * existing v44 and research control policies without disrupting active v44 authority.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DO $migration$
    DECLARE
      definition text;
      constraint_row record;
    BEGIN
      FOR constraint_row IN SELECT conrelid::regclass AS relation, conname AS name, pg_get_constraintdef(oid) AS ddl
        FROM pg_constraint
        WHERE (conrelid = 'authority_generations'::regclass AND conname IN (
          'authority_generations_strategy_parameter_schema_version_check',
          'authority_generations_strategy_contract_check'
        ))
      LOOP
        IF strpos(constraint_row.ddl, '''bayn.repeated-momentum-policy.v1''::text') = 0
            OR strpos(constraint_row.ddl, '''bayn.intraday-alpha-policy.v1''') > 0 THEN
          RAISE EXCEPTION 'unexpected intraday-alpha authority constraint predecessor: %', constraint_row.name
            USING ERRCODE = '55000';
        END IF;
        definition := replace(constraint_row.ddl, ' NOT VALID', '');
        definition := replace(
          definition,
          '''bayn.repeated-momentum-policy.v1''::text',
          '''bayn.repeated-momentum-policy.v1''::text, ''bayn.intraday-alpha-policy.v1''::text'
        );
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',
          constraint_row.relation, constraint_row.name, constraint_row.name, definition);
      END LOOP;

      SELECT pg_get_constraintdef(oid) INTO STRICT definition
        FROM pg_constraint
        WHERE conrelid = 'intraday_candidate_observations'::regclass
          AND conname = 'intraday_candidate_observations_check';
      IF strpos(definition, '''bayn.jev-observation.v1''::text') = 0
          OR strpos(definition, '''bayn.intraday-alpha-observation.v1''') > 0 THEN
        RAISE EXCEPTION 'unexpected intraday-alpha observation constraint predecessor' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, ' NOT VALID', '');
      definition := replace(
        definition,
        '''bayn.jev-observation.v1''::text',
        '''bayn.jev-observation.v1''::text, ''bayn.intraday-alpha-observation.v1''::text'
      );
      EXECUTE 'ALTER TABLE intraday_candidate_observations DROP CONSTRAINT intraday_candidate_observations_check, '
        || 'ADD CONSTRAINT intraday_candidate_observations_check ' || definition || ' NOT VALID';

      definition := pg_get_functiondef('enforce_entry_policy_identity()'::regprocedure);
      IF strpos(definition, 'declared = ''bayn.repeated-momentum-policy.v1''') = 0
          OR strpos(definition, '''bayn.intraday-alpha-policy.v1''') > 0 THEN
        RAISE EXCEPTION 'unexpected intraday-alpha entry policy guard predecessor' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(
        definition,
        'declared = ''bayn.repeated-momentum-policy.v1''',
        'declared IN (''bayn.repeated-momentum-policy.v1'', ''bayn.intraday-alpha-policy.v1'')'
      );

      definition := pg_get_functiondef('enforce_strategy_protection_plan()'::regprocedure);
      IF strpos(definition, '''bayn.repeated-momentum-target.v1''') = 0
          OR strpos(definition, 'root #>> ''{strategyDecision,schemaVersion}''=''bayn.jev-entry-target.v7''') = 0
          OR strpos(definition, 'plan->>''schemaVersion''=''bayn.jev-short-funded-exit-plan.v1''') = 0
          OR strpos(definition, 'plan #>> ''{levels,schemaVersion}''=''bayn.jev-short-strategy-exit-plan.v1''') = 0
          OR strpos(definition, '''bayn.intraday-alpha-target.v1''') > 0 THEN
        RAISE EXCEPTION 'unexpected intraday-alpha protection guard predecessor' USING ERRCODE = '55000';
      END IF;
      definition := replace(
        definition,
        '''bayn.repeated-momentum-target.v1''',
        '''bayn.repeated-momentum-target.v1'', ''bayn.intraday-alpha-target.v1'''
      );
      definition := replace(
        definition,
        'root #>> ''{strategyDecision,schemaVersion}''=''bayn.jev-entry-target.v7''',
        'root #>> ''{strategyDecision,schemaVersion}'' IN (''bayn.jev-entry-target.v7'', ''bayn.intraday-alpha-target.v1'')'
      );
      definition := replace(
        definition,
        'plan->>''schemaVersion''=''bayn.jev-short-funded-exit-plan.v1''',
        'plan->>''schemaVersion'' IN (''bayn.jev-short-funded-exit-plan.v1'', ''bayn.intraday-alpha-short-funded-exit-plan.v1'')'
      );
      definition := replace(
        definition,
        'plan #>> ''{levels,schemaVersion}''=''bayn.jev-short-strategy-exit-plan.v1''',
        'plan #>> ''{levels,schemaVersion}'' IN (''bayn.jev-short-strategy-exit-plan.v1'', ''bayn.intraday-alpha-short-exit-levels.v1'')'
      );
      EXECUTE definition;
    END $migration$`
  yield* sql`CREATE INDEX intraday_candidate_observations_alpha_window
    ON intraday_candidate_observations (
      cycle_id, (payload #>> '{portfolio,purpose}'), (payload #>> '{manifest,rangeEndAt}')
    ) WHERE payload ->> 'schemaVersion' = 'bayn.intraday-alpha-observation.v1'`
  yield* sql`CREATE INDEX intraday_candidate_observations_alpha_entry_window
    ON intraday_candidate_observations (
      (payload #>> '{portfolio,purpose}'), (payload #>> '{manifest,rangeEndAt}') DESC, cycle_id
    ) WHERE payload ->> 'schemaVersion' = 'bayn.intraday-alpha-observation.v1'`
})
