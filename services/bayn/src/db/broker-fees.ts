import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { brokerFeeLedgerPlan } from '../accounting/domain'
import type { FeeActivity } from '../broker/alpaca'
import { canonicalHashV1Result } from '../hash'
import { hashLedgerPlanResult } from '../ledger-plan'
import type { JournalService } from '../ledger'
import type { LedgerPlan } from '../ledger-plan'
import { strictParseOptions } from '../schemas'
import {
  brokerFeePredatesOpeningCash,
  BrokerFeeSchema,
  FeeReadEvidenceSchema,
  StoredFeeSchema,
  verifyBrokerFeeRecord,
} from '../accounting/broker-fees'
import type { Observed } from '../simulation-reconciliation/broker-reconciler-model'
import { ReconciliationStoreError } from './reconciliation'

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
}

/** Called inside the account writer fence and reconciliation transaction. */
export const accountBrokerFees = (
  sql: PgClient.PgClient,
  journal: JournalService,
  accountId: string,
  observed: readonly Observed<FeeActivity>[],
  identity: { readonly clusterId: bigint; readonly ledger: number },
): Effect.Effect<BrokerFeeAccounting, ReconciliationStoreError> =>
  Effect.gen(function* () {
    const openingRows =
      observed.length === 0
        ? []
        : yield* sql<Record<string, unknown>>`
      SELECT to_char(event.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
      FROM account_snapshots AS snapshot JOIN broker_events AS event ON event.event_id = snapshot.event_id
      WHERE snapshot.account_id = ${accountId} ORDER BY event.source_sequence LIMIT 1
    `
    const openings = yield* fromResult(
      Schema.decodeUnknownResult(
        Schema.Array(Schema.Struct({ observed_at: FeeReadEvidenceSchema.fields.observedAt })),
        strictParseOptions,
      )(openingRows),
    )
    const opening = openings[0]
    if (observed.length > 0 && opening === undefined)
      return yield* invariant('broker fee accounting requires an opening cash baseline')
    if (opening !== undefined && observed.some(({ value }) => brokerFeePredatesOpeningCash(value, opening.observed_at)))
      return yield* invariant(
        'broker fee history predates the opening cash baseline; earlier baseline evidence is required',
      )
    const rows = yield* sql<Record<string, unknown>>`
    SELECT data, read_evidence, content_hash, ledger_plan_hash, tigerbeetle_cluster_id::text AS tigerbeetle_cluster_id,
      tigerbeetle_ledger::integer AS tigerbeetle_ledger, posted_at IS NOT NULL AS posted
    FROM broker_fee_accounting WHERE account_id = ${accountId} ORDER BY activity_id COLLATE "C"
  `
    const stored = yield* fromResult(
      Schema.decodeUnknownResult(Schema.Array(StoredFeeSchema), strictParseOptions)(rows),
    )
    const byId = new Map(stored.map((row) => [row.data.activityId, row]))
    const seen = new Set<string>()
    const fees: FeeActivity[] = []
    const plans: LedgerPlan[] = []
    const prepared = yield* Effect.forEach(
      [...observed].sort((a, b) => a.value.activityId.localeCompare(b.value.activityId)),
      (observation) =>
        Effect.gen(function* () {
          const readEvidence = yield* fromResult(
            Schema.decodeUnknownResult(FeeReadEvidenceSchema)({
              requestId: observation.evidence.requestId,
              status: observation.evidence.status,
              contentHash: observation.evidence.contentHash,
              observedAt: observation.evidence.observedAt,
            }),
          )
          const fee = yield* fromResult(
            Schema.decodeUnknownResult(BrokerFeeSchema, strictParseOptions)(observation.value),
          )
          if (
            fee.accountId !== accountId ||
            seen.has(fee.activityId) ||
            fee.date > observation.evidence.observedAt.slice(0, 10)
          )
            return yield* invariant('broker fee account, uniqueness, or date binding is invalid')
          seen.add(fee.activityId)
          const contentHash = yield* fromResult(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...fee }))
          const plan = brokerFeeLedgerPlan(accountId, fee.activityId, fee.netAmountMicros, identity.ledger)
          const planHash = yield* fromResult(hashLedgerPlanResult(plan))
          const existing = byId.get(fee.activityId)
          if (existing !== undefined) {
            yield* fromResult(verifyBrokerFeeRecord(existing, accountId, identity))
            if (existing.content_hash !== contentHash)
              return yield* invariant('durable broker fee changed its economic content')
          }
          return { fee, readEvidence, plan, planHash, contentHash, existing }
        }),
    )
    if (stored.some((row) => !seen.has(row.data.activityId)))
      return yield* invariant('broker fee history omitted previously accounted activity')
    for (const { fee, readEvidence, plan, planHash, contentHash, existing } of prepared) {
      if (existing === undefined) {
        yield* sql`
        INSERT INTO broker_fee_accounting(account_id,activity_id,fee_date,net_amount_micros,data,read_evidence,content_hash,
          ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger,first_observed_at)
        VALUES(${accountId},${fee.activityId},${fee.date},${fee.netAmountMicros},${sql.json(fee)},${sql.json(readEvidence)},${contentHash},
          ${planHash},${identity.clusterId.toString()},${identity.ledger},${readEvidence.observedAt})
      `
      }
      if (existing?.posted !== true) {
        if (plan.transfers.length > 0)
          yield* journal.post(plan).pipe(
            Effect.mapError(
              (cause) =>
                new ReconciliationStoreError({
                  operation: 'reconcile',
                  failure: 'ledger',
                  message: 'broker fee ledger posting failed',
                  cause,
                }),
            ),
          )
        yield* sql`UPDATE broker_fee_accounting SET posted_at = ${readEvidence.observedAt} WHERE account_id = ${accountId} AND activity_id = ${fee.activityId}`
      }
      fees.push(fee)
      plans.push(plan)
    }
    return { fees, plans }
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
