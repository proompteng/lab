import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/** Admit the pure ETF policy and evidence without rewriting historical generations or observations. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE native_protection_cancel_commands ADD COLUMN reanchor boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT native_protection_cancel_reanchor_not_exit CHECK (NOT reanchor OR exit_target IS NULL)`
  // Mirror the integer adverse tick rounding used by actualAlphaProtectionPrices, without numeric division rounding.
  yield* sql`CREATE FUNCTION intraday_alpha_v3_protective_price(
    weighted numeric, quantity numeric, bps integer, round_up boolean
  ) RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT AS $function$
    DECLARE numerator numeric := weighted * (10000 + bps);
      denominator numeric := quantity * 1000 * 10000;
      tick numeric;
    BEGIN
      tick := CASE WHEN numerator >= denominator * 1000000 THEN 10000 ELSE 100 END;
      denominator := denominator * tick;
      RETURN div(numerator + CASE WHEN round_up THEN denominator - 1 ELSE 0 END, denominator) * tick;
    END $function$`
  yield* sql`CREATE FUNCTION intraday_alpha_v3_protection_matches(candidate intents, root jsonb, plan jsonb, tag text)
    RETURNS boolean LANGUAGE plpgsql STABLE AS $function$
    DECLARE direction integer := CASE WHEN tag IN ('EquityShortOco','EquityShortStopLimit') THEN 1 ELSE -1 END;
      terms jsonb := plan #> '{levels,fillAnchored}';
      stop_bps integer := (terms->>'stopBps')::integer;
      collar_bps integer := (terms->>'collarBps')::integer;
      filled numeric; weighted numeric; unposted bigint;
      trigger_price numeric; stop_limit numeric; profit_limit numeric;
    BEGIN
      IF NOT COALESCE(
        root #>> '{bindings,accountId}' = candidate.account_id AND candidate.strategy_name = 'jev'
        AND root #>> '{bindings,strategyDecisionHash}' = candidate.decision_hash
        AND root #>> '{bindings,policyHash}' = candidate.policy_hash
        AND (root->>'createdAt')::timestamptz <= candidate.created_at
        AND candidate.symbol IN ('QQQ','SMH')
        AND candidate.time_in_force = 'DAY'
        AND candidate.side = CASE WHEN direction=1 THEN 'BUY' ELSE 'SELL' END
        AND ((direction=1) = COALESCE(plan #>> '{levels,positionSide}' = 'SHORT', false))
        AND stop_bps BETWEEN 150 AND 600 AND collar_bps BETWEEN 50 AND 150
        AND (terms->>'profitBps')::integer = 1500, false
      ) THEN RETURN false; END IF;

      SELECT sum(f.quantity_atoms), sum(f.price_atoms * f.quantity_atoms),
        count(*) FILTER (WHERE r.broker_event_id IS NULL OR a.broker_event_id IS NULL)
      INTO filled, weighted, unposted
      FROM fills f JOIN intents entry ON entry.intent_id=f.intent_id
      LEFT JOIN accounting_transactions a ON a.broker_event_id=f.event_id AND a.intent_id=f.intent_id
      LEFT JOIN accounting_receipts r ON r.broker_event_id=f.event_id AND r.intent_id=f.intent_id
      WHERE root->'orderedIntentIds' ? f.intent_id AND entry.state='TERMINAL'
        AND entry.cycle_id=candidate.cycle_id AND f.account_id=candidate.account_id
        AND f.symbol=candidate.symbol AND f.side = CASE WHEN direction=1 THEN 'SELL' ELSE 'BUY' END;
      IF NOT COALESCE(filled >= candidate.quantity_atoms AND (plan->>'maximumQuantityAtoms')::numeric >= filled
        AND unposted=0 AND weighted>0, false) THEN RETURN false; END IF;
      trigger_price := intraday_alpha_v3_protective_price(weighted, filled, direction * stop_bps, direction=1);
      stop_limit := intraday_alpha_v3_protective_price(weighted, filled, direction * (stop_bps + collar_bps), direction=-1);
      profit_limit := intraday_alpha_v3_protective_price(weighted, filled, -direction * 1500, direction=-1);
      RETURN COALESCE((candidate.protection->>'stopPriceMicros')::numeric = trigger_price
        AND CASE WHEN tag IN ('Oco','EquityShortOco') THEN
          candidate.order_type = 'LIMIT' AND mod(candidate.quantity_atoms,1000000000)=0
          AND (candidate.protection->>'stopLimitPriceMicros')::numeric = stop_limit
          AND (candidate.protection->>'profitLimitPriceMicros')::numeric = profit_limit
          AND candidate.limit_price_micros = profit_limit
        ELSE candidate.order_type='STOP_LIMIT' AND candidate.limit_price_micros=stop_limit END, false);
    END $function$`
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
        IF strpos(constraint_row.ddl, '''bayn.intraday-alpha-policy.v2''::text') = 0
            OR strpos(constraint_row.ddl, '''bayn.intraday-alpha-policy.v3''') > 0 THEN
          RAISE EXCEPTION 'unexpected intraday-alpha v3 authority constraint predecessor: %', constraint_row.name
            USING ERRCODE = '55000';
        END IF;
        definition := replace(constraint_row.ddl, ' NOT VALID', '');
        definition := replace(
          definition,
          '''bayn.intraday-alpha-policy.v2''::text',
          '''bayn.intraday-alpha-policy.v2''::text, ''bayn.intraday-alpha-policy.v3''::text'
        );
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',
          constraint_row.relation, constraint_row.name, constraint_row.name, definition);
      END LOOP;

      SELECT pg_get_constraintdef(oid) INTO STRICT definition
        FROM pg_constraint
        WHERE conrelid = 'intraday_candidate_observations'::regclass
          AND conname = 'intraday_candidate_observations_check';
      IF strpos(definition, '''bayn.intraday-alpha-observation.v2''::text') = 0
          OR strpos(definition, '''bayn.intraday-alpha-observation.v3''') > 0 THEN
        RAISE EXCEPTION 'unexpected intraday-alpha v3 observation constraint predecessor' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, ' NOT VALID', '');
      definition := replace(
        definition,
        '''bayn.intraday-alpha-observation.v2''::text',
        '''bayn.intraday-alpha-observation.v2''::text, ''bayn.intraday-alpha-observation.v3''::text'
      );
      EXECUTE 'ALTER TABLE intraday_candidate_observations DROP CONSTRAINT intraday_candidate_observations_check, '
        || 'ADD CONSTRAINT intraday_candidate_observations_check ' || definition || ' NOT VALID';

      definition := pg_get_functiondef('enforce_entry_policy_identity()'::regprocedure);
      IF strpos(definition, '''bayn.intraday-alpha-policy.v2''') = 0
          OR strpos(definition, '''bayn.intraday-alpha-policy.v3''') > 0 THEN
        RAISE EXCEPTION 'unexpected intraday-alpha v3 entry policy guard predecessor' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(
        definition,
        '''bayn.intraday-alpha-policy.v2''',
        '''bayn.intraday-alpha-policy.v2'', ''bayn.intraday-alpha-policy.v3'''
      );

      definition := pg_get_functiondef('enforce_strategy_protection_plan()'::regprocedure);
      IF strpos(definition, '''bayn.intraday-alpha-target.v2''') = 0
          OR strpos(definition, '''bayn.intraday-alpha-target.v3''') > 0 THEN
        RAISE EXCEPTION 'unexpected intraday-alpha v3 protection guard predecessor' USING ERRCODE = '55000';
      END IF;
      definition := replace(
        definition,
        '''bayn.intraday-alpha-target.v2''',
        '''bayn.intraday-alpha-target.v2'', ''bayn.intraday-alpha-target.v3'''
      );
      IF strpos(definition, 'plan := root #> ARRAY') = 0 THEN
        RAISE EXCEPTION 'unexpected protection plan guard body' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(definition, 'IF NOT COALESCE(', $anchor$
      IF root #>> '{strategyDecision,schemaVersion}' = 'bayn.intraday-alpha-target.v3'
        AND tag IN ('Oco','EquityShortOco','StopLimit','EquityShortStopLimit') THEN
        IF NOT intraday_alpha_v3_protection_matches(NEW, root, plan, tag) THEN
          RAISE EXCEPTION 'v3 native protection must derive from bound, accounted entry fills' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF NOT COALESCE($anchor$);

      SELECT pg_get_functiondef('system_strategy_bound_registration_valid(json)'::regprocedure) INTO STRICT definition;
      IF strpos(definition, $old$WHEN 'INTRADAY_ALPHA_V2' THEN 'bayn.intraday-alpha-policy.v2'$old$) = 0 THEN
        RAISE EXCEPTION 'unexpected strategy-bound registration validator' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, $old$WHEN 'INTRADAY_ALPHA_V2' THEN 'bayn.intraday-alpha-policy.v2'$old$,
        $new$WHEN 'INTRADAY_ALPHA_V2' THEN 'bayn.intraday-alpha-policy.v2'
             WHEN 'INTRADAY_ALPHA_V3' THEN 'bayn.intraday-alpha-policy.v3'$new$);
      EXECUTE replace(definition, $old$'JEV_V44','INTRADAY_ALPHA_V2'$old$, $new$'JEV_V44','INTRADAY_ALPHA_V2','INTRADAY_ALPHA_V3'$new$);

      SELECT pg_get_functiondef('enqueue_alpha_observation_evidence()'::regprocedure) INTO STRICT definition;
      IF strpos(definition, $old$IS DISTINCT FROM 'bayn.intraday-alpha-observation.v2'$old$) = 0 THEN
        RAISE EXCEPTION 'unexpected alpha observation enqueue guard' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, $old$IS DISTINCT FROM 'bayn.intraday-alpha-observation.v2'$old$,
        $new$NOT IN ('bayn.intraday-alpha-observation.v2','bayn.intraday-alpha-observation.v3')$new$);
      EXECUTE replace(definition, $old$='INTRADAY_ALPHA_V2'$old$,
        $new$= CASE NEW.payload->>'schemaVersion' WHEN 'bayn.intraday-alpha-observation.v3'
          THEN 'INTRADAY_ALPHA_V3' ELSE 'INTRADAY_ALPHA_V2' END$new$);

      SELECT pg_get_functiondef('guard_alpha_observation_witness()'::regprocedure) INTO STRICT definition;
      EXECUTE replace(definition, $old$observation.payload->>'schemaVersion'='bayn.intraday-alpha-observation.v2'$old$,
        $new$observation.payload->>'schemaVersion' IN ('bayn.intraday-alpha-observation.v2','bayn.intraday-alpha-observation.v3')$new$);

      SELECT conname AS name, pg_get_constraintdef(oid) AS ddl INTO STRICT constraint_row
        FROM pg_constraint WHERE conrelid='intraday_alpha_baseline_preparations'::regclass
          AND strpos(pg_get_constraintdef(oid), '''bayn.intraday-alpha-policy.v2''') > 0;
      EXECUTE format('ALTER TABLE intraday_alpha_baseline_preparations DROP CONSTRAINT %I, ADD CONSTRAINT %I %s',
        constraint_row.name, constraint_row.name, replace(constraint_row.ddl,
          $old$(payload #>> '{policy,schemaVersion}'::text[]) = 'bayn.intraday-alpha-policy.v2'::text$old$,
          $new$(payload #>> '{policy,schemaVersion}'::text[]) IN ('bayn.intraday-alpha-policy.v2','bayn.intraday-alpha-policy.v3')$new$));
      SELECT pg_get_functiondef('enqueue_alpha_baseline_evidence()'::regprocedure) INTO STRICT definition;
      EXECUTE replace(definition, $old$='INTRADAY_ALPHA_V2'$old$, $new$ IN ('INTRADAY_ALPHA_V2','INTRADAY_ALPHA_V3')$new$);

      SELECT pg_get_functiondef('guard_alpha_baseline_preparation()'::regprocedure) INTO STRICT definition;
      EXECUTE replace(definition, $old$'avgSwingByCheckpoint',checkpoint.minute])::numeric > 0$old$,
        $new$'avgSwingByCheckpoint',checkpoint.minute])::numeric >= 0
          AND (source #>> '{policy,schemaVersion}'='bayn.intraday-alpha-policy.v3'
            OR (source #>> ARRAY['acquisition','trailingBaseline','symbols',requested.symbol,'avgSwingByCheckpoint',checkpoint.minute])::numeric > 0)$new$);

      -- V3 keeps the existing gross/net and loss limits but can reserve up to 65% of the $180k gross cap per ETF.
      SELECT pg_get_functiondef('admit_system_qualification_registration()'::regprocedure) INTO STRICT definition;
      EXECUTE replace(replace(definition,
        $old$(policy #>> '{riskPolicy,maxOrderNotionalMicros}')::numeric BETWEEN 0 AND 40000000000$old$,
        $new$(policy #>> '{riskPolicy,maxOrderNotionalMicros}')::numeric BETWEEN 0 AND CASE
          WHEN policy #>> '{strategyBinding,engine}'='INTRADAY_ALPHA_V3' THEN 117000000000 ELSE 40000000000 END$new$),
        $old$(policy #>> '{riskPolicy,maxSymbolExposureMicros}')::numeric BETWEEN 0 AND 40000000000$old$,
        $new$(policy #>> '{riskPolicy,maxSymbolExposureMicros}')::numeric BETWEEN 0 AND CASE
          WHEN policy #>> '{strategyBinding,engine}'='INTRADAY_ALPHA_V3' THEN 117000000000 ELSE 40000000000 END$new$);
    END $migration$`
  yield* sql`CREATE INDEX intraday_candidate_observations_alpha_v3_window
    ON intraday_candidate_observations (
      cycle_id, (payload #>> '{portfolio,purpose}'), (payload #>> '{manifest,rangeEndAt}')
    ) WHERE payload ->> 'schemaVersion' = 'bayn.intraday-alpha-observation.v3'`
  yield* sql`CREATE INDEX intraday_candidate_observations_alpha_v3_entry_window
    ON intraday_candidate_observations (
      (payload #>> '{portfolio,purpose}'), (payload #>> '{manifest,rangeEndAt}') DESC, cycle_id
    ) WHERE payload ->> 'schemaVersion' = 'bayn.intraday-alpha-observation.v3'`
})
