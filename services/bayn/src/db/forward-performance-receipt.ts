import { IntradayPerformanceVolumeEvidenceSchema } from '../forward-performance/intraday-schema'
import { validIntradayPerformanceVolumeEvidence } from '../forward-performance/intraday-volume'
import { Data, Effect, Result, Schema } from 'effect'
import { PgClient } from '@effect/sql-pg'

import { canonicalHashV1Result } from '../hash'
import {
  ImageDigestSchema,
  ImageRepositorySchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  SignedMicrosSchema,
  SourceRevisionSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import type { ForwardPerformanceReceipt } from '../forward-performance/model'

const DecimalSchema = Schema.String.check(Schema.isPattern(/^-?(?:0|[1-9][0-9]*)\.[0-9]+$/))
const ReceiptStringSchema = Schema.String.check(Schema.isMinLength(1))
const ForwardPerformanceBuildBindingSchema = Schema.Struct({
  sourceRevision: SourceRevisionSchema,
  imageRepository: ImageRepositorySchema,
  imageDigest: ImageDigestSchema,
})

const ForwardPerformanceStrategyBindingSchema = Schema.Struct({
  qualificationRunId: Sha256Schema,
  strategyName: ReceiptStringSchema,
  strategyProtocolHash: Sha256Schema,
  strategyBehaviorHash: Sha256Schema,
  strategyParameterHash: Sha256Schema,
  strategyParameterSchemaVersion: ReceiptStringSchema,
  executionPolicyHash: Sha256Schema,
  strategyExecutionModelHash: Sha256Schema,
})

const ForwardPerformanceAccountBindingSchema = Schema.Struct({
  accountReferenceHash: Sha256Schema,
  provider: ReceiptStringSchema,
  environment: ReceiptStringSchema,
})

const ForwardPerformanceCashYieldBindingSchema = Schema.Struct({
  source: Schema.Literal('TIGERBEETLE_CASH_YIELD_TRANSFER'),
  transferId: ReceiptStringSchema,
  transferTimestampNs: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  amountMicros: SignedMicrosSchema,
})

const ForwardPerformanceExecutionQualitySchema = Schema.Struct({
  unverifiedDecisionHashes: Schema.optionalKey(
    Schema.Array(Sha256Schema).check(Schema.isMinLength(1), Schema.isUnique()),
  ),
  status: Schema.Union([Schema.Literal('MEASURED'), Schema.Literal('NOT_ELIGIBLE'), Schema.Literal('UNDETERMINED')]),
  reasonCodes: Schema.Array(ReceiptStringSchema),
  evidenceHash: Schema.NullOr(Sha256Schema),
  implementationShortfall: Schema.NullOr(
    Schema.Struct({
      plannedOrderCount: NonNegativeIntegerSchema,
      fillCount: NonNegativeIntegerSchema,
      plannedQuantityMicros: SignedMicrosSchema,
      filledQuantityMicros: SignedMicrosSchema,
      unfilledQuantityMicros: SignedMicrosSchema,
      plannedReferenceNotionalMicros: SignedMicrosSchema,
      executedNotionalMicros: SignedMicrosSchema,
      executionPriceShortfallMicros: SignedMicrosSchema,
      opportunityShortfallMicros: SignedMicrosSchema,
      explicitCostsMicros: SignedMicrosSchema,
      totalImplementationShortfallMicros: SignedMicrosSchema,
      implementationShortfallRate: Schema.Struct({
        numeratorMicros: SignedMicrosSchema,
        denominatorMicros: SignedMicrosSchema,
        decimal: DecimalSchema,
      }),
      firstDecisionAt: UtcInstantSchema,
      firstFillAt: Schema.NullOr(UtcInstantSchema),
      lastFillAt: Schema.NullOr(UtcInstantSchema),
      lastTerminalOrderObservedAt: UtcInstantSchema,
    }),
  ),
}).check(
  Schema.makeFilter((quality) => {
    if (quality.unverifiedDecisionHashes === undefined) return true
    const expectedHash = canonicalHashV1Result({ unverifiedDecisionHashes: quality.unverifiedDecisionHashes })
    return (
      quality.status === 'UNDETERMINED' &&
      quality.implementationShortfall === null &&
      quality.reasonCodes.includes('PLANNED_DECISION_EVIDENCE_GAP') &&
      Result.isSuccess(expectedHash) &&
      expectedHash.success === quality.evidenceHash
    )
  }),
)

const ForwardPerformanceObservedCapacitySchema = Schema.Struct({
  intradaySources: Schema.optionalKey(
    Schema.Array(
      IntradayPerformanceVolumeEvidenceSchema.check(Schema.makeFilter(validIntradayPerformanceVolumeEvidence)),
    ),
  ),
  status: Schema.Union([Schema.Literal('MEASURED'), Schema.Literal('NOT_ELIGIBLE'), Schema.Literal('UNDETERMINED')]),
  reasonCodes: Schema.Array(ReceiptStringSchema),
  evidenceHash: Schema.NullOr(Sha256Schema),
  observations: Schema.Array(
    Schema.Struct({
      cycleId: Sha256Schema,
      symbol: ReceiptStringSchema,
      windowOpenedAt: UtcInstantSchema,
      windowClosedAt: UtcInstantSchema,
      filledQuantityMicros: SignedMicrosSchema,
      marketVolumeQuantityMicros: SignedMicrosSchema,
      intradaySource: Schema.optionalKey(
        Schema.Struct({
          feed: Schema.Literal('iex'),
          volumeScope: Schema.Literal('IEX_RECORDED_SESSION_VOLUME'),
          evidenceHash: Sha256Schema,
        }),
      ),
      participationRate: Schema.Struct({
        numeratorQuantityMicros: SignedMicrosSchema,
        denominatorQuantityMicros: SignedMicrosSchema,
        decimal: DecimalSchema,
      }),
    }),
  ),
  boundedObservedReferenceNotionalMicros: Schema.NullOr(SignedMicrosSchema),
  boundedObservedExecutedNotionalMicros: Schema.NullOr(SignedMicrosSchema),
  maximumParticipationRate: Schema.NullOr(
    Schema.Struct({
      numeratorQuantityMicros: SignedMicrosSchema,
      denominatorQuantityMicros: SignedMicrosSchema,
      decimal: DecimalSchema,
    }),
  ),
}).check(
  Schema.makeFilter((capacity) =>
    capacity.observations.every((observation) => {
      if (observation.intradaySource === undefined) return true
      const sources = (capacity.intradaySources ?? []).filter(
        (source) => source.contentHash === observation.intradaySource?.evidenceHash,
      )
      const source = sources[0]
      return (
        sources.length === 1 &&
        source !== undefined &&
        source.cycleId === observation.cycleId &&
        source.symbol === observation.symbol &&
        source.windowOpenedAt === observation.windowOpenedAt &&
        source.windowClosedAt === observation.windowClosedAt &&
        source.quantityMicros === observation.marketVolumeQuantityMicros
      )
    }),
  ),
)

const ForwardPerformanceReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.forward-performance-receipt.v3'),
  bindings: Schema.Struct({
    runtime: ForwardPerformanceBuildBindingSchema,
    source: Schema.NullOr(ForwardPerformanceBuildBindingSchema),
    strategy: Schema.NullOr(ForwardPerformanceStrategyBindingSchema),
    account: ForwardPerformanceAccountBindingSchema,
  }),
  window: Schema.Struct({
    firstCycleId: Schema.NullOr(Sha256Schema),
    lastCycleId: Schema.NullOr(Sha256Schema),
    openedAt: Schema.NullOr(UtcInstantSchema),
    closedAt: Schema.NullOr(UtcInstantSchema),
    reconciliationId: Schema.NullOr(Sha256Schema),
    reconciliationContentHash: Schema.NullOr(Sha256Schema),
    reconciliationStatus: Schema.NullOr(Schema.Union([Schema.Literal('EXACT'), Schema.Literal('DISCREPANCY')])),
    cashYieldAdjustedExact: Schema.NullOr(Schema.Boolean),
  }),
  totals: Schema.Struct({
    startingCapitalMicros: Schema.NullOr(SignedMicrosSchema),
    realizedGainsMicros: Schema.NullOr(SignedMicrosSchema),
    realizedLossesMicros: Schema.NullOr(SignedMicrosSchema),
    brokerExecutionFeesMicros: Schema.NullOr(SignedMicrosSchema),
    otherChargedCostsMicros: Schema.NullOr(SignedMicrosSchema),
    cashYieldMicros: Schema.NullOr(SignedMicrosSchema),
    grossRealizedPnlMicros: Schema.NullOr(SignedMicrosSchema),
    netRealizedPnlAfterCostsMicros: Schema.NullOr(SignedMicrosSchema),
    netRealizedReturn: Schema.NullOr(
      Schema.Struct({
        numeratorMicros: SignedMicrosSchema,
        denominatorMicros: SignedMicrosSchema,
        decimal: DecimalSchema,
      }),
    ),
  }),
  counts: Schema.Struct({
    cycleCount: NonNegativeIntegerSchema,
    completedExecutionCount: NonNegativeIntegerSchema,
    realizedCloseCount: NonNegativeIntegerSchema,
  }),
  evidence: Schema.Struct({
    status: Schema.Union([Schema.Literal('SUFFICIENT'), Schema.Literal('INSUFFICIENT_EVIDENCE')]),
    reasonCodes: Schema.Array(ReceiptStringSchema),
    cashYield: Schema.NullOr(ForwardPerformanceCashYieldBindingSchema),
  }),
  reconciliationProof: Schema.Struct({
    accountingReceiptsExact: Schema.Boolean,
    ledgerExact: Schema.Boolean,
    missingLedgerAccountCount: NonNegativeIntegerSchema,
    unresolvedMutationCount: NonNegativeIntegerSchema,
    unclosedCycleCount: NonNegativeIntegerSchema,
    openPositionCount: NonNegativeIntegerSchema,
  }),
  executionQuality: ForwardPerformanceExecutionQualitySchema,
  observedCapacity: ForwardPerformanceObservedCapacitySchema,
  profitability: Schema.Union([
    Schema.Literal('PROFITABLE'),
    Schema.Literal('NOT_PROFITABLE'),
    Schema.Literal('UNDETERMINED'),
  ]),
  receiptHash: Sha256Schema,
}).check(
  Schema.makeFilter((receipt) => {
    const { receiptHash: _receiptHash, ...material } = receipt
    const expected = canonicalHashV1Result(material)
    return Result.isSuccess(expected) && expected.success === receipt.receiptHash
  }),
)

const ForwardPerformanceReceiptEnvelopeMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.forward-performance-receipt-envelope.v1'),
  authorityGenerationHash: Sha256Schema,
  cycleId: Sha256Schema,
  receiptHash: Sha256Schema,
  receipt: ForwardPerformanceReceiptSchema,
  createdAt: UtcInstantSchema,
}).check(
  Schema.makeFilter((envelope) => {
    if (typeof envelope.receipt !== 'object' || envelope.receipt === null) return false
    if (!('receiptHash' in envelope.receipt) || envelope.receipt.receiptHash !== envelope.receiptHash) return false
    return true
  }),
)

export const ForwardPerformanceReceiptEnvelopeSchema = Schema.Struct({
  ...ForwardPerformanceReceiptEnvelopeMaterialSchema.fields,
  contentHash: Sha256Schema,
}).check(
  Schema.makeFilter((envelope) => {
    if (typeof envelope.receipt !== 'object' || envelope.receipt === null) return false
    if (!('receiptHash' in envelope.receipt) || envelope.receipt.receiptHash !== envelope.receiptHash) return false
    const { contentHash: _contentHash, ...material } = envelope
    const expected = canonicalHashV1Result(material)
    return Result.isSuccess(expected) && expected.success === envelope.contentHash
  }),
)

export type ForwardPerformanceReceiptEnvelopeMaterial = typeof ForwardPerformanceReceiptEnvelopeMaterialSchema.Type
export type ForwardPerformanceReceiptEnvelope = Omit<typeof ForwardPerformanceReceiptEnvelopeSchema.Type, 'receipt'> & {
  readonly receipt: ForwardPerformanceReceipt
}

export const makeForwardPerformanceReceiptEnvelope = (
  material: Omit<ForwardPerformanceReceiptEnvelopeMaterial, 'receipt'> & {
    readonly receipt: ForwardPerformanceReceipt
  },
): Result.Result<ForwardPerformanceReceiptEnvelope, 'ForwardPerformanceReceiptCanonicalizationFailed'> =>
  Result.map(canonicalHashV1Result(material), (contentHash) => ({ ...material, contentHash })).pipe(
    Result.mapError(() => 'ForwardPerformanceReceiptCanonicalizationFailed' as const),
  )

const decodeEnvelopeResult = Schema.decodeUnknownResult(ForwardPerformanceReceiptEnvelopeSchema, strictParseOptions)

export const decodeForwardPerformanceReceiptEnvelopeResult = (
  input: unknown,
): Result.Result<ForwardPerformanceReceiptEnvelope, unknown> =>
  decodeEnvelopeResult(input) as Result.Result<ForwardPerformanceReceiptEnvelope, unknown>

export class ForwardPerformanceReceiptPersistenceError extends Data.TaggedError(
  'ForwardPerformanceReceiptPersistenceError',
)<{ readonly message: string; readonly cause?: unknown }> {}

export const makePersistableForwardPerformanceReceiptEnvelope = (
  authorityGenerationHash: string,
  receipt: ForwardPerformanceReceipt,
): Result.Result<ForwardPerformanceReceiptEnvelope, ForwardPerformanceReceiptPersistenceError> => {
  const { window, evidence, reconciliationProof: proof } = receipt
  if (
    evidence.status !== 'SUFFICIENT' ||
    evidence.reasonCodes.length !== 0 ||
    receipt.profitability === 'UNDETERMINED' ||
    receipt.bindings.source === null ||
    receipt.bindings.strategy === null ||
    window.firstCycleId === null ||
    window.lastCycleId === null ||
    window.openedAt === null ||
    window.closedAt === null ||
    window.closedAt < window.openedAt ||
    window.reconciliationId === null ||
    window.reconciliationContentHash === null ||
    (window.reconciliationStatus !== 'EXACT' && window.cashYieldAdjustedExact !== true) ||
    !proof.accountingReceiptsExact ||
    !proof.ledgerExact ||
    proof.missingLedgerAccountCount !== 0 ||
    proof.unresolvedMutationCount !== 0 ||
    proof.unclosedCycleCount !== 0 ||
    proof.openPositionCount !== 0
  )
    return Result.fail(
      new ForwardPerformanceReceiptPersistenceError({
        message: 'Cannot persist a forward-performance receipt without sufficient, closed, exactly reconciled evidence',
      }),
    )

  return makeForwardPerformanceReceiptEnvelope({
    schemaVersion: 'bayn.forward-performance-receipt-envelope.v1',
    authorityGenerationHash,
    cycleId: window.lastCycleId,
    receiptHash: receipt.receiptHash,
    receipt,
    createdAt: window.closedAt,
  }).pipe(
    Result.flatMap(decodeForwardPerformanceReceiptEnvelopeResult),
    Result.mapError(
      (cause) =>
        new ForwardPerformanceReceiptPersistenceError({ message: 'Invalid forward-performance receipt', cause }),
    ),
  )
}

const decodePersistenceMatches = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ matches: Schema.Boolean })))

export const persistForwardPerformanceReceipt = (envelope: ForwardPerformanceReceiptEnvelope) =>
  Effect.gen(function* () {
    yield* Effect.fromResult(
      decodeForwardPerformanceReceiptEnvelopeResult(envelope).pipe(
        Result.mapError(
          (cause) =>
            new ForwardPerformanceReceiptPersistenceError({ message: 'Invalid forward-performance envelope', cause }),
        ),
      ),
    )
    const expected = yield* Effect.fromResult(
      makePersistableForwardPerformanceReceiptEnvelope(envelope.authorityGenerationHash, envelope.receipt),
    )
    if (expected.contentHash !== envelope.contentHash)
      return yield* new ForwardPerformanceReceiptPersistenceError({
        message: 'Forward-performance envelope must bind the report cycle and stable evidence timestamp',
      })
    const sql = yield* PgClient.PgClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // A reconciliation timestamp is not proof that a generation has ended. Only archive a
        // superseded generation, and hold the authority/cycle rows through the append.
        const terminal = yield* sql`
          SELECT true AS matches
          FROM authority_generations AS generation
          JOIN authority_state AS state
            ON state.singleton
            AND state.generation_hash <> generation.generation_hash
            AND state.version > generation.authority_version
          JOIN autonomous_cycles AS cycle
            ON cycle.cycle_id = ${envelope.cycleId}
            AND cycle.account_id = generation.account_id
            AND cycle.qualification_run_id = COALESCE(generation.qualification_run_id, generation.research_plan_hash)
          WHERE generation.generation_hash = ${envelope.authorityGenerationHash}
            AND generation.maximum = 'PAPER'
            AND generation.broker_identity_hash = ${envelope.receipt.bindings.account.accountReferenceHash}
            AND generation.broker_provider = ${envelope.receipt.bindings.account.provider}
            AND generation.broker_environment = ${envelope.receipt.bindings.account.environment}
            AND cycle.state IN ('COMPLETED', 'NO_TRADE')
            AND cycle.terminal_at <= ${envelope.createdAt}::timestamptz
            AND (
              EXISTS (
                SELECT 1 FROM intents AS cycle_intent
                WHERE cycle_intent.cycle_id = cycle.cycle_id
                  AND cycle_intent.account_id = generation.account_id
                  AND cycle_intent.authority_generation_hash = generation.generation_hash
              )
              OR EXISTS (
                SELECT 1 FROM autonomous_cycle_shadow_decisions AS decision
                WHERE decision.cycle_id = cycle.cycle_id
                  AND decision.decision_hash = cycle.decision_hash
                  AND decision.schema_version = 'bayn.paper-cycle-decision.v1'
                  AND decision.document ->> 'mode' = 'PAPER'
                  AND decision.document #>> '{bindings,accountId}' = generation.account_id
                  AND decision.document #>> '{bindings,qualificationRunId}' = cycle.qualification_run_id
                  AND decision.document #>> '{bindings,authorityGenerationHash}' = generation.generation_hash
              )
            )
            AND EXISTS (
              SELECT 1 FROM authority_generations AS successor
              WHERE successor.previous_generation_hash = generation.generation_hash
                AND successor.account_id = generation.account_id
                AND successor.authority_version > generation.authority_version
                AND successor.activated_at > ${envelope.createdAt}::timestamptz
            )
            AND NOT EXISTS (
              SELECT 1 FROM intents AS intent
              WHERE intent.authority_generation_hash = generation.generation_hash
                AND (intent.state <> 'TERMINAL' OR intent.updated_at > ${envelope.createdAt}::timestamptz)
            )
          FOR SHARE OF state, cycle
        `.pipe(Effect.flatMap(decodePersistenceMatches))
        if (terminal.length !== 1 || terminal[0]?.matches !== true)
          return yield* new ForwardPerformanceReceiptPersistenceError({
            message: 'Cannot persist a forward-performance receipt before its generation is superseded and settled',
          })

        yield* sql`
          INSERT INTO autonomous_forward_performance_receipts (
            authority_generation_hash, cycle_id, document, created_at
          ) VALUES (
            ${envelope.authorityGenerationHash}, ${envelope.cycleId}, ${sql.json(envelope)}, ${envelope.createdAt}
          )
          ON CONFLICT (authority_generation_hash) DO NOTHING
        `
        const rows = yield* sql`
          SELECT document = ${sql.json(envelope)} AS matches
          FROM autonomous_forward_performance_receipts
          WHERE authority_generation_hash = ${envelope.authorityGenerationHash}
        `.pipe(Effect.flatMap(decodePersistenceMatches))
        if (rows.length !== 1 || rows[0]?.matches !== true)
          return yield* new ForwardPerformanceReceiptPersistenceError({
            message: 'A different forward-performance receipt already exists for this authority generation',
          })
      }),
    )
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ForwardPerformanceReceiptPersistenceError
        ? cause
        : new ForwardPerformanceReceiptPersistenceError({
            message: 'Failed to persist the forward-performance receipt',
            cause,
          }),
    ),
  )
