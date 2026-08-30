import { PgClient } from '@effect/sql-pg'
import { DiscrepancyKind } from '../../execution/contracts'
import { CashYieldEvidenceRow, ReconciliationRow } from './model'

export const SIGNED_I128_MIN = -(1n << 127n)
export const SIGNED_I128_MAX = (1n << 127n) - 1n
export const INTEGER_PATTERN = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/

export type GenerationScopeTarget =
  | 'cycle'
  | 'unclosed-cycle'
  | 'intent'
  | 'transaction'
  | 'reconciliation'
  | 'snapshot'
  | 'opening-snapshot'
  | 'order'
  | 'fill'
  | 'mutation'

export const generationScope = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash: string | undefined,
  target: GenerationScopeTarget,
) => {
  if (authorityGenerationHash === undefined) return true

  switch (target) {
    case 'cycle':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND COALESCE(scope_generation.qualification_run_id, scope_generation.research_plan_hash)
            = cycle.qualification_run_id
          AND cycle.account_id = scope_generation.account_id
          AND (
            EXISTS (
              SELECT 1
              FROM autonomous_cycle_shadow_decisions AS scoped_decision
              WHERE scoped_decision.cycle_id = cycle.cycle_id
                AND scoped_decision.decision_hash = cycle.decision_hash
                AND scoped_decision.schema_version = 'bayn.paper-cycle-decision.v1'
                AND scoped_decision.document ->> 'mode' = 'PAPER'
                AND scoped_decision.document #>> '{bindings,accountId}' = scope_generation.account_id
                AND scoped_decision.document #>> '{bindings,qualificationRunId}' = cycle.qualification_run_id
                AND scoped_decision.document #>> '{bindings,authorityGenerationHash}' = scope_generation.generation_hash
            )
            OR EXISTS (
              SELECT 1
              FROM intents AS scoped_intent
              WHERE scoped_intent.cycle_id = cycle.cycle_id
                AND scoped_intent.account_id = scope_generation.account_id
                AND scoped_intent.authority_generation_hash = scope_generation.generation_hash
            )
            OR (
              cycle.state IN ('PENDING', 'ACTIVE', 'BLOCKED')
              AND cycle.created_at >= scope_generation.activated_at
              AND NOT EXISTS (
                SELECT 1
                FROM authority_generations AS next_generation
                WHERE next_generation.previous_generation_hash = scope_generation.generation_hash
                  AND cycle.created_at >= next_generation.activated_at
              )
            )
          )
      )`
    case 'unclosed-cycle':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        LEFT JOIN authority_generations AS next_generation
          ON next_generation.previous_generation_hash = scope_generation.generation_hash
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND COALESCE(scope_generation.qualification_run_id, scope_generation.research_plan_hash)
            = cycle.qualification_run_id
          AND cycle.account_id = scope_generation.account_id
          AND cycle.created_at >= scope_generation.activated_at
          AND (
            next_generation.activated_at IS NULL
            OR cycle.created_at < next_generation.activated_at
          )
      )`
    case 'intent':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        LEFT JOIN authority_generations AS next_generation
          ON next_generation.previous_generation_hash = scope_generation.generation_hash
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND intent.account_id = scope_generation.account_id
          AND intent.authority_generation_hash = scope_generation.generation_hash
          AND intent.created_at >= scope_generation.activated_at
          AND (
            next_generation.activated_at IS NULL
            OR intent.created_at < next_generation.activated_at
          )
      )`
    case 'transaction':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        JOIN intents AS scope_intent
          ON scope_intent.intent_id = transaction.intent_id
          AND scope_intent.account_id = transaction.account_id
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND transaction.account_id = scope_generation.account_id
          AND scope_intent.authority_generation_hash = scope_generation.generation_hash
      )`
    case 'reconciliation':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        LEFT JOIN authority_generations AS next_generation
          ON next_generation.previous_generation_hash = scope_generation.generation_hash
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND reconciliation.account_id = scope_generation.account_id
          AND reconciliation.reconciled_at >= scope_generation.activated_at
          AND (
            next_generation.activated_at IS NULL
            OR reconciliation.reconciled_at < next_generation.activated_at
          )
      )`
    case 'snapshot':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        LEFT JOIN authority_generations AS next_generation
          ON next_generation.previous_generation_hash = scope_generation.generation_hash
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND snapshot.account_id = scope_generation.account_id
          AND event.observed_at >= scope_generation.activated_at
          AND (
            next_generation.activated_at IS NULL
            OR event.observed_at < next_generation.activated_at
          )
      )`
    case 'opening-snapshot':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
      )`
    case 'order':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        JOIN intents AS scope_intent
          ON scope_intent.intent_id = observed_order.intent_id
          AND scope_intent.account_id = observed_order.account_id
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND scope_intent.authority_generation_hash = scope_generation.generation_hash
      )`
    case 'fill':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        JOIN intents AS scope_intent
          ON scope_intent.intent_id = fill.intent_id
          AND scope_intent.account_id = fill.account_id
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND scope_intent.authority_generation_hash = scope_generation.generation_hash
      )`
    case 'mutation':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        JOIN intents AS scope_intent
          ON scope_intent.intent_id = event.intent_id
          AND scope_intent.account_id = ${accountId}
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND scope_intent.authority_generation_hash = scope_generation.generation_hash
      )`
  }
}

export const openingSnapshotBoundary = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash: string | undefined,
) =>
  authorityGenerationHash === undefined
    ? sql`first_cycle.submission_open_at`
    : sql`GREATEST(
        first_cycle.submission_open_at,
        (
          SELECT scope_generation.activated_at
          FROM authority_generations AS scope_generation
          WHERE scope_generation.generation_hash = ${authorityGenerationHash}
            AND scope_generation.maximum = 'PAPER'
            AND scope_generation.account_id = ${accountId}
        )
      )`

export const closingSnapshotBoundary = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash: string | undefined,
) =>
  authorityGenerationHash === undefined
    ? sql`latest_reconciliation.reconciled_at`
    : sql`LEAST(
        latest_reconciliation.reconciled_at,
        COALESCE(
          (
            SELECT MAX(cycle.terminal_at)
            FROM autonomous_cycles AS cycle
            WHERE cycle.account_id = ${accountId}
              AND cycle.state IN ('COMPLETED', 'NO_TRADE')
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
          ),
          latest_reconciliation.reconciled_at
        ),
        COALESCE(
          (
            SELECT MIN(next_generation.activated_at) - INTERVAL '1 microsecond'
            FROM authority_generations AS next_generation
            WHERE next_generation.previous_generation_hash = ${authorityGenerationHash}
              AND next_generation.maximum = 'PAPER'
              AND next_generation.account_id = ${accountId}
          ),
          latest_reconciliation.reconciled_at
        ),
        COALESCE(
          (
            SELECT MIN(next_intent.created_at) - INTERVAL '1 microsecond'
            FROM authority_generations AS next_generation
            JOIN intents AS next_intent
              ON next_intent.authority_generation_hash = next_generation.generation_hash
              AND next_intent.account_id = next_generation.account_id
            WHERE next_generation.previous_generation_hash = ${authorityGenerationHash}
              AND next_generation.maximum = 'PAPER'
              AND next_generation.account_id = ${accountId}
          ),
          latest_reconciliation.reconciled_at
        )
      )`

export const ledgerReplayBoundary = (sql: PgClient.PgClient) => sql`latest_reconciliation.reconciled_at`

export const signedI128 = (value: string): bigint | undefined => {
  if (!INTEGER_PATTERN.test(value)) return undefined
  const parsed = BigInt(value)
  return parsed < SIGNED_I128_MIN || parsed > SIGNED_I128_MAX ? undefined : parsed
}

export const reconciliationExactness = (
  accountId: string,
  reconciliation: typeof ReconciliationRow.Type,
  cashYield: typeof CashYieldEvidenceRow.Type | undefined,
): { readonly performanceExact: boolean; readonly cashYieldAdjustedExact: boolean } => {
  if (reconciliation.status === 'EXACT') {
    return {
      performanceExact: reconciliation.discrepancies.length === 0,
      cashYieldAdjustedExact: false,
    }
  }
  const discrepancy = reconciliation.discrepancies[0]
  if (
    cashYield === undefined ||
    reconciliation.discrepancies.length !== 1 ||
    discrepancy === undefined ||
    discrepancy.kind !== DiscrepancyKind.Cash ||
    discrepancy.identity !== accountId ||
    discrepancy.lastObservedAt !== reconciliation.reconciled_at.toISOString() ||
    cashYield.reconciliation_id !== reconciliation.reconciliation_id ||
    cashYield.reconciliation_content_hash !== reconciliation.content_hash ||
    cashYield.reconciled_at.toISOString() !== reconciliation.reconciled_at.toISOString()
  ) {
    return { performanceExact: false, cashYieldAdjustedExact: false }
  }

  const baselineCash = signedI128(cashYield.baseline_cash_micros)
  const openingCash = signedI128(cashYield.opening_cash_micros)
  const preWindowCashDelta = signedI128(cashYield.pre_window_accounted_cash_delta_micros)
  const preWindowResidual = signedI128(cashYield.pre_window_cash_residual_micros)
  const closingCash = signedI128(cashYield.closing_cash_micros)
  const accountedCashDelta = signedI128(cashYield.accounted_cash_delta_micros)
  const yieldAmount = signedI128(cashYield.cash_yield_micros)
  const expectedCash = signedI128(discrepancy.expected)
  const observedCash = signedI128(discrepancy.observed)
  if (
    baselineCash === undefined ||
    openingCash === undefined ||
    preWindowCashDelta === undefined ||
    preWindowResidual === undefined ||
    closingCash === undefined ||
    accountedCashDelta === undefined ||
    yieldAmount === undefined ||
    expectedCash === undefined ||
    observedCash === undefined ||
    yieldAmount <= 0n ||
    preWindowResidual !== 0n ||
    openingCash !== baselineCash + preWindowCashDelta ||
    expectedCash !== openingCash + accountedCashDelta ||
    observedCash !== closingCash ||
    observedCash - expectedCash !== yieldAmount ||
    closingCash - openingCash - accountedCashDelta !== yieldAmount
  ) {
    return { performanceExact: false, cashYieldAdjustedExact: false }
  }

  return { performanceExact: true, cashYieldAdjustedExact: true }
}
