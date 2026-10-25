import { ObservedFeeActivitySchema } from '../broker/fee-activity'
import { acknowledgeFeePosting, FeePostingKind, readAcknowledgedFeePostings } from './fee-posting'
import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { brokerFeeLedgerPlan, coinFeeLedgerPlan } from '../accounting/domain'
import type { FeeActivity } from '../broker/alpaca/model'
import { canonicalHashV1Result } from '../hash'
import { hashLedgerPlanResult } from '../ledger-plan'
import type { JournalService } from '../ledger'
import type { LedgerPlan } from '../ledger-plan'
import { strictParseOptions } from '../schemas'
import {
  brokerFeePredatesOpeningCash,
  FeeReadEvidenceSchema,
  StoredFeeSchema,
  verifyBrokerFeeRecord,
  prepareFeeMatchCorrection,
  type StoredBrokerFee,
} from '../accounting/broker-fees'
import type { Observed } from '../simulation-reconciliation/broker-reconciler-model'
import { ReconciliationStoreError } from './reconciliation'
import { readOpeningCash } from './account-baseline'
import { readFeeAccruals, postFeeAccruals } from './fee-accruals'

const invariant = (message: string, cause?: unknown) =>
  new ReconciliationStoreError({
    operation: 'reconcile',
    failure: 'invariant',
    message,
    ...(cause === undefined ? {} : { cause }),
  })
const fromResult = <A, E>(result: Result.Result<A, E>) =>
  Effect.fromResult(result).pipe(Effect.mapError((cause) => invariant('broker fee evidence is invalid', cause)))

export interface BrokerFeeAccounting {
  readonly fees: readonly FeeActivity[]
  readonly plans: readonly LedgerPlan[]
  readonly cashDeltaMicros: string
}

const prepareCashMatchCorrections = (
  sql: PgClient.PgClient,
  accountId: string,
  observed: readonly Observed<FeeActivity>[],
  stored: readonly StoredBrokerFee[],
  identity: { readonly clusterId: bigint; readonly ledger: number },
) =>
  Effect.gen(function* () {
    if (!stored.some((row) => row.posted && row.data.coinDebit === undefined && row.matched_cash_micros !== '0')) return
    const matches = yield* fromResult(
      Schema.decodeUnknownResult(
        Schema.Array(
          Schema.Struct({
            activityId: Schema.String,
            accrualId: Schema.String,
            activityCashMicros: Schema.String,
            accrualCashMicros: Schema.String,
          }),
        ),
      )(
        yield* sql`SELECT m.activity_id AS "activityId",m.accrual_id AS "accrualId",
        m.activity_cash_micros::text AS "activityCashMicros",m.accrual_cash_micros::text AS "accrualCashMicros"
        FROM broker_fee_accrual_matches m JOIN broker_fee_accounting f ON f.account_id=m.account_id AND f.activity_id=m.activity_id
        WHERE m.account_id=${accountId} AND m.activity_cash_micros IS NOT NULL AND f.posted_at IS NOT NULL
          AND (NOT(f.data ? 'cryptoCashFee') OR m.accrual_cash_micros>m.activity_cash_micros)
          AND NOT EXISTS(SELECT 1 FROM broker_fee_match_corrections c WHERE c.account_id=m.account_id AND c.activity_id=m.activity_id AND c.accrual_id=m.accrual_id)
        ORDER BY m.activity_id COLLATE "C",m.accrual_id COLLATE "C"`,
      ),
    )
    const byId = new Map(stored.map((row) => [row.data.activityId, row]))
    const observations = new Map(observed.map((row) => [row.value.activityId, row]))
    for (const { activityId, ...match } of matches) {
      const existing = byId.get(activityId)
      const source = observations.get(activityId)
      if (existing === undefined || source === undefined)
        return yield* invariant('fee correction requires the current provider observation and stored fee')
      const { sourceCreatedAt, ...fee } = yield* fromResult(
        Schema.decodeUnknownResult(ObservedFeeActivitySchema, strictParseOptions)(source.value),
      )
      const readEvidence = yield* fromResult(
        Schema.decodeUnknownResult(FeeReadEvidenceSchema)({
          requestId: source.evidence.requestId,
          status: source.evidence.status,
          contentHash: source.evidence.contentHash,
          observedAt: source.evidence.observedAt,
          ...(sourceCreatedAt === undefined ? {} : { sourceCreatedAt }),
        }),
      )
      const hash = yield* fromResult(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...fee }))
      if (hash !== existing.content_hash || fee.accountId !== accountId || fee.coinDebit !== undefined)
        return yield* invariant('fee correction provider content differs from the original fee')
      yield* fromResult(verifyBrokerFeeRecord(existing, accountId, identity))
      const prepared = yield* fromResult(
        prepareFeeMatchCorrection(
          {
            schemaVersion: fee.cryptoCashFee === true ? 'bayn.fee-match-correction.v2' : 'bayn.fee-match-correction.v1',
            accountId,
            activityId,
            feeContentHash: hash,
            ...match,
            readEvidence,
          },
          identity.ledger,
        ),
      )
      const planHash = yield* fromResult(hashLedgerPlanResult(prepared.plan))
      yield* sql`INSERT INTO broker_fee_match_corrections(correction_id,account_id,activity_id,accrual_id,cash_debit_micros,
        data,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger)
        VALUES(${prepared.correctionId},${accountId},${activityId},${match.accrualId},${prepared.cashDebitMicros},
          ${sql.json(prepared.data)},${prepared.contentHash},${planHash},${identity.clusterId.toString()},${identity.ledger})`
    }
  })

/** Called inside the account writer fence and reconciliation transaction. */
export const prepareFeeActivities = (
  sql: PgClient.PgClient,
  accountId: string,
  observed: readonly Observed<FeeActivity>[],
  identity: { readonly clusterId: bigint; readonly ledger: number },
): Effect.Effect<void, ReconciliationStoreError> =>
  Effect.gen(function* () {
    const assignedCoinQuantities = new Map<string, bigint>()
    const assignedCashAmounts = new Map<string, bigint>()
    const opening = observed.length === 0 ? undefined : yield* readOpeningCash(sql, accountId)
    if (opening !== undefined && observed.some(({ value }) => brokerFeePredatesOpeningCash(value, opening.observed_at)))
      return yield* invariant(
        'broker fee history predates the opening cash baseline; earlier baseline evidence is required',
      )
    const rows = yield* sql<Record<string, unknown>>`
    SELECT data,cash_match_corrections, COALESCE((SELECT sum(m.accrual_cash_micros) FROM broker_fee_accrual_matches m WHERE m.account_id=broker_fee_accounting.account_id AND m.activity_id=broker_fee_accounting.activity_id),0)::text AS matched_cash_micros, coin_cost_basis_micros::text AS coin_cost_basis_micros, read_evidence, content_hash, ledger_plan_hash, tigerbeetle_cluster_id::text AS tigerbeetle_cluster_id,
      tigerbeetle_ledger::integer AS tigerbeetle_ledger, posted_at IS NOT NULL AS posted
    FROM broker_fee_accounting_evidence AS broker_fee_accounting WHERE account_id = ${accountId} ORDER BY activity_id COLLATE "C"
  `
    const stored = yield* fromResult(
      Schema.decodeUnknownResult(Schema.Array(StoredFeeSchema), strictParseOptions)(rows),
    )
    yield* prepareCashMatchCorrections(sql, accountId, observed, stored, identity)
    const accruals = yield* readFeeAccruals(sql, accountId, identity)
    const byId = new Map(stored.map((row) => [row.data.activityId, row]))
    const seen = new Set<string>()
    const coinAdjustments = new Map<string, { quantity: bigint; cost: bigint }>()
    const prepared = yield* Effect.forEach(
      [...observed].sort((a, b) => a.value.activityId.localeCompare(b.value.activityId)),
      (observation) =>
        Effect.gen(function* () {
          const { sourceCreatedAt, ...fee } = yield* fromResult(
            Schema.decodeUnknownResult(ObservedFeeActivitySchema, strictParseOptions)(observation.value),
          )
          const readEvidence = yield* fromResult(
            Schema.decodeUnknownResult(FeeReadEvidenceSchema)({
              requestId: observation.evidence.requestId,
              status: observation.evidence.status,
              contentHash: observation.evidence.contentHash,
              observedAt: observation.evidence.observedAt,
              ...(sourceCreatedAt === undefined ? {} : { sourceCreatedAt }),
            }),
          )
          const sourceDate = sourceCreatedAt?.slice(0, 10) ?? fee.date
          if (
            fee.accountId !== accountId ||
            seen.has(fee.activityId) ||
            fee.date > observation.evidence.observedAt.slice(0, 10)
          )
            return yield* invariant('broker fee account, uniqueness, or date binding is invalid')
          seen.add(fee.activityId)
          const contentHash = yield* fromResult(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...fee }))
          const existing = byId.get(fee.activityId)
          if (
            existing?.read_evidence.sourceCreatedAt !== undefined &&
            existing.read_evidence.sourceCreatedAt !== sourceCreatedAt
          )
            return yield* invariant('broker fee source timestamp changed')
          const matches: {
            readonly accrualId: string
            readonly coinQuantityAtoms: string | null
            readonly activityCashMicros: string | null
            readonly accrualCashMicros: string | null
          }[] = []
          let ledgerCashDelta = BigInt(fee.netAmountMicros) + BigInt(existing?.matched_cash_micros ?? '0')
          let coinCostBasisMicros: string | null = existing?.coin_cost_basis_micros ?? null
          if (fee.coinDebit !== undefined && existing === undefined) {
            if (fee.netAmountMicros !== '0') return yield* invariant('coin fee cannot change cash')
            const coin = fee.coinDebit
            let debit = BigInt(coin.quantityAtoms)
            for (const accrual of accruals) {
              if (
                accrual.data.kind !== 'COIN' ||
                accrual.data.symbol !== coin.symbol ||
                accrual.settlement_date !== sourceDate
              )
                continue
              const available =
                BigInt(accrual.coin_quantity_atoms ?? '0') -
                BigInt(accrual.matched_coin_quantity_atoms) -
                (assignedCoinQuantities.get(accrual.accrualId) ?? 0n)
              const matched = available < debit ? available : debit
              if (matched <= 0n) continue
              matches.push({
                accrualId: accrual.accrualId,
                coinQuantityAtoms: matched.toString(),
                activityCashMicros: null,
                accrualCashMicros: null,
              })
              assignedCoinQuantities.set(
                accrual.accrualId,
                (assignedCoinQuantities.get(accrual.accrualId) ?? 0n) + matched,
              )
              debit -= matched
            }
            coinCostBasisMicros = '0'
            if (debit > 0n) {
              const balances = yield* sql<Record<string, unknown>>`
              SELECT
                COALESCE((SELECT sum(quantity_delta_atoms) FROM accounting_transactions WHERE account_id = ${accountId} AND symbol = ${coin.symbol}), 0)::text AS quantity,
                COALESCE((SELECT sum(cost_basis_delta_micros) FROM accounting_transactions WHERE account_id = ${accountId} AND symbol = ${coin.symbol}), 0)::text AS cost,
                COALESCE((SELECT sum(quantity_atoms) FROM broker_inventory_debits WHERE account_id = ${accountId} AND symbol = ${coin.symbol}), 0)::text AS deducted_quantity,
                COALESCE((SELECT sum(cost_basis_micros) FROM broker_inventory_debits WHERE account_id = ${accountId} AND symbol = ${coin.symbol}), 0)::text AS deducted_cost
            `
              const [balance] = yield* fromResult(
                Schema.decodeUnknownResult(
                  Schema.Tuple([
                    Schema.Struct({
                      quantity: Schema.String,
                      cost: Schema.String,
                      deducted_quantity: Schema.String,
                      deducted_cost: Schema.String,
                    }),
                  ]),
                  strictParseOptions,
                )(balances),
              )
              const adjustment = coinAdjustments.get(coin.symbol) ?? { quantity: 0n, cost: 0n }
              const quantity = BigInt(balance.quantity) - BigInt(balance.deducted_quantity) - adjustment.quantity
              const cost = BigInt(balance.cost) - BigInt(balance.deducted_cost) - adjustment.cost
              if (quantity < debit || cost < 0n) return yield* invariant('coin fee exceeds accounted inventory')
              const removed = debit === quantity ? cost : (cost * debit + quantity / 2n) / quantity
              coinCostBasisMicros = removed.toString()
              coinAdjustments.set(coin.symbol, {
                quantity: adjustment.quantity + debit,
                cost: adjustment.cost + removed,
              })
            }
          }
          if (fee.cryptoCashFee === true && existing === undefined && ledgerCashDelta < 0n) {
            let remaining = -ledgerCashDelta
            for (const accrual of accruals) {
              if (accrual.data.kind !== 'CASH' || accrual.settlement_date !== sourceDate) continue
              const available =
                BigInt(accrual.cash_debit_micros ?? '0') -
                BigInt(accrual.matched_cash_micros) -
                (assignedCashAmounts.get(accrual.accrualId) ?? 0n)
              const covered = remaining < available ? remaining : available
              if (covered <= 0n) continue
              matches.push({
                accrualId: accrual.accrualId,
                coinQuantityAtoms: null,
                activityCashMicros: covered.toString(),
                accrualCashMicros: covered.toString(),
              })
              assignedCashAmounts.set(accrual.accrualId, (assignedCashAmounts.get(accrual.accrualId) ?? 0n) + covered)
              remaining -= covered
              ledgerCashDelta += covered
            }
          }
          const plan =
            fee.coinDebit === undefined
              ? brokerFeeLedgerPlan(accountId, fee.activityId, ledgerCashDelta.toString(), identity.ledger)
              : coinFeeLedgerPlan(
                  accountId,
                  fee.activityId,
                  fee.coinDebit.symbol,
                  coinCostBasisMicros ?? '0',
                  identity.ledger,
                )
          const planHash = yield* fromResult(hashLedgerPlanResult(plan))
          if (existing !== undefined) {
            yield* fromResult(verifyBrokerFeeRecord(existing, accountId, identity))
            if (existing.content_hash !== contentHash)
              return yield* invariant('durable broker fee changed its economic content')
          }
          return { fee, coinCostBasisMicros, readEvidence, plan, planHash, contentHash, existing, matches }
        }),
    )
    if (stored.some((row) => !seen.has(row.data.activityId)))
      return yield* invariant('broker fee history omitted previously accounted activity')
    for (const { fee, coinCostBasisMicros, readEvidence, planHash, contentHash, existing, matches } of prepared) {
      if (existing === undefined) {
        yield* sql`
        INSERT INTO broker_fee_accounting(account_id,activity_id,fee_date,net_amount_micros,coin_cost_basis_micros,data,read_evidence,content_hash,
          ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger,first_observed_at)
        VALUES(${accountId},${fee.activityId},${fee.date},${fee.netAmountMicros},${coinCostBasisMicros},${sql.json(fee)},${sql.json(readEvidence)},${contentHash},
          ${planHash},${identity.clusterId.toString()},${identity.ledger},${readEvidence.observedAt})
      `
        for (const match of matches)
          yield* sql`INSERT INTO broker_fee_accrual_matches(accrual_id,account_id,activity_id,coin_quantity_atoms,activity_cash_micros,accrual_cash_micros)
          VALUES(${match.accrualId},${accountId},${fee.activityId},${match.coinQuantityAtoms},${match.activityCashMicros},${match.accrualCashMicros})`
      }
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ReconciliationStoreError
        ? cause
        : new ReconciliationStoreError({
            operation: 'reconcile',
            failure: 'query',
            message: 'broker fee persistence failed',
            cause,
          }),
    ),
  )

/** Prepared rows and receipt matches must commit before this phase posts ledger transfers. */
export const postBrokerFeePlans = (
  sql: PgClient.PgClient,
  journal: JournalService,
  accountId: string,
  identity: { readonly clusterId: bigint; readonly ledger: number },
): Effect.Effect<BrokerFeeAccounting, ReconciliationStoreError> =>
  Effect.gen(function* () {
    yield* postFeeAccruals(sql, journal, accountId, identity)
    const rows = yield* fromResult(
      Schema.decodeUnknownResult(
        Schema.Array(StoredFeeSchema),
        strictParseOptions,
      )(
        yield* sql`
    SELECT f.data,f.cash_match_corrections,f.coin_cost_basis_micros::text AS coin_cost_basis_micros,f.read_evidence,f.content_hash,f.ledger_plan_hash,
      f.tigerbeetle_cluster_id::text,f.tigerbeetle_ledger::integer,f.posted_at IS NOT NULL AS posted,
      COALESCE((SELECT sum(m.accrual_cash_micros) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id),0)::text AS matched_cash_micros
    FROM broker_fee_accounting_evidence f WHERE f.account_id=${accountId} ORDER BY f.activity_id COLLATE "C"
  `,
      ),
    )
    const acknowledged = yield* readAcknowledgedFeePostings(sql, accountId, FeePostingKind.Activity)
    const fees: FeeActivity[] = []
    const plans: LedgerPlan[] = []
    let cashDelta = 0n
    for (const row of rows) {
      const verified = yield* fromResult(verifyBrokerFeeRecord(row, accountId, identity))
      const plan = verified.originalPlan
      if (!row.posted || !acknowledged.has(row.data.activityId)) {
        if (plan.transfers.length > 0)
          yield* journal.post(plan).pipe(
            Effect.mapError(
              (cause) =>
                new ReconciliationStoreError({
                  operation: 'reconcile',
                  failure: 'ledger',
                  message: 'Broker fee ledger posting failed',
                  cause,
                }),
            ),
          )
        if (!row.posted)
          yield* sql`UPDATE broker_fee_accounting SET posted_at=clock_timestamp() WHERE account_id=${accountId} AND activity_id=${row.data.activityId}`
        yield* acknowledgeFeePosting(sql, accountId, FeePostingKind.Activity, row.data.activityId, row.ledger_plan_hash)
      }
      for (const correction of verified.corrections) {
        if (!correction.record.posted) {
          yield* journal.post(correction.plan).pipe(
            Effect.mapError(
              (cause) =>
                new ReconciliationStoreError({
                  operation: 'reconcile',
                  failure: 'ledger',
                  message: 'Fee match correction ledger posting failed',
                  cause,
                }),
            ),
          )
          yield* sql`UPDATE broker_fee_match_corrections SET posted_at=clock_timestamp() WHERE correction_id=${correction.record.correction_id}`
        }
        plans.push(correction.plan)
      }
      fees.push(row.data)
      plans.push(plan)
      cashDelta += BigInt(verified.cashDeltaMicros)
    }
    return { fees, plans, cashDeltaMicros: cashDelta.toString() }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ReconciliationStoreError
        ? cause
        : new ReconciliationStoreError({
            operation: 'reconcile',
            failure: 'query',
            message: 'Prepared broker fee posting failed',
            cause,
          }),
    ),
  )
