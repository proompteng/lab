import { Data, Result, Schema } from 'effect'

import { quantizeAlpacaLimitPriceMicros } from './broker/alpaca-price'
import { intentIdForPlan, executionIntentIdForDecodedPlan } from './execution/intents/domain'
import { ExecutionSessionBindingSchema } from './execution-session'
import { canonicalHashV1Result, sha256 } from './hash'
import { OrderSide, PositiveMicrosSchema, RiskOutcome } from './execution/contracts'
import {
  legacyCycleDecisionSchemaVersion,
  legacyExecutionAuthorityToken,
  legacyIntentPlanSchemaVersion,
  legacyObserveAuthorityToken,
} from './execution/legacy-wire'
import { EvaluationSchema, Reason, isAuthorityNotGrantedReason } from './risk'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'
import { TargetPlanResultSchema, TargetPlanStatus } from './target-planner'

const ExecutionCalendarObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  source: Schema.Literal('alpaca-v2-calendar'),
  requestedRange: Schema.Struct({ start: IsoDateSchema, end: IsoDateSchema }),
  timeZone: Schema.Literal('UTC'),
  sessions: Schema.Array(
    Schema.Struct({ date: IsoDateSchema, openAt: UtcInstantSchema, closeAt: UtcInstantSchema }),
  ).check(Schema.isMinLength(1)),
  normalizedResponseHash: Sha256Schema,
})

const ExecutionArchiveWatermarkSchema = Schema.Struct({
  sourceTopic: StrictNonEmptyStringSchema,
  sourcePartition: NonNegativeIntegerSchema,
  inclusiveLastOffset: UnsignedMicrosSchema,
})

const ExecutionLineageSchema = Schema.Struct({
  sourceTopic: StrictNonEmptyStringSchema,
  sourcePartition: NonNegativeIntegerSchema,
  firstOffset: UnsignedMicrosSchema,
  lastOffset: UnsignedMicrosSchema,
  recordCount: PositiveIntegerSchema,
})

const ExecutionMarketDataBindingFields = {
  snapshotSchemaVersion: Schema.Literal('bayn.intraday-market-snapshot.v1'),
  sessionDate: IsoDateSchema,
  calendar: ExecutionCalendarObservationSchema,
  rangeStartAt: UtcInstantSchema,
  rangeEndAt: UtcInstantSchema,
  observedAt: UtcInstantSchema,
  universeId: StrictNonEmptyStringSchema,
  universeSymbolHash: Sha256Schema,
  symbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  purpose: Schema.optionalKey(Schema.Literal('LIQUIDATION')),
  feed: Schema.Literals(['iex', 'sip', 'delayed_sip']),
  delayClass: Schema.Literals(['real_time_exchange_only', 'real_time_consolidated', 'delayed_15m_consolidated']),
  sourceTopics: Schema.Struct({
    bars: StrictNonEmptyStringSchema,
    quotes: StrictNonEmptyStringSchema,
    trades: StrictNonEmptyStringSchema,
  }),
  archiveWatermarks: Schema.Array(ExecutionArchiveWatermarkSchema).check(Schema.isMinLength(1)),
  maximumQuoteAgeMs: PositiveIntegerSchema,
  minimumWatermarkLagMs: NonNegativeIntegerSchema,
  barCount: NonNegativeIntegerSchema,
  quoteCount: PositiveIntegerSchema,
  tradeCount: NonNegativeIntegerSchema,
  barsContentHash: Sha256Schema,
  quotesContentHash: Sha256Schema,
  tradesContentHash: Sha256Schema,
  lineage: Schema.Array(ExecutionLineageSchema).check(Schema.isMinLength(1)),
  contentHash: Sha256Schema,
  snapshotId: Sha256Schema,
} as const

const ExecutionMarketDataBindingBase = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.execution-market-data-binding.v1'),
    ...ExecutionMarketDataBindingFields,
    universe: Schema.optionalKey(Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique())),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.execution-market-data-binding.v2'),
    ...ExecutionMarketDataBindingFields,
    universe: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  }),
])

export const reconciledPositionLiquidationBindingSchemaVersion =
  'bayn.reconciled-position-liquidation-binding.v1' as const

const ReconciledPositionLiquidationBindingBase = Schema.Struct({
  schemaVersion: Schema.Literal(reconciledPositionLiquidationBindingSchemaVersion),
  purpose: Schema.Literal('LIQUIDATION'),
  source: Schema.Literal('alpaca-v2-positions'),
  sessionDate: IsoDateSchema,
  calendar: ExecutionCalendarObservationSchema,
  observedAt: UtcInstantSchema,
  symbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  positionsObservedAt: UtcInstantSchema,
  reconciliationId: Sha256Schema,
  reconciliationHash: Sha256Schema,
  positions: Schema.Array(
    Schema.Struct({
      symbol: SymbolSchema,
      quantityMicros: SignedMicrosSchema,
      marketPriceMicros: PositiveMicrosSchema,
      observedAt: UtcInstantSchema,
    }),
  ).check(Schema.isMinLength(1)),
  contentHash: Sha256Schema,
  snapshotId: Sha256Schema,
})

const compareCanonicalText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareTopicPartition = (
  left: { readonly sourceTopic: string; readonly sourcePartition: number },
  right: { readonly sourceTopic: string; readonly sourcePartition: number },
): number => compareCanonicalText(left.sourceTopic, right.sourceTopic) || left.sourcePartition - right.sourcePartition

const marketDataBindingIssues = (
  binding: typeof ExecutionMarketDataBindingBase.Type,
): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const { normalizedResponseHash, ...calendarMaterial } = binding.calendar
  const calendarHash = canonicalHashV1Result(calendarMaterial)
  if (Result.isFailure(calendarHash) || calendarHash.success !== normalizedResponseHash) {
    issues.push({ path: ['calendar', 'normalizedResponseHash'], issue: 'must match the canonical calendar content' })
  }

  const topics = Object.values(binding.sourceTopics)
  if (new Set(topics).size !== topics.length) {
    issues.push({ path: ['sourceTopics'], issue: 'bar, quote, and trade topics must be distinct' })
  }
  const universe = binding.universe
  if (binding.schemaVersion === 'bayn.execution-market-data-binding.v1' && binding.purpose === 'LIQUIDATION') {
    issues.push({ path: ['purpose'], issue: 'liquidation evidence requires execution market-data binding v2' })
  }
  if (binding.purpose === 'LIQUIDATION' && universe === undefined) {
    issues.push({ path: ['universe'], issue: 'must bind the canonical source universe for liquidation' })
  }
  const orderedUniverse = universe?.toSorted(compareCanonicalText)
  const orderedSymbols = binding.symbols.toSorted(compareCanonicalText)
  if (universe !== undefined && universe.some((symbol, index) => symbol !== orderedUniverse?.[index])) {
    issues.push({ path: ['universe'], issue: 'must be canonically ordered' })
  }
  if (binding.symbols.some((symbol, index) => symbol !== orderedSymbols[index])) {
    issues.push({ path: ['symbols'], issue: 'must be canonically ordered' })
  }
  if (
    universe !== undefined &&
    (sha256(universe.join(',')) !== binding.universeSymbolHash ||
      binding.symbols.some((symbol) => !universe.includes(symbol)))
  ) {
    issues.push({ path: ['symbols'], issue: 'must be a subset of the canonical bound universe' })
  }
  if (binding.purpose !== 'LIQUIDATION' && binding.barCount === 0) {
    issues.push({ path: ['barCount'], issue: 'must be positive outside liquidation' })
  }
  if (binding.purpose !== 'LIQUIDATION' && binding.tradeCount === 0) {
    issues.push({ path: ['tradeCount'], issue: 'must be positive outside liquidation' })
  }
  const watermarks = binding.archiveWatermarks
  const lineage = binding.lineage
  const orderedWatermarks = watermarks.toSorted(compareTopicPartition)
  const orderedLineage = lineage.toSorted(compareTopicPartition)
  if (watermarks.some((watermark, index) => watermark !== orderedWatermarks[index])) {
    issues.push({ path: ['archiveWatermarks'], issue: 'must be canonically ordered by topic and partition' })
  }
  if (lineage.some((entry, index) => entry !== orderedLineage[index])) {
    issues.push({ path: ['lineage'], issue: 'must be canonically ordered by topic and partition' })
  }
  const watermarkKeys = watermarks.map(({ sourceTopic, sourcePartition }) => `${sourceTopic}\u0000${sourcePartition}`)
  const lineageKeys = lineage.map(({ sourceTopic, sourcePartition }) => `${sourceTopic}\u0000${sourcePartition}`)
  if (new Set(watermarkKeys).size !== watermarkKeys.length) {
    issues.push({ path: ['archiveWatermarks'], issue: 'topic and partition pairs must be unique' })
  }
  if (new Set(lineageKeys).size !== lineageKeys.length) {
    issues.push({ path: ['lineage'], issue: 'topic and partition pairs must be unique' })
  }

  const { contentHash, snapshotId, schemaVersion: _, snapshotSchemaVersion, ...bindingMaterial } = binding
  const snapshotMaterial = { schemaVersion: snapshotSchemaVersion, ...bindingMaterial }
  const expectedContentHash = canonicalHashV1Result(snapshotMaterial)
  if (Result.isFailure(expectedContentHash) || expectedContentHash.success !== contentHash) {
    issues.push({ path: ['contentHash'], issue: 'must match the complete canonical intraday snapshot material' })
  } else {
    const expectedSnapshotId = canonicalHashV1Result({ ...snapshotMaterial, contentHash })
    if (Result.isFailure(expectedSnapshotId) || expectedSnapshotId.success !== snapshotId) {
      issues.push({ path: ['snapshotId'], issue: 'must match the complete canonical intraday snapshot identity' })
    }
  }
  return issues
}

const ReconciledPositionLiquidationBindingSchema = ReconciledPositionLiquidationBindingBase.check(
  Schema.makeFilter((binding: typeof ReconciledPositionLiquidationBindingBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    const { normalizedResponseHash, ...calendarMaterial } = binding.calendar
    const calendarHash = canonicalHashV1Result(calendarMaterial)
    if (Result.isFailure(calendarHash) || calendarHash.success !== normalizedResponseHash) {
      issues.push({ path: ['calendar', 'normalizedResponseHash'], issue: 'must match the canonical calendar content' })
    }

    const orderedSymbols = binding.symbols.toSorted(compareCanonicalText)
    const orderedPositions = binding.positions.toSorted((left, right) =>
      compareCanonicalText(left.symbol, right.symbol),
    )
    if (binding.symbols.some((symbol, index) => symbol !== orderedSymbols[index])) {
      issues.push({ path: ['symbols'], issue: 'must be canonically ordered' })
    }
    if (
      binding.positions.some((position, index) => position !== orderedPositions[index]) ||
      new Set(binding.positions.map(({ symbol }) => symbol)).size !== binding.positions.length
    ) {
      issues.push({ path: ['positions'], issue: 'must contain unique positions in canonical symbol order' })
    }
    const positionSymbols = binding.positions.map(({ symbol }) => symbol)
    if (
      positionSymbols.length !== binding.symbols.length ||
      positionSymbols.some((symbol, index) => symbol !== binding.symbols[index])
    ) {
      issues.push({ path: ['positions'], issue: 'must bind exactly one nonzero reconciled position per symbol' })
    }
    for (const [index, position] of binding.positions.entries()) {
      if (BigInt(position.quantityMicros) === 0n) {
        issues.push({ path: ['positions', index, 'quantityMicros'], issue: 'must be nonzero' })
      }
      if (position.observedAt !== binding.positionsObservedAt) {
        issues.push({ path: ['positions', index, 'observedAt'], issue: 'must match positionsObservedAt' })
      }
    }
    if (binding.observedAt !== binding.positionsObservedAt) {
      issues.push({ path: ['observedAt'], issue: 'must match the reconciled position observation time' })
    }

    const { contentHash, snapshotId, ...material } = binding
    const expectedContentHash = canonicalHashV1Result(material)
    if (Result.isFailure(expectedContentHash) || expectedContentHash.success !== contentHash) {
      issues.push({ path: ['contentHash'], issue: 'must match the complete canonical liquidation material' })
    } else {
      const expectedSnapshotId = canonicalHashV1Result({ ...material, contentHash })
      if (Result.isFailure(expectedSnapshotId) || expectedSnapshotId.success !== snapshotId) {
        issues.push({ path: ['snapshotId'], issue: 'must match the complete canonical liquidation identity' })
      }
    }
    return issues
  }),
)

const ArchiveExecutionMarketDataBindingSchema = ExecutionMarketDataBindingBase.check(
  Schema.makeFilter(marketDataBindingIssues),
)

export const ExecutionMarketDataBindingSchema = Schema.Union([
  ArchiveExecutionMarketDataBindingSchema,
  ReconciledPositionLiquidationBindingSchema,
])
export type ExecutionMarketDataBinding = typeof ExecutionMarketDataBindingSchema.Type

const ShadowDecisionBindingsSchema = Schema.Struct({
  strategyName: StrictNonEmptyStringSchema,
  cycleId: Sha256Schema,
  strategyProtocolHash: Sha256Schema,
  snapshotId: Sha256Schema,
  snapshotContentHash: Sha256Schema,
  snapshotFinalizedAt: UtcInstantSchema,
  strategyDecisionHash: Sha256Schema,
  policyHash: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  planningBrokerStateHash: Sha256Schema,
  reconciliationId: Sha256Schema,
  reconciliationHash: Sha256Schema,
  executionMarketData: Schema.optionalKey(ExecutionMarketDataBindingSchema),
})
export type ShadowDecisionBindings = typeof ShadowDecisionBindingsSchema.Type

const DeltaRiskEvaluationSchema = Schema.Struct({
  notionalLimitMicros: PositiveMicrosSchema,
  evaluation: EvaluationSchema,
})
export type DeltaRiskEvaluation = typeof DeltaRiskEvaluationSchema.Type

const ObserveShadowDecisionMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.observe-shadow-decision.v1'),
  mode: Schema.Literal(legacyObserveAuthorityToken),
  dispatchable: Schema.Literal(false),
  bindings: ShadowDecisionBindingsSchema,
  targetPlan: TargetPlanResultSchema,
  deltaRisk: Schema.Array(DeltaRiskEvaluationSchema),
  createdAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
})
export type ObserveShadowDecisionMaterial = typeof ObserveShadowDecisionMaterialSchema.Type

const materialIssues = (document: ObserveShadowDecisionMaterial): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (document.expiresAt !== document.submissionCutoffAt) {
    issues.push({ path: ['expiresAt'], issue: 'must equal the immutable cycle submission cutoff' })
  }
  if (document.createdAt >= document.submissionCutoffAt) {
    issues.push({ path: ['createdAt'], issue: 'must precede the immutable cycle submission cutoff' })
  }

  const targets = document.targetPlan.intentTargets
  const expectedRiskCount = document.targetPlan.status === TargetPlanStatus.Planned ? targets.length : 0
  if (document.deltaRisk.length !== expectedRiskCount) {
    issues.push({ path: ['deltaRisk'], issue: 'must align one-for-one with the ordered planned target deltas' })
  }
  for (const [index, target] of targets.entries()) {
    if (
      target.strategyName !== document.bindings.strategyName ||
      target.cycleId !== document.bindings.cycleId ||
      target.decisionHash !== document.bindings.strategyDecisionHash ||
      target.policyHash !== document.bindings.policyHash ||
      target.accountId !== document.bindings.accountId ||
      target.createdAt !== document.createdAt
    ) {
      issues.push({ path: ['targetPlan', 'intentTargets', index], issue: 'must match the shadow decision bindings' })
    }
  }
  for (const [index, risk] of document.deltaRisk.entries()) {
    const evaluation = risk.evaluation
    const target = targets[index]
    if (target !== undefined) {
      const identity = intentIdForPlan({
        schemaVersion: legacyIntentPlanSchemaVersion,
        ...target,
        notionalLimitMicros: risk.notionalLimitMicros,
      })
      if (Result.isFailure(identity)) {
        issues.push({
          path: ['deltaRisk', index, 'evaluation', 'input', 'intentId'],
          issue: 'corresponding ordered target delta must have a canonical identity',
        })
      } else if (evaluation.input.intentId !== identity.success) {
        issues.push({
          path: ['deltaRisk', index, 'evaluation', 'input', 'intentId'],
          issue: 'must bind the corresponding ordered target delta',
        })
      }
    }
    if (evaluation.policyHash !== document.bindings.policyHash) {
      issues.push({ path: ['deltaRisk', index, 'evaluation', 'policyHash'], issue: 'must match the bound policy' })
    }
    if (
      evaluation.decision.outcome !== RiskOutcome.Blocked ||
      !evaluation.decision.reasonCodes.some(isAuthorityNotGrantedReason)
    ) {
      issues.push({
        path: ['deltaRisk', index, 'evaluation', 'decision'],
        issue: 'OBSERVE risk must remain blocked while execution authority is unavailable',
      })
    }
    if (
      evaluation.decision.decidedAt !== document.createdAt ||
      evaluation.decision.expiresAt > document.submissionCutoffAt
    ) {
      issues.push({
        path: ['deltaRisk', index, 'evaluation', 'decision'],
        issue: 'must be evaluated with this shadow decision and expire by the cycle cutoff',
      })
    }
  }
  return issues
}

const ObserveShadowDecisionDocumentBase = Schema.Struct({
  ...ObserveShadowDecisionMaterialSchema.fields,
  contentHash: Sha256Schema,
})

const ObserveShadowDecisionDocumentSemanticSchema = ObserveShadowDecisionDocumentBase.check(
  Schema.makeFilter((document) => materialIssues(document)),
)

const documentHashIssues = (
  document: typeof ObserveShadowDecisionDocumentSemanticSchema.Type,
): readonly Schema.FilterIssue[] => {
  const { contentHash, ...material } = document
  const expectedHash = canonicalHashV1Result(material)
  if (Result.isFailure(expectedHash)) {
    return [{ path: ['contentHash'], issue: 'shadow decision material must be canonicalizable' }]
  }
  return contentHash === expectedHash.success
    ? []
    : [{ path: ['contentHash'], issue: 'must match the canonical shadow decision material' }]
}

export const ObserveShadowDecisionDocumentSchema = ObserveShadowDecisionDocumentSemanticSchema.check(
  Schema.makeFilter(documentHashIssues),
)
export type ObserveShadowDecisionDocument = typeof ObserveShadowDecisionDocumentSchema.Type

const ExecutionDecisionBindingsSchema = Schema.Struct({
  ...ShadowDecisionBindingsSchema.fields,
  qualificationRunId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
})

const ExecutionRiskBlockSchema = Schema.Struct({
  intentId: Sha256Schema,
  decisionId: Sha256Schema,
  reasonCodes: Schema.Array(StrictNonEmptyStringSchema).check(Schema.isMinLength(1), Schema.isUnique()),
})

const ExecutionDecisionMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(legacyCycleDecisionSchemaVersion),
  mode: Schema.Literal(legacyExecutionAuthorityToken),
  dispatchable: Schema.Boolean,
  bindings: ExecutionDecisionBindingsSchema,
  /** Persist the complete signal/session binding so a close plan can be built after data services expire. */
  executionSession: Schema.optionalKey(ExecutionSessionBindingSchema),
  targetPlan: TargetPlanResultSchema,
  deltaRisk: Schema.Array(DeltaRiskEvaluationSchema),
  orderedIntentIds: Schema.Array(Sha256Schema),
  riskBlock: Schema.optionalKey(ExecutionRiskBlockSchema),
  /** Previous close-plan content hash used to derive a distinct residual close identity. */
  replanGenerationHash: Schema.optionalKey(Sha256Schema),
  createdAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
})

const executionMaterialIssues = (
  document: typeof ExecutionDecisionMaterialSchema.Type,
): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (document.expiresAt !== document.submissionCutoffAt) {
    issues.push({ path: ['expiresAt'], issue: 'must equal the immutable cycle submission cutoff' })
  }
  if (document.createdAt >= document.expiresAt) {
    issues.push({ path: ['createdAt'], issue: 'must precede execution authority expiry' })
  }
  const usesReconciledPositionMark =
    document.targetPlan.executionTerms?.priceReference === 'reconciled-broker-position-mark'
  const executionMarketData = document.bindings.executionMarketData
  const reconciledPositionBinding =
    executionMarketData?.schemaVersion === reconciledPositionLiquidationBindingSchemaVersion
      ? executionMarketData
      : undefined
  const usesLiquidationMarketData = executionMarketData?.purpose === 'LIQUIDATION'
  const targetExecutionTerms = document.targetPlan.executionTerms
  const isClosePlan = targetExecutionTerms?.executionPurpose !== undefined
  if (usesLiquidationMarketData !== isClosePlan) {
    issues.push({
      path: ['bindings', 'executionMarketData', 'purpose'],
      issue: 'liquidation market data must bind a close-only target plan and must not bind an entry plan',
    })
  }
  if (usesReconciledPositionMark !== (reconciledPositionBinding !== undefined)) {
    issues.push({
      path: ['bindings', 'executionMarketData'],
      issue: 'reconciled broker-position execution terms require their exact liquidation binding and vice versa',
    })
  }
  if (
    executionMarketData !== undefined &&
    targetExecutionTerms !== undefined &&
    (executionMarketData.snapshotId !== targetExecutionTerms.snapshotId ||
      executionMarketData.contentHash !== targetExecutionTerms.snapshotContentHash)
  ) {
    issues.push({
      path: ['bindings', 'executionMarketData', 'snapshotId'],
      issue: 'must match the exact market-data snapshot persisted by the target plan',
    })
  }
  if (document.bindings.strategyName === 'intraday-momentum' && !isClosePlan) {
    if (executionMarketData?.schemaVersion !== 'bayn.execution-market-data-binding.v2') {
      issues.push({
        path: ['bindings', 'executionMarketData', 'schemaVersion'],
        issue: 'intraday-momentum entry requires execution market-data binding v2',
      })
    } else {
      const executionSession = document.executionSession
      if (
        executionSession === undefined ||
        executionMarketData.sessionDate !== executionSession.executionSession.date ||
        executionMarketData.calendar.normalizedResponseHash !== executionSession.calendar.normalizedResponseHash
      ) {
        issues.push({
          path: ['bindings', 'executionMarketData', 'calendar'],
          issue: 'intraday-momentum entry market-data session and calendar must match the execution session',
        })
      }
      const bindsCompleteUniverse =
        executionMarketData.symbols.length === executionMarketData.universe.length &&
        executionMarketData.symbols.every((symbol, index) => symbol === executionMarketData.universe[index])
      if (!bindsCompleteUniverse) {
        issues.push({
          path: ['bindings', 'executionMarketData', 'symbols'],
          issue: 'intraday-momentum entry must bind the complete execution universe',
        })
      }
      if (
        executionMarketData.snapshotId !== document.bindings.snapshotId ||
        executionMarketData.contentHash !== document.bindings.snapshotContentHash
      ) {
        issues.push({
          path: ['bindings', 'executionMarketData', 'snapshotId'],
          issue: 'intraday-momentum entry must match the outer decision snapshot identity and content hash',
        })
      }
    }
  }
  const targetSymbols = document.targetPlan.targets.map(({ symbol }) => symbol)
  if (usesLiquidationMarketData && executionMarketData !== undefined) {
    const bindsTargetSymbols =
      executionMarketData.symbols.length === targetSymbols.length &&
      executionMarketData.symbols.every((symbol, index) => symbol === targetSymbols[index])
    if (!bindsTargetSymbols) {
      issues.push({
        path: ['bindings', 'executionMarketData', 'symbols'],
        issue: 'liquidation market-data symbols must exactly match the ordered close targets',
      })
    }
  }
  if (reconciledPositionBinding !== undefined) {
    if (
      reconciledPositionBinding.reconciliationId !== document.bindings.reconciliationId ||
      reconciledPositionBinding.reconciliationHash !== document.bindings.reconciliationHash
    ) {
      issues.push({
        path: ['bindings', 'executionMarketData', 'reconciliationId'],
        issue: 'must match the outer decision reconciliation identity and content hash',
      })
    }
    const targets = document.targetPlan.targets
    const bindsTargetPositions =
      reconciledPositionBinding.positions.length === targets.length &&
      reconciledPositionBinding.positions.every((position, index) => {
        const target = targets[index]
        const normalizedMarketPrice = quantizeAlpacaLimitPriceMicros(
          BigInt(position.marketPriceMicros),
          BigInt(position.quantityMicros) < 0n ? 'UP' : 'DOWN',
        ).toString()
        return (
          target !== undefined &&
          position.symbol === target.symbol &&
          position.quantityMicros === target.currentQuantityMicros &&
          normalizedMarketPrice === target.referencePriceMicros
        )
      })
    if (!bindsTargetPositions) {
      issues.push({
        path: ['bindings', 'executionMarketData', 'positions'],
        issue: 'must match the exact ordered symbols, quantities, and reference marks in the target plan',
      })
    }
  }
  const targets = document.targetPlan.intentTargets
  const planned = document.targetPlan.status === TargetPlanStatus.Planned
  const riskBlocked = document.riskBlock !== undefined
  const riskCount = document.deltaRisk.length
  if (
    document.orderedIntentIds.length !== riskCount ||
    (planned && !riskBlocked && riskCount !== targets.length) ||
    (planned && riskBlocked && (riskCount < 1 || riskCount > targets.length)) ||
    (!planned && riskCount !== 0)
  ) {
    issues.push({
      path: ['orderedIntentIds'],
      issue: 'must align with the exact executable plan or cumulative risk-block prefix',
    })
  }
  if (
    (planned && riskBlocked && document.dispatchable) ||
    (planned && !riskBlocked && !document.dispatchable) ||
    (!planned && (!document.dispatchable || riskBlocked))
  ) {
    issues.push({
      path: ['dispatchable'],
      issue: 'must be false only for a planned execution decision with exact blocked risk evidence',
    })
  }
  if (new Set(document.orderedIntentIds).size !== document.orderedIntentIds.length) {
    issues.push({ path: ['orderedIntentIds'], issue: 'must not contain duplicate intent identities' })
  }
  for (const [index, target] of targets.entries()) {
    if (
      target.strategyName !== document.bindings.strategyName ||
      target.cycleId !== document.bindings.cycleId ||
      target.decisionHash !== document.bindings.strategyDecisionHash ||
      target.policyHash !== document.bindings.policyHash ||
      target.accountId !== document.bindings.accountId ||
      target.createdAt !== document.createdAt
    ) {
      issues.push({ path: ['targetPlan', 'intentTargets', index], issue: 'must match the execution decision bindings' })
    }
    const risk = document.deltaRisk[index]
    if (risk === undefined) continue
    const plan = {
      schemaVersion: legacyIntentPlanSchemaVersion,
      ...target,
      notionalLimitMicros: risk.notionalLimitMicros,
      ...(document.replanGenerationHash === undefined ? {} : { replanGenerationHash: document.replanGenerationHash }),
    } as const
    const identity = executionIntentIdForDecodedPlan(plan, document.bindings.authorityGenerationHash)
    if (Result.isFailure(identity) || document.orderedIntentIds[index] !== identity.success) {
      issues.push({ path: ['orderedIntentIds', index], issue: 'must bind the exact ordered target content' })
    }
    if (risk.evaluation.input.intentId !== document.orderedIntentIds[index]) {
      issues.push({ path: ['deltaRisk', index], issue: 'must bind the corresponding ordered intent identity' })
    }
    const notional = BigInt(risk.notionalLimitMicros)
    const previousRisk = document.deltaRisk[index - 1]
    const expectedAggregateBuyingPower =
      (previousRisk === undefined ? 0n : BigInt(previousRisk.evaluation.metrics.aggregateBuyingPowerMicros)) +
      (target.side === OrderSide.Buy ? notional : 0n)
    const expectedOutcome = riskBlocked && index === riskCount - 1 ? RiskOutcome.Blocked : RiskOutcome.Approved
    if (
      risk.evaluation.policyHash !== document.bindings.policyHash ||
      risk.evaluation.input.evaluatedAt !== document.createdAt ||
      risk.evaluation.decision.outcome !== expectedOutcome ||
      risk.evaluation.decision.decidedAt !== document.createdAt ||
      risk.evaluation.decision.expiresAt > document.expiresAt ||
      risk.evaluation.metrics.orderNotionalMicros !== risk.notionalLimitMicros ||
      BigInt(risk.evaluation.metrics.aggregateBuyingPowerMicros) !== expectedAggregateBuyingPower ||
      (previousRisk !== undefined &&
        BigInt(risk.evaluation.metrics.dailyTradedNotionalMicros) !==
          BigInt(previousRisk.evaluation.metrics.dailyTradedNotionalMicros) + notional)
    ) {
      issues.push({
        path: ['deltaRisk', index],
        issue: 'must contain complete cumulative execution risk evidence through the first blocked delta',
      })
    }
  }
  if (document.riskBlock !== undefined) {
    const blockedRisk = document.deltaRisk.at(-1)
    const blockedDecision = blockedRisk?.evaluation.decision
    const knownReasonCodes = Object.values(Reason)
    if (
      blockedDecision === undefined ||
      blockedDecision.outcome !== RiskOutcome.Blocked ||
      blockedDecision.intentId !== document.riskBlock.intentId ||
      blockedDecision.decisionId !== document.riskBlock.decisionId ||
      blockedDecision.reasonCodes.length !== document.riskBlock.reasonCodes.length ||
      blockedDecision.reasonCodes.some((reason, index) => reason !== document.riskBlock?.reasonCodes[index]) ||
      blockedDecision.reasonCodes.some((reason) => !knownReasonCodes.includes(reason as Reason)) ||
      blockedDecision.reasonCodes.some(isAuthorityNotGrantedReason)
    ) {
      issues.push({
        path: ['riskBlock'],
        issue: 'must bind the final blocked execution risk decision and its exact non-authority reasons',
      })
    }
  }
  return issues
}

const ExecutionDecisionDocumentSemanticSchema = Schema.Struct({
  ...ExecutionDecisionMaterialSchema.fields,
  contentHash: Sha256Schema,
}).check(Schema.makeFilter(executionMaterialIssues))

export const ExecutionDecisionDocumentSchema = ExecutionDecisionDocumentSemanticSchema.check(
  Schema.makeFilter((document) => {
    const { contentHash, ...material } = document
    const expectedHash = canonicalHashV1Result(material)
    return Result.isFailure(expectedHash) || expectedHash.success !== contentHash
      ? [{ path: ['contentHash'], issue: 'must match the canonical execution decision material' }]
      : []
  }),
)
export type ExecutionDecisionDocument = typeof ExecutionDecisionDocumentSchema.Type

export const CycleDecisionDocumentSchema = Schema.Union([
  ObserveShadowDecisionDocumentSchema,
  ExecutionDecisionDocumentSchema,
])
export type CycleDecisionDocument = typeof CycleDecisionDocumentSchema.Type

interface MakeShadowDecisionDocumentIssue {
  readonly operation: 'make'
  readonly reason: 'canonicalization' | 'contract'
}

interface DecodeShadowDecisionDocumentIssue {
  readonly operation: 'decode'
  readonly reason: 'contract'
}

type ShadowDecisionContractIssue = MakeShadowDecisionDocumentIssue | DecodeShadowDecisionDocumentIssue

interface ShadowDecisionContractFailureDetails {
  readonly message: string
  readonly cause?: unknown
}

export const ShadowDecisionContractFailure = Data.TaggedError('ShadowDecisionContractFailure')<
  ShadowDecisionContractIssue & ShadowDecisionContractFailureDetails
>
export type ShadowDecisionContractFailure = InstanceType<typeof ShadowDecisionContractFailure>

type ShadowDecisionContractReason<Operation extends ShadowDecisionContractIssue['operation']> = Extract<
  ShadowDecisionContractIssue,
  { readonly operation: Operation }
>['reason']

const makeDocumentFailure = (
  reason: ShadowDecisionContractReason<'make'>,
  message: string,
  cause?: unknown,
): ShadowDecisionContractFailure => new ShadowDecisionContractFailure({ operation: 'make', reason, message, cause })

const decodeDocumentFailure = (
  reason: ShadowDecisionContractReason<'decode'>,
  message: string,
  cause?: unknown,
): ShadowDecisionContractFailure => new ShadowDecisionContractFailure({ operation: 'decode', reason, message, cause })

const decodeDocumentResult = Schema.decodeUnknownResult(ObserveShadowDecisionDocumentSchema, strictParseOptions)
const decodeExecutionDocumentResult = Schema.decodeUnknownResult(ExecutionDecisionDocumentSchema, strictParseOptions)

export const makeObserveShadowDecisionDocument = (
  material: unknown,
): Result.Result<ObserveShadowDecisionDocument, ShadowDecisionContractFailure> => {
  if (typeof material !== 'object' || material === null || Array.isArray(material)) {
    return Result.fail(makeDocumentFailure('contract', 'shadow decision material must be an object'))
  }
  return Result.flatMap(
    Result.mapError(canonicalHashV1Result(material), (cause) =>
      makeDocumentFailure('canonicalization', 'shadow decision material is not canonicalizable', cause),
    ),
    (contentHash) =>
      Result.flatMap(
        Result.try({
          try: () => ({ ...material, contentHash }),
          catch: (cause) =>
            makeDocumentFailure('canonicalization', 'shadow decision material is not canonicalizable', cause),
        }),
        (candidate) =>
          Result.mapError(decodeDocumentResult(candidate), (cause) =>
            makeDocumentFailure('contract', 'shadow decision material failed its durable contract', cause),
          ),
      ),
  )
}

export const decodeObserveShadowDecisionDocument = (
  input: unknown,
): Result.Result<ObserveShadowDecisionDocument, ShadowDecisionContractFailure> =>
  Result.mapError(decodeDocumentResult(input), (cause) =>
    decodeDocumentFailure('contract', 'shadow decision document failed its durable contract', cause),
  )

export const makeExecutionDecisionDocument = (
  material: unknown,
): Result.Result<ExecutionDecisionDocument, ShadowDecisionContractFailure> => {
  if (typeof material !== 'object' || material === null || Array.isArray(material)) {
    return Result.fail(makeDocumentFailure('contract', 'execution decision material must be an object'))
  }
  return Result.flatMap(
    Result.mapError(canonicalHashV1Result(material), (cause) =>
      makeDocumentFailure('canonicalization', 'execution decision material is not canonicalizable', cause),
    ),
    (contentHash) =>
      Result.mapError(decodeExecutionDocumentResult({ ...material, contentHash }), (cause) =>
        makeDocumentFailure('contract', 'execution decision material failed its durable contract', cause),
      ),
  )
}

export const decodeExecutionDecisionDocument = (
  input: unknown,
): Result.Result<ExecutionDecisionDocument, ShadowDecisionContractFailure> =>
  Result.mapError(decodeExecutionDocumentResult(input), (cause) =>
    decodeDocumentFailure('contract', 'execution decision document failed its durable contract', cause),
  )
