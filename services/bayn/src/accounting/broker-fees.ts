import { FeeActivitySchema } from '../broker/fee-activity'
import { Data, Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { hashLedgerPlanResult, type LedgerPlan } from '../ledger-plan'
import { PositiveMicrosSchema, UnsignedMicrosSchema } from '../execution/contracts'
import { Sha256Schema, StrictNonEmptyStringSchema, UtcInstantSchema, UtcOrderTimestampSchema } from '../schemas'
import { brokerFeeLedgerPlan, coinFeeLedgerPlan } from './domain'

export const FeeReadEvidenceSchema = Schema.Struct({
  requestId: StrictNonEmptyStringSchema,
  status: Schema.Literal(200),
  contentHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  sourceCreatedAt: Schema.optionalKey(UtcOrderTimestampSchema),
}).check(
  Schema.makeFilter(
    (evidence) =>
      evidence.sourceCreatedAt === undefined ||
      evidence.sourceCreatedAt <= `${evidence.observedAt.slice(0, -1)}000000Z`,
  ),
)
export const FeeMatchCorrectionDataSchema = Schema.Struct({
  schemaVersion: Schema.Literals(['bayn.fee-match-correction.v1', 'bayn.fee-match-correction.v2']),
  accountId: StrictNonEmptyStringSchema,
  activityId: StrictNonEmptyStringSchema,
  accrualId: Sha256Schema,
  feeContentHash: Sha256Schema,
  activityCashMicros: PositiveMicrosSchema,
  accrualCashMicros: PositiveMicrosSchema,
  readEvidence: FeeReadEvidenceSchema,
})
export const StoredFeeMatchCorrectionSchema = Schema.Struct({
  correction_id: Sha256Schema,
  data: FeeMatchCorrectionDataSchema,
  content_hash: Sha256Schema,
  ledger_plan_hash: Sha256Schema,
  tigerbeetle_cluster_id: Schema.String,
  tigerbeetle_ledger: Schema.Int,
  posted: Schema.Boolean,
})
export type StoredFeeMatchCorrection = typeof StoredFeeMatchCorrectionSchema.Type

export const feeMatchCorrectionCashDebitMicros = (data: typeof FeeMatchCorrectionDataSchema.Type): string =>
  (
    BigInt(data.accrualCashMicros) -
    (data.schemaVersion === 'bayn.fee-match-correction.v2' ? BigInt(data.activityCashMicros) : 0n)
  ).toString()

export const prepareFeeMatchCorrection = (input: unknown, ledger: number) =>
  Result.gen(function* () {
    const data = yield* Schema.decodeUnknownResult(FeeMatchCorrectionDataSchema)(input).pipe(
      Result.mapError(() => new BrokerFeeEvidenceError({ message: 'invalid fee match correction evidence' })),
    )
    const cashDebitMicros = feeMatchCorrectionCashDebitMicros(data)
    if (BigInt(data.activityCashMicros) > BigInt(data.accrualCashMicros) || BigInt(cashDebitMicros) <= 0n)
      return yield* Result.fail(
        new BrokerFeeEvidenceError({ message: 'fee correction exceeds its original accrual release' }),
      )
    const { readEvidence: _read, schemaVersion: _version, ...identity } = data
    const correctionId = yield* canonicalHashV1Result({
      schemaVersion:
        data.schemaVersion === 'bayn.fee-match-correction.v1'
          ? 'bayn.fee-match-correction-id.v1'
          : 'bayn.fee-match-correction-id.v2',
      ...identity,
    }).pipe(Result.mapError(() => new BrokerFeeEvidenceError({ message: 'fee correction identity cannot be hashed' })))
    const contentHash = yield* canonicalHashV1Result(data).pipe(
      Result.mapError(() => new BrokerFeeEvidenceError({ message: 'fee correction evidence cannot be hashed' })),
    )
    const plan = brokerFeeLedgerPlan(
      data.accountId,
      `fee-match-correction:${correctionId}`,
      `-${cashDebitMicros}`,
      ledger,
    )
    return { data, correctionId, contentHash, cashDebitMicros, plan }
  })

export const StoredFeeSchema = Schema.Struct({
  data: FeeActivitySchema,
  cash_match_corrections: Schema.Array(StoredFeeMatchCorrectionSchema),
  matched_cash_micros: UnsignedMicrosSchema,
  coin_cost_basis_micros: Schema.NullOr(UnsignedMicrosSchema),
  read_evidence: FeeReadEvidenceSchema,
  content_hash: Sha256Schema,
  ledger_plan_hash: Sha256Schema,
  tigerbeetle_cluster_id: Schema.String,
  tigerbeetle_ledger: Schema.Int,
  posted: Schema.Boolean,
})

export type StoredBrokerFee = typeof StoredFeeSchema.Type
export class BrokerFeeEvidenceError extends Data.TaggedError('BrokerFeeEvidenceError')<{ readonly message: string }> {}
export const brokerFeeCashDeltaMicros = (record: StoredBrokerFee): string =>
  (
    BigInt(record.data.netAmountMicros) +
    BigInt(record.matched_cash_micros) -
    record.cash_match_corrections.reduce(
      (sum, correction) => sum + BigInt(feeMatchCorrectionCashDebitMicros(correction.data)),
      0n,
    )
  ).toString()

export const verifyBrokerFeeRecord = (
  record: StoredBrokerFee,
  accountId: string,
  identity: { readonly clusterId: bigint; readonly ledger: number },
): Result.Result<
  {
    readonly originalPlan: LedgerPlan
    readonly corrections: readonly { readonly record: StoredFeeMatchCorrection; readonly plan: LedgerPlan }[]
    readonly cashDeltaMicros: string
  },
  BrokerFeeEvidenceError
> =>
  Result.gen(function* () {
    const coin = record.data.coinDebit
    if (
      (coin === undefined) !== (record.coin_cost_basis_micros === null) ||
      (coin !== undefined && (record.data.netAmountMicros !== '0' || record.matched_cash_micros !== '0'))
    )
      return yield* Result.fail(
        new BrokerFeeEvidenceError({ message: 'broker fee asset and inventory cost do not agree' }),
      )
    const plan =
      coin === undefined
        ? brokerFeeLedgerPlan(
            record.data.accountId,
            record.data.activityId,
            (BigInt(record.data.netAmountMicros) + BigInt(record.matched_cash_micros)).toString(),
            identity.ledger,
          )
        : coinFeeLedgerPlan(
            record.data.accountId,
            record.data.activityId,
            coin.symbol,
            record.coin_cost_basis_micros ?? '0',
            identity.ledger,
          )
    const contentHash = yield* canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...record.data }).pipe(
      Result.mapError(() => new BrokerFeeEvidenceError({ message: 'broker fee content cannot be hashed' })),
    )
    const planHash = yield* hashLedgerPlanResult(plan).pipe(
      Result.mapError(() => new BrokerFeeEvidenceError({ message: 'broker fee ledger cannot be hashed' })),
    )
    if (
      record.data.accountId !== accountId ||
      contentHash !== record.content_hash ||
      planHash !== record.ledger_plan_hash ||
      record.tigerbeetle_cluster_id !== identity.clusterId.toString() ||
      record.tigerbeetle_ledger !== identity.ledger ||
      record.data.date > record.read_evidence.observedAt.slice(0, 10) ||
      (record.read_evidence.sourceCreatedAt !== undefined &&
        ((record.data.coinDebit === undefined && record.data.cryptoCashFee !== true) ||
          record.read_evidence.sourceCreatedAt > `${record.read_evidence.observedAt.slice(0, -1)}000000Z`))
    )
      return yield* Result.fail(
        new BrokerFeeEvidenceError({
          message: 'broker fee identity conflicts with its account, content, date or ledger evidence',
        }),
      )
    const corrections: { record: StoredFeeMatchCorrection; plan: LedgerPlan }[] = []
    const ids = new Set<string>()
    let correctedCash = 0n
    for (const correction of record.cash_match_corrections) {
      const prepared = yield* prepareFeeMatchCorrection(correction.data, identity.ledger)
      const correctionPlanHash = yield* hashLedgerPlanResult(prepared.plan).pipe(
        Result.mapError(() => new BrokerFeeEvidenceError({ message: 'fee correction ledger cannot be hashed' })),
      )
      if (
        coin !== undefined ||
        (record.data.cryptoCashFee === true) !== (correction.data.schemaVersion === 'bayn.fee-match-correction.v2') ||
        correction.data.accountId !== accountId ||
        correction.data.activityId !== record.data.activityId ||
        correction.data.feeContentHash !== record.content_hash ||
        correction.data.readEvidence.observedAt < record.read_evidence.observedAt ||
        correction.correction_id !== prepared.correctionId ||
        correction.content_hash !== prepared.contentHash ||
        correction.ledger_plan_hash !== correctionPlanHash ||
        correction.tigerbeetle_cluster_id !== identity.clusterId.toString() ||
        correction.tigerbeetle_ledger !== identity.ledger ||
        ids.has(correction.data.accrualId)
      )
        return yield* Result.fail(
          new BrokerFeeEvidenceError({ message: 'fee correction conflicts with its immutable source or ledger' }),
        )
      ids.add(correction.data.accrualId)
      correctedCash += BigInt(prepared.cashDebitMicros)
      corrections.push({ record: correction, plan: prepared.plan })
    }
    if (correctedCash > BigInt(record.matched_cash_micros))
      return yield* Result.fail(
        new BrokerFeeEvidenceError({ message: 'fee correction exceeds the original matched cash' }),
      )
    return {
      originalPlan: plan,
      corrections,
      cashDeltaMicros: brokerFeeCashDeltaMicros(record),
    }
  })

const feeDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export const brokerFeePredatesOpeningCash = (
  fee: {
    readonly date: string
    readonly cryptoCashFee?: true
    readonly coinDebit?: unknown
    readonly sourceCreatedAt?: string
  },
  openingObservedAt: string,
): boolean => {
  const crypto = fee.cryptoCashFee === true || fee.coinDebit !== undefined
  if (crypto && fee.sourceCreatedAt !== undefined)
    return fee.sourceCreatedAt < `${openingObservedAt.slice(0, -1)}000000Z`
  return fee.date < (crypto ? openingObservedAt.slice(0, 10) : feeDateFormatter.format(new Date(openingObservedAt)))
}
