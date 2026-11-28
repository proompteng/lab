import { Data, Result, Schema } from 'effect'

import { CashReportingQuantumSchema, reportedCashMicros } from '../broker/alpaca/cash-reporting'
import { SignedMicrosSchema } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { hashLedgerPlanResult } from '../ledger-plan'
import { Sha256Schema, StrictNonEmptyStringSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { cashSettlementLedgerPlan } from './domain'

export const CashSettlementDataSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.broker-cash-settlement.v1'),
  accountId: StrictNonEmptyStringSchema,
  transactionId: Sha256Schema,
  transactionContentHash: Sha256Schema,
  brokerEventId: Sha256Schema,
  cashDeltaMicros: SignedMicrosSchema,
  cashReportingQuantumMicros: CashReportingQuantumSchema,
  precisionAccountEventId: Sha256Schema,
  observedAt: UtcInstantSchema,
  occurredAt: UtcInstantSchema,
})
export type CashSettlementData = typeof CashSettlementDataSchema.Type

export const StoredCashSettlementSchema = Schema.Struct({
  settlement_id: Sha256Schema,
  data: CashSettlementDataSchema,
  rounding_delta_micros: SignedMicrosSchema,
  content_hash: Sha256Schema,
  ledger_plan_hash: Sha256Schema,
  tigerbeetle_cluster_id: Schema.String,
  tigerbeetle_ledger: Schema.Int,
  posted: Schema.Boolean,
})
export type StoredCashSettlement = typeof StoredCashSettlementSchema.Type

export class CashSettlementEvidenceError extends Data.TaggedError('CashSettlementEvidenceError')<{
  readonly message: string
}> {}

const invalid = (message: string) => Result.fail(new CashSettlementEvidenceError({ message }))

export const prepareCashSettlement = (input: unknown, ledger: number) =>
  Result.gen(function* () {
    const data = yield* Schema.decodeUnknownResult(
      CashSettlementDataSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError(() => new CashSettlementEvidenceError({ message: 'invalid cash settlement source evidence' })),
    )
    if (data.observedAt < data.occurredAt) return yield* invalid('cash precision observation predates the source fill')
    const settledCashDeltaMicros = reportedCashMicros(data.cashDeltaMicros, data.cashReportingQuantumMicros)
    const roundingDeltaMicros = (BigInt(settledCashDeltaMicros) - BigInt(data.cashDeltaMicros)).toString()
    const settlementId = yield* canonicalHashV1Result({
      schemaVersion: 'bayn.broker-cash-settlement-id.v1',
      accountId: data.accountId,
      transactionId: data.transactionId,
      transactionContentHash: data.transactionContentHash,
      cashReportingQuantumMicros: data.cashReportingQuantumMicros,
    }).pipe(
      Result.mapError(() => new CashSettlementEvidenceError({ message: 'cash settlement identity cannot be hashed' })),
    )
    const contentHash = yield* canonicalHashV1Result(data).pipe(
      Result.mapError(() => new CashSettlementEvidenceError({ message: 'cash settlement evidence cannot be hashed' })),
    )
    const plan = cashSettlementLedgerPlan(data.accountId, settlementId, roundingDeltaMicros, ledger)
    return { data, settlementId, contentHash, roundingDeltaMicros, settledCashDeltaMicros, plan }
  })

export const verifyCashSettlement = (
  record: typeof StoredCashSettlementSchema.Type,
  accountId: string,
  identity: { readonly clusterId: bigint; readonly ledger: number },
) =>
  Result.gen(function* () {
    const prepared = yield* prepareCashSettlement(record.data, identity.ledger)
    const planHash = yield* hashLedgerPlanResult(prepared.plan).pipe(
      Result.mapError(() => new CashSettlementEvidenceError({ message: 'cash settlement plan cannot be hashed' })),
    )
    if (
      record.data.accountId !== accountId ||
      record.settlement_id !== prepared.settlementId ||
      record.content_hash !== prepared.contentHash ||
      record.rounding_delta_micros !== prepared.roundingDeltaMicros ||
      record.ledger_plan_hash !== planHash ||
      record.tigerbeetle_cluster_id !== identity.clusterId.toString() ||
      record.tigerbeetle_ledger !== identity.ledger
    )
      return yield* invalid('stored cash settlement differs from its immutable source or ledger')
    return { ...prepared, posted: record.posted }
  })
