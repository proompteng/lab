import { Data, Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { hashLedgerPlanResult, type LedgerPlan } from '../ledger-plan'
import { IsoDateSchema, Sha256Schema, StrictNonEmptyStringSchema, UtcInstantSchema } from '../schemas'
import { brokerFeeLedgerPlan } from './domain'

export const BrokerFeeSchema = Schema.Struct({
  accountId: StrictNonEmptyStringSchema,
  activityId: StrictNonEmptyStringSchema,
  date: IsoDateSchema,
  netAmountMicros: Schema.String.check(Schema.isPattern(/^(?:0|-?[1-9][0-9]*)$/)),
})
export const FeeReadEvidenceSchema = Schema.Struct({
  requestId: StrictNonEmptyStringSchema,
  status: Schema.Literal(200),
  contentHash: Sha256Schema,
  observedAt: UtcInstantSchema,
})
export const StoredFeeSchema = Schema.Struct({
  data: BrokerFeeSchema,
  read_evidence: FeeReadEvidenceSchema,
  content_hash: Sha256Schema,
  ledger_plan_hash: Sha256Schema,
  tigerbeetle_cluster_id: Schema.String,
  tigerbeetle_ledger: Schema.Int,
  posted: Schema.Boolean,
})

export type StoredBrokerFee = typeof StoredFeeSchema.Type
export class BrokerFeeEvidenceError extends Data.TaggedError('BrokerFeeEvidenceError')<{ readonly message: string }> {}
export const verifyBrokerFeeRecord = (
  record: StoredBrokerFee,
  accountId: string,
  identity: { readonly clusterId: bigint; readonly ledger: number },
): Result.Result<LedgerPlan, BrokerFeeEvidenceError> =>
  Result.gen(function* () {
    const plan = brokerFeeLedgerPlan(
      record.data.accountId,
      record.data.activityId,
      record.data.netAmountMicros,
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
      record.data.date > record.read_evidence.observedAt.slice(0, 10)
    )
      return yield* Result.fail(
        new BrokerFeeEvidenceError({
          message: 'broker fee identity conflicts with its account, content, date or ledger evidence',
        }),
      )
    return plan
  })
