import { PgClient } from '@effect/sql-pg'
import { Clock, Data, Effect, Option, Schema } from 'effect'

import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  AssetStatus,
  BrokerRead,
  type Account,
  type AssetObservation,
  type AssetObservationExchange,
  type ReadEvidence,
  type ReadResult,
} from './broker/alpaca'
import { RuntimeProvenanceSchema, makeStrategyProtocolHash } from './contracts'
import { CycleState, type AutonomousCycle } from './cycle'
import type { CycleOperationsProjection } from './cycle-observability'
import { CycleObservability } from './db/cycle-observability'
import { CycleStore } from './db/cycle-store'
import { canonicalHashV1 } from './hash'
import { Authority, OrderSide, OrderType, RiskOutcome, TimeInForce } from './paper'
import { Gate, Reason } from './risk'
import {
  GitSourceRevisionSchema,
  ImageDigestSchema,
  ImageRepositorySchema,
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnitIntervalSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'
import type { ObserveShadowDecisionDocument } from './shadow-decision-contract'
import { TargetPlanStatus } from './target-planner'

const discoverySchemaVersion = 'bayn.paper-proof-discovery.v1' as const
const bindingSchemaVersion = 'bayn.paper-proof-discovery-binding.v1' as const
const candidateFactsSchemaVersion = 'bayn.paper-proof-candidate-facts.v1' as const
const observationReceiptSchemaVersion = 'bayn.paper-proof-observation-receipt.v1' as const
const assetReadConcurrency = 3
const AssetObservationExchangeSchema = Schema.Enum(AssetExchange).pipe(
  Schema.refine((exchange): exchange is AssetObservationExchange => exchange !== AssetExchange.Empty, {
    expected: 'an Alpaca asset exchange other than the empty sentinel',
  }),
)

const ReadEvidenceSchema = Schema.Struct({
  requestId: StrictNonEmptyStringSchema,
  status: NonNegativeIntegerSchema,
  contentHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  rateLimit: Schema.optionalKey(
    Schema.Struct({
      limit: Schema.optionalKey(Schema.String),
      remaining: Schema.optionalKey(Schema.String),
      reset: Schema.optionalKey(Schema.String),
      retryAfter: Schema.optionalKey(Schema.String),
    }),
  ),
})

const AccountObservationSchema = Schema.Struct({
  id: StrictNonEmptyStringSchema,
  status: Schema.Enum(AccountStatus),
  currency: Schema.Literal('USD'),
  cashMicros: SignedMicrosSchema,
  equityMicros: SignedMicrosSchema,
  buyingPowerMicros: SignedMicrosSchema,
  accountBlocked: Schema.Boolean,
  tradingBlocked: Schema.Boolean,
  tradeSuspendedByUser: Schema.Boolean,
  observedAt: UtcInstantSchema,
})

const AssetObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-asset-observation.v1'),
  source: Schema.Literal('alpaca-v2-asset'),
  requestedSymbol: SymbolSchema,
  requestHash: Sha256Schema,
  assetId: StrictNonEmptyStringSchema,
  symbol: SymbolSchema,
  assetClass: Schema.Enum(AssetClass),
  exchange: AssetObservationExchangeSchema,
  status: Schema.Enum(AssetStatus),
  tradable: Schema.Boolean,
  fractionable: Schema.Boolean,
  attributes: Schema.Array(StrictNonEmptyStringSchema),
  observedAt: UtcInstantSchema,
  normalizedResponseHash: Sha256Schema,
})

export enum PaperProofCandidateIneligibility {
  AssetClass = 'ASSET_CLASS_NOT_US_EQUITY',
  Inactive = 'ASSET_INACTIVE',
  Ipo = 'ASSET_IPO',
  NotFractionable = 'ASSET_NOT_FRACTIONABLE',
  NotTradable = 'ASSET_NOT_TRADABLE',
  Otc = 'ASSET_OTC',
  PtpNoException = 'ASSET_PTP_NO_EXCEPTION',
}

const CandidateIneligibilitySchema = Schema.Enum(PaperProofCandidateIneligibility)

const RuntimeIdentitySchema = Schema.Struct({
  sourceRevision: GitSourceRevisionSchema,
  image: Schema.Struct({
    repository: ImageRepositorySchema,
    digest: ImageDigestSchema,
  }),
  strategy: RuntimeProvenanceSchema.fields.strategy,
  strategyProtocolHash: Sha256Schema,
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  policyHash: Sha256Schema,
})
export type PaperProofDiscoveryIdentity = typeof RuntimeIdentitySchema.Type

const DiscoveryBindingSchema = Schema.Struct({
  schemaVersion: Schema.Literal(bindingSchemaVersion),
  runtime: RuntimeIdentitySchema,
  cycle: Schema.Struct({
    cycleId: Sha256Schema,
    signalSessionDate: IsoDateSchema,
    executionSessionDate: IsoDateSchema,
    snapshotId: Sha256Schema,
    decisionHash: Sha256Schema,
    submissionCutoffAt: UtcInstantSchema,
    terminalAt: UtcInstantSchema,
  }),
  document: Schema.Struct({
    contentHash: Sha256Schema,
    snapshotContentHash: Sha256Schema,
    snapshotFinalizedAt: UtcInstantSchema,
    strategyDecisionHash: Sha256Schema,
    policyHash: Sha256Schema,
    planningBrokerStateHash: Sha256Schema,
    reconciliationId: Sha256Schema,
    reconciliationHash: Sha256Schema,
    targetPlanInputHash: Sha256Schema,
    targetPlanOutputHash: Sha256Schema,
    createdAt: UtcInstantSchema,
    expiresAt: UtcInstantSchema,
  }),
})
export type PaperProofDiscoveryBinding = typeof DiscoveryBindingSchema.Type

const AccountFactsSchema = Schema.Struct({
  id: StrictNonEmptyStringSchema,
  status: Schema.Enum(AccountStatus),
  currency: Schema.Literal('USD'),
  cashMicros: SignedMicrosSchema,
  equityMicros: SignedMicrosSchema,
  buyingPowerMicros: SignedMicrosSchema,
  accountBlocked: Schema.Boolean,
  tradingBlocked: Schema.Boolean,
  tradeSuspendedByUser: Schema.Boolean,
})

const AssetFactsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-asset-observation.v1'),
  source: Schema.Literal('alpaca-v2-asset'),
  requestedSymbol: SymbolSchema,
  requestHash: Sha256Schema,
  assetId: StrictNonEmptyStringSchema,
  symbol: SymbolSchema,
  assetClass: Schema.Enum(AssetClass),
  exchange: AssetObservationExchangeSchema,
  status: Schema.Enum(AssetStatus),
  tradable: Schema.Boolean,
  fractionable: Schema.Boolean,
  attributes: Schema.Array(StrictNonEmptyStringSchema),
  normalizedResponseHash: Sha256Schema,
})

const CandidateFactsSchema = Schema.Struct({
  ordinal: NonNegativeIntegerSchema,
  observedPlanIntentId: Sha256Schema,
  symbol: SymbolSchema,
  side: Schema.Enum(OrderSide),
  orderType: Schema.Enum(OrderType),
  timeInForce: Schema.Enum(TimeInForce),
  observedPlannedQuantityMicros: PositiveMicrosSchema,
  observedReferencePriceMicros: PositiveMicrosSchema,
  observedNotionalLimitMicros: PositiveMicrosSchema,
  observedEvaluatedOrderNotionalMicros: UnsignedMicrosSchema,
  observedTargetWeight: UnitIntervalSchema,
  observedCurrentQuantityMicros: SignedMicrosSchema,
  observedTargetQuantityMicros: SignedMicrosSchema,
  observedRiskDecisionId: Sha256Schema,
  observedRiskInputHash: Sha256Schema,
  asset: AssetFactsSchema,
  assetEligibility: Schema.Struct({
    eligible: Schema.Boolean,
    reasons: Schema.Array(CandidateIneligibilitySchema),
  }),
})

const CandidateFactsMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(candidateFactsSchemaVersion),
  immutableBindingHash: Sha256Schema,
  account: AccountFactsSchema,
  candidates: Schema.Array(CandidateFactsSchema),
  consistencyDelayMs: Schema.Struct({
    status: Schema.Literal('REQUIRED_UNBOUND'),
  }),
})
export type PaperProofCandidateFactsMaterial = typeof CandidateFactsMaterialSchema.Type

const BrokerObservationsSchema = Schema.Struct({
  account: Schema.Struct({
    value: AccountObservationSchema,
    evidence: ReadEvidenceSchema,
  }),
  assets: Schema.Array(
    Schema.Struct({
      ordinal: NonNegativeIntegerSchema,
      value: AssetObservationSchema,
      evidence: ReadEvidenceSchema,
    }),
  ),
})

const DiscoveryReceiptMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(discoverySchemaVersion),
  command: Schema.Literal('PREPARE'),
  phase: Schema.Literal('DISCOVER'),
  authority: Schema.Literal(Authority.Observe),
  dispatchable: Schema.Literal(false),
  binding: DiscoveryBindingSchema,
  immutableBindingHash: Sha256Schema,
  candidateFacts: CandidateFactsMaterialSchema,
  candidateFactsHash: Sha256Schema,
  observations: BrokerObservationsSchema,
  capturedAt: UtcInstantSchema,
  observationReceiptSchemaVersion: Schema.Literal(observationReceiptSchemaVersion),
})

const DiscoveryReceiptSchema = Schema.Struct({
  ...DiscoveryReceiptMaterialSchema.fields,
  observationReceiptHash: Sha256Schema,
})
export type PaperProofDiscoveryReceipt = typeof DiscoveryReceiptSchema.Type

export class PaperProofDiscoveryError extends Data.TaggedError('PaperProofDiscoveryError')<{
  readonly operation: 'broker-read' | 'decode' | 'read-snapshot' | 'validate'
  readonly failure:
    | 'account-mismatch'
    | 'broker'
    | 'cycle-mismatch'
    | 'cycle-missing'
    | 'cycle-unfinished'
    | 'document-mismatch'
    | 'document-missing'
    | 'document-stale'
    | 'invalid-input'
    | 'output'
    | 'risk-mismatch'
    | 'transaction'
  readonly message: string
  readonly cause?: unknown
}> {}

interface DiscoverySnapshot {
  readonly projection: CycleOperationsProjection
  readonly cycle: AutonomousCycle
  readonly document: ObserveShadowDecisionDocument
}

const fail = (
  operation: PaperProofDiscoveryError['operation'],
  failure: PaperProofDiscoveryError['failure'],
  message: string,
  cause?: unknown,
): PaperProofDiscoveryError => new PaperProofDiscoveryError({ operation, failure, message, cause })

const requireInvariant: (
  condition: boolean,
  failure: PaperProofDiscoveryError['failure'],
  message: string,
) => asserts condition = (condition, failure, message) => {
  if (!condition) throw fail('validate', failure, message)
}

const validateIdentity = (input: PaperProofDiscoveryIdentity) =>
  Schema.decodeUnknownEffect(
    RuntimeIdentitySchema,
    strictParseOptions,
  )(input).pipe(
    Effect.mapError((cause) => fail('decode', 'invalid-input', 'paper proof discovery identity is invalid', cause)),
  )

const ensure = (
  condition: boolean,
  failure: PaperProofDiscoveryError['failure'],
  message: string,
): Effect.Effect<void, PaperProofDiscoveryError> =>
  condition ? Effect.void : Effect.fail(fail('validate', failure, message))

const readDiscoverySnapshot = (
  identity: PaperProofDiscoveryIdentity,
): Effect.Effect<DiscoverySnapshot, PaperProofDiscoveryError, PgClient.PgClient | CycleObservability | CycleStore> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const observability = yield* CycleObservability
    const store = yield* CycleStore
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
        const projection = yield* observability.read(identity.qualificationRunId, identity.accountId)
        if (projection.unfinishedCycleCount !== 0 || projection.current !== null) {
          return yield* Effect.fail(
            fail('read-snapshot', 'cycle-unfinished', 'paper proof discovery requires zero unfinished cycles'),
          )
        }
        const last = projection.last
        if (last === null) {
          return yield* Effect.fail(
            fail('read-snapshot', 'cycle-missing', 'paper proof discovery requires a completed terminal cycle'),
          )
        }
        const cycle = yield* store.read(last.cycleId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  fail('read-snapshot', 'cycle-missing', 'latest completed cycle is missing from CycleStore'),
                ),
              onSome: Effect.succeed,
            }),
          ),
        )
        const document = yield* store.readDecisionDocument(last.cycleId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  fail(
                    'read-snapshot',
                    'document-missing',
                    'latest completed cycle has no persisted shadow decision document',
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
        )
        return { projection, cycle, document }
      }),
    )
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof PaperProofDiscoveryError
        ? cause
        : fail('read-snapshot', 'transaction', 'read-only discovery transaction failed', cause),
    ),
  )

const validateSnapshot = (
  identity: PaperProofDiscoveryIdentity,
  snapshot: DiscoverySnapshot,
  now: number,
): PaperProofDiscoveryBinding => {
  const { projection, cycle, document } = snapshot
  const last = projection.last
  requireInvariant(last !== null, 'cycle-missing', 'completed terminal cycle disappeared during validation')
  requireInvariant(last.phase === CycleState.Completed, 'cycle-mismatch', 'latest terminal cycle is not COMPLETED')
  requireInvariant(cycle.state === CycleState.Completed, 'cycle-mismatch', 'CycleStore cycle is not COMPLETED')
  requireInvariant(cycle.terminalAt !== undefined, 'cycle-mismatch', 'completed cycle has no terminal timestamp')
  requireInvariant(last.cycleId === cycle.identity.cycleId, 'cycle-mismatch', 'cycle projection identity mismatch')
  requireInvariant(last.accountId === identity.accountId, 'cycle-mismatch', 'cycle projection account mismatch')
  requireInvariant(
    last.signalSessionDate === cycle.identity.signalSessionDate &&
      last.executionSessionDate === cycle.identity.executionSessionDate &&
      last.submissionOpenAt === cycle.window.submissionOpenAt &&
      last.submissionCutoffAt === cycle.window.submissionCutoffAt &&
      last.executionOpenAt === cycle.window.executionOpenAt &&
      last.executionCloseAt === cycle.window.executionCloseAt &&
      last.terminalAt === cycle.terminalAt,
    'cycle-mismatch',
    'cycle projection chronology does not match the immutable CycleStore record',
  )
  requireInvariant(
    cycle.identity.accountId === identity.accountId,
    'cycle-mismatch',
    'cycle account does not match configured Alpaca account',
  )
  requireInvariant(
    cycle.identity.qualificationRunId === identity.qualificationRunId,
    'cycle-mismatch',
    'cycle qualification run does not match the configured terminal pin',
  )
  requireInvariant(
    cycle.identity.strategyProtocolHash === identity.strategyProtocolHash,
    'cycle-mismatch',
    'cycle strategy protocol does not match the current strategy',
  )
  requireInvariant(
    cycle.bindings.snapshotId !== undefined &&
      cycle.bindings.snapshotId === last.snapshotId &&
      cycle.bindings.snapshotId === document.bindings.snapshotId,
    'document-mismatch',
    'cycle projection, CycleStore, and shadow document Signal snapshots do not match',
  )
  requireInvariant(
    cycle.bindings.decisionHash !== undefined &&
      cycle.bindings.decisionHash === last.decisionHash &&
      cycle.bindings.decisionHash === document.contentHash,
    'document-mismatch',
    'cycle decision hash does not bind the persisted shadow document',
  )
  requireInvariant(
    document.bindings.cycleId === cycle.identity.cycleId &&
      document.bindings.accountId === identity.accountId &&
      document.bindings.strategyName === identity.strategy.name &&
      document.bindings.strategyProtocolHash === identity.strategyProtocolHash,
    'document-mismatch',
    'shadow document identity bindings do not match the cycle and runtime',
  )
  requireInvariant(
    document.bindings.policyHash === identity.policyHash,
    'document-mismatch',
    'shadow document policy does not match the current source-controlled risk policy',
  )
  requireInvariant(
    document.targetPlan.status === TargetPlanStatus.Planned && document.targetPlan.intentTargets.length > 0,
    'document-mismatch',
    'shadow document does not contain a PLANNED target plan',
  )
  requireInvariant(
    document.deltaRisk.length === document.targetPlan.intentTargets.length,
    'risk-mismatch',
    'shadow document risk evaluations do not align with the ordered target deltas',
  )
  requireInvariant(
    document.submissionCutoffAt === cycle.window.submissionCutoffAt &&
      document.expiresAt === cycle.window.submissionCutoffAt,
    'document-mismatch',
    'shadow document expiry does not match the immutable cycle cutoff',
  )
  requireInvariant(
    now < Date.parse(document.expiresAt),
    'document-stale',
    'shadow document has reached its exclusive submission cutoff',
  )
  const reconciliation = projection.reconciliation
  requireInvariant(reconciliation !== null, 'document-mismatch', 'latest reconciliation is unavailable')
  requireInvariant(
    reconciliation.accountId === identity.accountId &&
      reconciliation.reconciliationId === document.bindings.reconciliationId &&
      reconciliation.status === 'EXACT' &&
      reconciliation.discrepancyCount === 0 &&
      reconciliation.coversLatestMutation,
    'document-mismatch',
    'latest exact reconciliation does not match the document binding',
  )
  requireInvariant(
    projection.mutations.unresolvedCount === 0,
    'document-mismatch',
    'unresolved broker mutations remain after the document-bound reconciliation',
  )

  for (const [index, risk] of document.deltaRisk.entries()) {
    const failed = risk.evaluation.gates.filter((gate) => !gate.passed)
    requireInvariant(
      risk.evaluation.decision.outcome === RiskOutcome.Blocked &&
        risk.evaluation.decision.reasonCodes.length === 1 &&
        risk.evaluation.decision.reasonCodes[0] === Reason.AuthorityNotPaper &&
        failed.length === 1 &&
        failed[0]?.name === Gate.Authority &&
        failed[0]?.reason === Reason.AuthorityNotPaper,
      'risk-mismatch',
      `shadow delta ${index} is not blocked only by AuthorityNotPaper`,
    )
  }

  return {
    schemaVersion: bindingSchemaVersion,
    runtime: identity,
    cycle: {
      cycleId: cycle.identity.cycleId,
      signalSessionDate: cycle.identity.signalSessionDate,
      executionSessionDate: cycle.identity.executionSessionDate,
      snapshotId: cycle.bindings.snapshotId,
      decisionHash: document.contentHash,
      submissionCutoffAt: cycle.window.submissionCutoffAt,
      terminalAt: cycle.terminalAt,
    },
    document: {
      contentHash: document.contentHash,
      snapshotContentHash: document.bindings.snapshotContentHash,
      snapshotFinalizedAt: document.bindings.snapshotFinalizedAt,
      strategyDecisionHash: document.bindings.strategyDecisionHash,
      policyHash: document.bindings.policyHash,
      planningBrokerStateHash: document.bindings.planningBrokerStateHash,
      reconciliationId: document.bindings.reconciliationId,
      reconciliationHash: document.bindings.reconciliationHash,
      targetPlanInputHash: document.targetPlan.inputHash,
      targetPlanOutputHash: document.targetPlan.outputHash,
      createdAt: document.createdAt,
      expiresAt: document.expiresAt,
    },
  }
}

const accountFacts = (account: Account): typeof AccountFactsSchema.Type => ({
  id: account.id,
  status: account.status,
  currency: account.currency,
  cashMicros: account.cashMicros,
  equityMicros: account.equityMicros,
  buyingPowerMicros: account.buyingPowerMicros,
  accountBlocked: account.accountBlocked,
  tradingBlocked: account.tradingBlocked,
  tradeSuspendedByUser: account.tradeSuspendedByUser,
})

const assetFacts = (asset: AssetObservation): typeof AssetFactsSchema.Type => ({
  schemaVersion: asset.schemaVersion,
  source: asset.source,
  requestedSymbol: asset.requestedSymbol,
  requestHash: asset.requestHash,
  assetId: asset.assetId,
  symbol: asset.symbol,
  assetClass: asset.assetClass,
  exchange: asset.exchange,
  status: asset.status,
  tradable: asset.tradable,
  fractionable: asset.fractionable,
  attributes: asset.attributes,
  normalizedResponseHash: asset.normalizedResponseHash,
})

const assetEligibility = (asset: AssetObservation) => {
  const reasons: PaperProofCandidateIneligibility[] = []
  if (asset.assetClass !== AssetClass.UsEquity) reasons.push(PaperProofCandidateIneligibility.AssetClass)
  if (asset.status !== AssetStatus.Active) reasons.push(PaperProofCandidateIneligibility.Inactive)
  if (!asset.tradable) reasons.push(PaperProofCandidateIneligibility.NotTradable)
  if (!asset.fractionable) reasons.push(PaperProofCandidateIneligibility.NotFractionable)
  if (asset.exchange === AssetExchange.Otc) reasons.push(PaperProofCandidateIneligibility.Otc)
  if (asset.attributes.includes('ipo')) reasons.push(PaperProofCandidateIneligibility.Ipo)
  if (asset.attributes.includes('ptp_no_exception')) reasons.push(PaperProofCandidateIneligibility.PtpNoException)
  return { eligible: reasons.length === 0, reasons } as const
}

const validateReadEvidence = <A extends { readonly observedAt: string }>(
  result: ReadResult<A>,
  label: string,
): void => {
  requireInvariant(
    result.value.observedAt === result.evidence.observedAt,
    'broker',
    `${label} value and evidence observation times do not match`,
  )
}

const normalizedReadEvidence = (evidence: ReadEvidence): typeof ReadEvidenceSchema.Type => {
  const rateLimit =
    evidence.rateLimit === undefined
      ? {}
      : {
          ...(evidence.rateLimit.limit === undefined ? {} : { limit: evidence.rateLimit.limit }),
          ...(evidence.rateLimit.remaining === undefined ? {} : { remaining: evidence.rateLimit.remaining }),
          ...(evidence.rateLimit.reset === undefined ? {} : { reset: evidence.rateLimit.reset }),
          ...(evidence.rateLimit.retryAfter === undefined ? {} : { retryAfter: evidence.rateLimit.retryAfter }),
        }
  return {
    requestId: evidence.requestId,
    status: evidence.status,
    contentHash: evidence.contentHash,
    observedAt: evidence.observedAt,
    ...(Object.keys(rateLimit).length === 0 ? {} : { rateLimit }),
  }
}

const makeReceipt = (
  identity: PaperProofDiscoveryIdentity,
  snapshot: DiscoverySnapshot,
  binding: PaperProofDiscoveryBinding,
  account: ReadResult<Account>,
  assets: readonly ReadResult<AssetObservation>[],
  capturedAt: string,
): PaperProofDiscoveryReceipt => {
  requireInvariant(account.value.id === identity.accountId, 'account-mismatch', 'Alpaca account identity mismatch')
  validateReadEvidence(account, 'account')
  const candidates = snapshot.document.targetPlan.intentTargets.map((intent, ordinal) => {
    const target = snapshot.document.targetPlan.targets.find((candidate) => candidate.symbol === intent.symbol)
    const risk = snapshot.document.deltaRisk[ordinal]
    const asset = assets[ordinal]
    requireInvariant(target !== undefined, 'document-mismatch', `planned target ${intent.symbol} is missing`)
    requireInvariant(risk !== undefined, 'risk-mismatch', `risk evaluation ${ordinal} is missing`)
    requireInvariant(asset !== undefined, 'broker', `asset observation ${ordinal} is missing`)
    validateReadEvidence(asset, `asset ${intent.symbol}`)
    requireInvariant(
      asset.value.requestedSymbol === intent.symbol && asset.value.symbol === intent.symbol,
      'broker',
      `asset observation does not match planned symbol ${intent.symbol}`,
    )
    return {
      ordinal,
      observedPlanIntentId: risk.evaluation.input.intentId,
      symbol: intent.symbol,
      side: intent.side,
      orderType: intent.orderType,
      timeInForce: intent.timeInForce,
      observedPlannedQuantityMicros: intent.quantityMicros,
      observedReferencePriceMicros: target.referencePriceMicros,
      observedNotionalLimitMicros: risk.notionalLimitMicros,
      observedEvaluatedOrderNotionalMicros: risk.evaluation.metrics.orderNotionalMicros,
      observedTargetWeight: target.targetWeight,
      observedCurrentQuantityMicros: target.currentQuantityMicros,
      observedTargetQuantityMicros: target.targetQuantityMicros,
      observedRiskDecisionId: risk.evaluation.decision.decisionId,
      observedRiskInputHash: risk.evaluation.input.inputHash,
      asset: assetFacts(asset.value),
      assetEligibility: assetEligibility(asset.value),
    }
  })
  const immutableBindingHash = canonicalHashV1(binding)
  const candidateFacts = {
    schemaVersion: candidateFactsSchemaVersion,
    immutableBindingHash,
    account: accountFacts(account.value),
    candidates,
    consistencyDelayMs: { status: 'REQUIRED_UNBOUND' as const },
  }
  const candidateFactsHash = canonicalHashV1(candidateFacts)
  const material = {
    schemaVersion: discoverySchemaVersion,
    command: 'PREPARE' as const,
    phase: 'DISCOVER' as const,
    authority: Authority.Observe,
    dispatchable: false as const,
    binding,
    immutableBindingHash,
    candidateFacts,
    candidateFactsHash,
    observations: {
      account: { value: account.value, evidence: normalizedReadEvidence(account.evidence) },
      assets: assets.map((asset, ordinal) => ({
        ordinal,
        value: asset.value,
        evidence: normalizedReadEvidence(asset.evidence),
      })),
    },
    capturedAt,
    observationReceiptSchemaVersion,
  }
  return Schema.decodeUnknownSync(
    DiscoveryReceiptSchema,
    strictParseOptions,
  )({
    ...material,
    observationReceiptHash: canonicalHashV1(material),
  })
}

export const discoverPaperProofCandidates = (
  candidateIdentity: PaperProofDiscoveryIdentity,
): Effect.Effect<
  PaperProofDiscoveryReceipt,
  PaperProofDiscoveryError,
  PgClient.PgClient | CycleObservability | CycleStore | BrokerRead
> =>
  Effect.gen(function* () {
    const identity = yield* validateIdentity(candidateIdentity)
    yield* ensure(
      identity.strategyProtocolHash === makeStrategyProtocolHash(identity.strategy),
      'invalid-input',
      'paper proof discovery strategy protocol hash is invalid',
    )
    const snapshot = yield* readDiscoverySnapshot(identity)
    const startedAt = yield* Clock.currentTimeMillis
    const binding = yield* Effect.try({
      try: () => validateSnapshot(identity, snapshot, startedAt),
      catch: (cause) =>
        cause instanceof PaperProofDiscoveryError
          ? cause
          : fail('validate', 'document-mismatch', 'paper proof discovery binding validation failed', cause),
    })
    const broker = yield* BrokerRead
    const account = yield* broker.account.pipe(
      Effect.mapError((cause) => fail('broker-read', 'broker', 'Alpaca discovery read failed', cause)),
    )
    yield* Effect.try({
      try: () => {
        requireInvariant(
          account.value.id === identity.accountId,
          'account-mismatch',
          'Alpaca account identity mismatch',
        )
        validateReadEvidence(account, 'account')
      },
      catch: (cause) =>
        cause instanceof PaperProofDiscoveryError
          ? cause
          : fail('validate', 'account-mismatch', 'Alpaca account observation is invalid', cause),
    })
    const assets = yield* Effect.forEach(
      snapshot.document.targetPlan.intentTargets,
      (intent) => broker.assetBySymbol(intent.symbol),
      { concurrency: assetReadConcurrency },
    ).pipe(Effect.mapError((cause) => fail('broker-read', 'broker', 'Alpaca asset discovery read failed', cause)))
    const capturedAtMs = yield* Clock.currentTimeMillis
    const capturedAt = new Date(capturedAtMs).toISOString()
    yield* ensure(
      capturedAtMs < Date.parse(snapshot.document.expiresAt),
      'document-stale',
      'shadow document reached its exclusive submission cutoff during broker observation',
    )
    return yield* Effect.try({
      try: () => makeReceipt(identity, snapshot, binding, account, assets, capturedAt),
      catch: (cause) =>
        cause instanceof PaperProofDiscoveryError
          ? cause
          : fail('decode', 'output', 'paper proof discovery receipt is invalid', cause),
    })
  })
