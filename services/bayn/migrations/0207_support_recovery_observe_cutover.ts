import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Fail closed under contention or an unexpectedly slow guard. These are per-acquisition and per-statement limits,
  // not a claim that the whole transaction has a 250 ms budget. Failure leaves the mandate-bearing incumbent alive.
  yield* sql`SET LOCAL lock_timeout = '250ms'`
  yield* sql`SET LOCAL statement_timeout = '1500ms'`
  yield* sql`DO $lock$ BEGIN
    IF NOT pg_try_advisory_xact_lock(1111578958, 1) THEN
      RAISE EXCEPTION 'support-recovery OBSERVE cutover writer fence is busy' USING ERRCODE = '55P03';
    END IF;
  END $lock$`
  // Source ingress writes source_events before invalidating observations. Preserve that order. SHARE ROW EXCLUSIVE
  // blocks evidence writers but not readers; lock acquisition and each guarded statement fail quickly on delay.
  yield* sql`LOCK TABLE broker_source_events, broker_observations, broker_notification_receipts,
    broker_source_event_projections, intents, mutation_events, autonomous_cycles, authority_generations,
    authority_state, broker_events, fills, orders, position_snapshots, accounting_transactions,
    accounting_receipts, broker_inventory_debits, reconciliations, broker_cash_settlements,
    broker_fee_accruals, broker_fee_match_corrections, broker_fee_accounting,
    broker_fee_posting_acknowledgements, jev_evaluation_requests, jev_evaluation_receipts,
    jev_inference_handoffs, jev_evaluation_resolutions, jev_chart_dispatch_claims,
    jev_chart_terminal_receipts, inference_expense_quotes, jev_staged_dispatch_claims,
    jev_staged_terminal_receipts, jev_staged_skip_receipts IN SHARE ROW EXCLUSIVE MODE`
  // Retiring a mandate must survive controller restarts and overlapping old binaries. Keep the evidence immutable and
  // enforce it at the history admission boundary: recovery may add an OBSERVE successor, but no process can append a
  // new PAPER generation for this account until a later reviewed migration installs a new authorization epoch.
  yield* sql`CREATE TABLE IF NOT EXISTS public.research_capital_activation_retirements (
    schema_version text NOT NULL CHECK (schema_version='bayn.research-capital-activation-retirement.v1'),
    account_id text PRIMARY KEY CHECK (length(account_id)>0 AND account_id=btrim(account_id)),
    retired_generation_hash text NOT NULL UNIQUE CHECK (retired_generation_hash ~ '^[0-9a-f]{64}$'),
    reason text NOT NULL CHECK (reason='SUPPORT_RECOVERY_V41_RETIRED'),
    retired_at timestamptz NOT NULL
  )`
  yield* sql`LOCK TABLE public.research_capital_activation_retirements IN SHARE ROW EXCLUSIVE MODE`
  yield* sql`DROP TRIGGER IF EXISTS research_capital_activation_retirements_append_only
    ON public.research_capital_activation_retirements`
  yield* sql`CREATE TRIGGER research_capital_activation_retirements_append_only
    BEFORE UPDATE OR DELETE ON public.research_capital_activation_retirements
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`DROP TRIGGER IF EXISTS research_capital_activation_retirements_reject_truncate
    ON public.research_capital_activation_retirements`
  yield* sql`CREATE TRIGGER research_capital_activation_retirements_reject_truncate
    BEFORE TRUNCATE ON public.research_capital_activation_retirements
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_research_capital_activation_retirement()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF NEW.maximum='PAPER' AND EXISTS (
        SELECT 1 FROM public.research_capital_activation_retirements retirement
        WHERE retirement.account_id=NEW.account_id
      ) THEN
        RAISE EXCEPTION 'research capital activation is retired for account %', NEW.account_id
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $function$`
  yield* sql`DROP TRIGGER IF EXISTS authority_generations_research_capital_retirement
    ON authority_generations`
  yield* sql`CREATE TRIGGER authority_generations_research_capital_retirement
    BEFORE INSERT ON authority_generations
    FOR EACH ROW EXECUTE FUNCTION enforce_research_capital_activation_retirement()`
  // History admission is the normal activation boundary, but a PAPER generation may already exist if an older
  // transaction committed its immutable history before this migration acquired the writer locks. Fence the state
  // transition too, so dormant history cannot be activated after retirement. The only PAPER state update retained
  // for the retired account is a same-generation OBSERVE/ACTIVE restriction such as the cutover below.
  yield* sql`CREATE OR REPLACE FUNCTION enforce_research_capital_state_retirement()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      target_account_id text;
    BEGIN
      IF NEW.maximum <> 'PAPER' THEN RETURN NEW; END IF;

      SELECT generation.account_id INTO target_account_id
      FROM public.authority_generations generation
      WHERE generation.generation_hash=NEW.generation_hash;

      IF EXISTS (
        SELECT 1 FROM public.research_capital_activation_retirements retirement
        WHERE retirement.account_id=target_account_id
      ) AND (
        TG_OP='INSERT'
        OR NEW.generation_hash IS DISTINCT FROM OLD.generation_hash
        OR NEW.effective <> 'OBSERVE'
        OR NEW.kill_state <> 'ACTIVE'
      ) THEN
        RAISE EXCEPTION 'research capital state activation is retired for account %', target_account_id
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $function$`
  yield* sql`DROP TRIGGER IF EXISTS authority_state_research_capital_retirement
    ON authority_state`
  yield* sql`CREATE TRIGGER authority_state_research_capital_retirement
    BEFORE INSERT OR UPDATE ON authority_state
    FOR EACH ROW EXECUTE FUNCTION enforce_research_capital_state_retirement()`
  // The v42 runtime cannot protect v41 positions. Restrict only the exact settled v41 generation, after the
  // direct broker stream and its canonical financial reconciliation have covered the complete durable source cut.
  yield* sql`DO $cutover$
    DECLARE
      target_generation_hash text;
      target_account_id text;
    BEGIN
      SELECT state.generation_hash, generation.account_id
        INTO target_generation_hash, target_account_id
      FROM authority_state state JOIN authority_generations generation USING (generation_hash)
      WHERE generation.strategy_name='jev'
        AND generation.strategy_parameter_schema_version='bayn.jev.protocol.v41'
        AND generation.strategy_behavior_hash='76f0e134e622ada19cb1b087d83da60b54a36d33c86c6c0eee2642ee3fbd3e67'
        AND generation.strategy_parameter_hash='004604dcc48754ff553976d366a4d7643a6a3a1157acac4b89acc879b56c4696'
        AND generation.strategy_protocol_hash='b97dc08473946b82b89f9e4bfae09d18c4bae4ebd8b854f5a6b2b805e35a19c9'
        AND state.maximum='PAPER' AND state.effective='PAPER' AND state.kill_state='CLEAR'
        AND state.reason IS NULL;
      -- Empty installations, successor protocols and existing restrictions remain untouched.
      IF target_generation_hash IS NULL THEN RETURN; END IF;

      IF EXISTS (SELECT 1 FROM intents WHERE account_id=target_account_id AND state <> 'TERMINAL')
        OR EXISTS (SELECT 1 FROM autonomous_cycles WHERE state IN ('PENDING', 'ACTIVE'))
        OR EXISTS (
          SELECT 1 FROM (
            SELECT symbol, quantity_delta_atoms AS quantity, cost_basis_delta_micros AS cost
              FROM accounting_transactions WHERE account_id=target_account_id
            UNION ALL
            SELECT symbol, -quantity_atoms, -cost_basis_micros
              FROM broker_inventory_debits WHERE account_id=target_account_id AND posted
          ) inventory GROUP BY symbol HAVING sum(quantity) <> 0 OR sum(cost) <> 0
        )
        OR COALESCE((
          SELECT position_count FROM position_snapshots WHERE account_id=target_account_id
          ORDER BY observed_at DESC, snapshot_id DESC LIMIT 1
        ), -1) <> 0
        OR EXISTS (
          SELECT 1 FROM accounting_transactions transaction
          LEFT JOIN accounting_receipts receipt USING (broker_event_id)
          WHERE transaction.account_id=target_account_id AND receipt.receipt_id IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM broker_cash_settlements
          WHERE account_id=target_account_id AND posted_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM broker_fee_match_corrections
          WHERE account_id=target_account_id AND posted_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM broker_fee_accruals accrual
          WHERE accrual.account_id=target_account_id AND (
            accrual.posted_at IS NULL OR NOT EXISTS (
              SELECT 1 FROM broker_fee_posting_acknowledgements posting
              WHERE posting.account_id=accrual.account_id AND posting.source_kind='ACCRUAL'
                AND posting.source_id=accrual.accrual_id AND posting.ledger_plan_hash=accrual.ledger_plan_hash
            )
          )
        )
        OR EXISTS (
          SELECT 1 FROM broker_fee_accounting fee
          WHERE fee.account_id=target_account_id AND (
            fee.posted_at IS NULL OR NOT EXISTS (
              SELECT 1 FROM broker_fee_posting_acknowledgements posting
              WHERE posting.account_id=fee.account_id AND posting.source_kind='ACTIVITY'
                AND posting.source_id=fee.activity_id AND posting.ledger_plan_hash=fee.ledger_plan_hash
            )
          )
        )
        OR EXISTS (
          SELECT 1 FROM fills fill
          LEFT JOIN accounting_transactions transaction ON transaction.broker_event_id=fill.event_id
          WHERE transaction.transaction_id IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM (
            SELECT DISTINCT ON (observed.account_id, observed.broker_order_id) observed.status
            FROM orders observed JOIN broker_events event USING (event_id)
            WHERE observed.account_id=target_account_id
            ORDER BY observed.account_id, observed.broker_order_id,
              observed.broker_updated_at COLLATE "C" DESC, event.source_sequence DESC
          ) latest WHERE status IN ('NEW', 'PENDING', 'PARTIALLY_FILLED', 'HELD')
        )
        OR EXISTS (
          SELECT 1 FROM authority_state state JOIN authority_generations generation USING (generation_hash)
          LEFT JOIN LATERAL (
            SELECT status, reconciled_at FROM reconciliations reconciliation
            WHERE reconciliation.account_id=generation.account_id
            ORDER BY reconciled_at DESC, reconciliation_id DESC LIMIT 1
          ) latest ON true
          WHERE state.generation_hash=target_generation_hash
            AND (latest.status IS DISTINCT FROM 'EXACT'
              OR latest.reconciled_at IS NULL
              OR latest.reconciled_at > clock_timestamp()
              OR latest.reconciled_at < clock_timestamp() - interval '60 seconds'
              OR latest.reconciled_at < (
                SELECT max(mutation.occurred_at) FROM mutation_events mutation
                JOIN intents intent USING (intent_id) WHERE intent.account_id=target_account_id
              ))
        )
        OR NOT EXISTS (
          SELECT 1 FROM broker_source_events
          WHERE account_id=target_account_id AND event_kind='SessionReady'
        )
        OR EXISTS (
          SELECT 1 FROM broker_source_events event
          LEFT JOIN broker_source_event_projections projection USING (account_id,event_id)
          WHERE event.account_id=target_account_id AND projection.event_id IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM broker_notification_receipts receipt
          LEFT JOIN broker_source_events event USING (account_id,event_id)
          WHERE receipt.account_id=target_account_id AND event.event_id IS NULL
        )
        OR NOT EXISTS (
          SELECT 1 FROM broker_observations observation
          WHERE observation.account_id=target_account_id AND observation.available
            AND observation.notification_fence_at >= (
              SELECT max(event.recorded_at) FROM broker_source_events event
              WHERE event.account_id=target_account_id
            )
            AND observation.financial_reconciliation_fence_at >= (
              SELECT max(event.recorded_at) FROM broker_source_events event
              WHERE event.account_id=target_account_id
            )
        )
        OR EXISTS (
          WITH unresolved AS MATERIALIZED (
            SELECT request.payload FROM jev_evaluation_requests request
            LEFT JOIN jev_evaluation_resolutions resolution USING (request_id)
            WHERE resolution.request_id IS NULL
          )
          SELECT 1 FROM unresolved WHERE (payload->>'expiresAt')::timestamptz > clock_timestamp()
        )
      THEN
        RAISE EXCEPTION 'support-recovery OBSERVE cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete posted accounting, durable broker coverage and no unexpired inference claims'
          USING ERRCODE = '55000';
      END IF;

      INSERT INTO public.research_capital_activation_retirements(
        schema_version,account_id,retired_generation_hash,reason,retired_at
      ) VALUES(
        'bayn.research-capital-activation-retirement.v1',target_account_id,target_generation_hash,
        'SUPPORT_RECOVERY_V41_RETIRED',clock_timestamp()
      ) ON CONFLICT (account_id) DO NOTHING;
      IF NOT EXISTS (
        SELECT 1 FROM public.research_capital_activation_retirements
        WHERE account_id=target_account_id AND retired_generation_hash=target_generation_hash
          AND reason='SUPPORT_RECOVERY_V41_RETIRED'
      ) THEN
        RAISE EXCEPTION 'research capital activation retirement conflicts with the v41 incumbent'
          USING ERRCODE='55000';
      END IF;

      UPDATE authority_state state
      SET effective='OBSERVE', kill_state='ACTIVE', reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
        version=state.version+1,
        updated_at=greatest(clock_timestamp(), state.updated_at + interval '1 millisecond')
      WHERE state.generation_hash=target_generation_hash;
    END $cutover$`
})
