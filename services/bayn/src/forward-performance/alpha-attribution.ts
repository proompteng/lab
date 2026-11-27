import { Result } from 'effect'

import type { AccountingTransaction } from '../accounting/schema'
import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import type { NativeAlphaDecisionEvidence } from './alpha-decisions'
import type {
  ForwardPerformanceEvidenceInput,
  ForwardPerformanceExecutionEvidence,
  ForwardPerformanceReceipt,
  ForwardPerformanceTransactionEvidence,
} from './model'
import type { PositionEpisodeEvidence } from './position-episodes'
import type { PositionOutcome } from './position-outcomes'

const schemaVersion = 'bayn.native-alpha-attribution.v1' as const

export enum NativeAlphaAttributionReason {
  CaptureUnavailable = 'ALPHA_CAPTURE_UNAVAILABLE',
  UnverifiedDecision = 'UNVERIFIED_ALPHA_DECISION',
  DecisionIdentity = 'DECISION_IDENTITY_GAP',
  DuplicateDecision = 'DUPLICATE_DECISION_IDENTITY',
  ExecutionOutsideScope = 'EXECUTION_OUTSIDE_FINANCIAL_SCOPE',
  MissingIntent = 'BOUND_INTENT_EVIDENCE_GAP',
  ExecutionIdentity = 'EXECUTION_IDENTITY_GAP',
  DuplicateExecution = 'DUPLICATE_EXECUTION_IDENTITY',
  TerminalOrder = 'TERMINAL_ORDER_EVIDENCE_GAP',
  FillBinding = 'CANONICAL_FILL_BINDING_GAP',
  DuplicateFill = 'DUPLICATE_FILL_IDENTITY',
  FillQuantity = 'TERMINAL_FILL_QUANTITY_MISMATCH',
  EpisodeEvidence = 'POSITION_EPISODE_EVIDENCE_GAP',
  EpisodeBinding = 'POSITION_EPISODE_BINDING_GAP',
  EpisodeOwner = 'EPISODE_ENTRY_OWNER_UNAVAILABLE',
  MixedEpisodeOwners = 'MIXED_EPISODE_ENTRY_OWNERS',
  FinancialScope = 'FINANCIAL_SCOPE_BINDING_GAP',
  CostConservation = 'COST_CONSERVATION_GAP',
}

export type NativeAlphaFillStatus = 'FULL' | 'PARTIAL' | 'ZERO' | 'UNKNOWN'
type Leg = NativeAlphaDecisionEvidence['targetPlan']['legs'][number]

export interface NativeAlphaLegAttribution extends Leg {
  readonly status: NativeAlphaFillStatus
  readonly reasonCodes: readonly NativeAlphaAttributionReason[]
  readonly persistedIntentObserved: boolean
  readonly brokerOrderObserved: boolean
  readonly filledQuantityAtoms: string | null
  readonly unfilledQuantityAtoms: string | null
  readonly entryFillGrossNotionalMicros: string | null
  readonly entryFillSignedNotionalMicros: string | null
}

interface CompletedEconomics {
  readonly status: 'CLOSED_FILLED_ENTRIES' | 'NO_FILLED_ENTRIES' | 'PARTIAL_COMPLETED_EPISODES' | 'UNAVAILABLE'
  readonly completedEpisodeCount: number
  readonly unresolvedEntryFillCount: number
  readonly knownCompletedGrossPnlMicros: string | null
  readonly knownCompletedDirectFillFeesMicros: string | null
  readonly knownCompletedNetAfterDirectFillFeesMicros: string | null
  /** Complete only for the observed, terminally reconciled entry fills of this basket/cohort. */
  readonly completeGrossPnlMicros: string | null
  readonly completeNetAfterDirectFillFeesMicros: string | null
  readonly exactBrokerNetPnlMicros: null
  readonly allInProfitMicros: null
}

type DecisionIdentity = Pick<
  NativeAlphaDecisionEvidence,
  | 'cycleId'
  | 'authorityGenerationHash'
  | 'decisionDocumentHash'
  | 'decisionHash'
  | 'decisionCreatedAt'
  | 'sessionDate'
  | 'phase'
  | 'reason'
  | 'strategyProtocolHash'
  | 'strategyBehaviorHash'
  | 'strategyParameterHash'
  | 'policySchemaVersion'
  | 'riskPolicyHash'
  | 'qualificationBuild'
  | 'activationBuild'
  | 'executingBuild'
  | 'cycleState'
  | 'terminalAt'
  | 'reconciledAt'
  | 'executionEvidenceInScope'
  | 'dispatchable'
  | 'selectedSymbols'
  | 'targetWeights'
>

export interface NativeAlphaBasketAttribution {
  readonly decision: DecisionIdentity
  readonly selectedSignals: readonly Pick<
    NativeAlphaDecisionEvidence['signals'][number],
    'symbol' | 'phase' | 'setup' | 'direction'
  >[]
  readonly targetPlanStatus: NativeAlphaDecisionEvidence['targetPlan']['status']
  readonly targetPlanReason: NativeAlphaDecisionEvidence['targetPlan']['reason']
  readonly selectedLegCount: number
  readonly fundedLegCount: number
  readonly boundIntentLegCount: number
  readonly persistedIntentLegCount: number
  readonly brokerObservedLegCount: number
  readonly filledLegCount: number | null
  readonly fundingStatus: 'NO_SELECTION' | 'UNFUNDED' | 'PARTIAL' | 'FULL'
  readonly executionStatus: NativeAlphaFillStatus | 'UNFUNDED' | 'NO_SELECTION'
  readonly reasonCodes: readonly NativeAlphaAttributionReason[]
  readonly legs: readonly NativeAlphaLegAttribution[]
  /** Entry executions only; these are neither marked exposure nor a holding-path neutrality measure. */
  readonly entryFillGrossNotionalMicros: string | null
  readonly entryFillSignedNotionalMicros: string | null
  readonly economics: CompletedEconomics
}

export interface NativeAlphaEngineAttribution {
  readonly phase: NativeAlphaDecisionEvidence['phase']
  readonly strategyProtocolHash: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly policySchemaVersion: NativeAlphaDecisionEvidence['policySchemaVersion']
  readonly decisionCount: number
  readonly selectedBasketCount: number
  readonly fundedBasketCount: number
  readonly fullBasketCount: number
  readonly partialBasketCount: number
  readonly zeroFillBasketCount: number
  readonly unknownExecutionBasketCount: number
  readonly economics: CompletedEconomics
}

export interface NativeAlphaAttribution {
  readonly schemaVersion: typeof schemaVersion
  readonly evidenceHash: string
  readonly status: 'MEASURED' | 'PARTIAL' | 'UNAVAILABLE' | 'NO_RECORDED_ALPHA_DECISIONS'
  readonly reasonCodes: readonly NativeAlphaAttributionReason[]
  readonly scope: {
    readonly decisions: 'COMMITTED_CYCLE_DECISIONS'
    readonly controllerNoCycleAbstentionsIncluded: false
    readonly pnl: 'RECONCILED_COMPLETED_POSITION_EPISODES'
    readonly entryImbalance: 'CANONICAL_ENTRY_FILL_NOTIONAL'
    readonly markedExposureMeasured: false
  }
  readonly unverifiedDecisionHashes: readonly string[]
  readonly baskets: readonly NativeAlphaBasketAttribution[]
  readonly engines: readonly NativeAlphaEngineAttribution[]
  readonly episodes: {
    readonly evidenceHash: string | null
    readonly completedCount: number | null
    readonly openCount: number | null
    readonly crossScopeCount: number | null
    readonly attributedCount: number
    readonly unassigned: readonly {
      readonly openingTransactionId: string
      readonly closingTransactionId: string
      readonly symbol: string
      readonly grossRealizedPnlMicros: string
      readonly reason: NativeAlphaAttributionReason
    }[]
  }
  readonly financialConservation: {
    readonly status: 'RECONCILED' | 'UNDETERMINED'
    readonly scopedGrossPnlMicros: string | null
    readonly attributedCompletedGrossPnlMicros: string | null
    readonly unattributedGrossPnlMicros: string | null
    readonly scopedDirectFillFeesMicros: string | null
    readonly attributedCompletedDirectFillFeesMicros: string | null
    readonly unattributedDirectFillFeesMicros: string | null
    readonly scopedBrokerExecutionFeesMicros: string | null
    /** Includes pooled fees and adjustments; no arbitrary per-engine allocation is implied. */
    readonly unallocatedBrokerCostsBeyondDirectFillFeesMicros: string | null
    readonly unallocatedOtherChargedCostsMicros: string | null
  }
  readonly perEngineExecutionShortfall: {
    readonly status: 'UNDETERMINED'
    readonly reason: 'NO_VERIFIED_ENGINE_REFERENCE_PRICE_ALLOCATION'
  }
  readonly benchmarkComparison: {
    readonly status: 'UNDETERMINED'
    readonly reason: 'NO_MATCHED_BENCHMARK_EVIDENCE_IN_FORWARD_INPUT'
  }
}

const unsigned = (value: string | null | undefined): bigint | null =>
  value !== null && value !== undefined && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null
const signed = (value: string | null | undefined): bigint | null =>
  value !== null && value !== undefined && /^(0|-?[1-9][0-9]*)$/.test(value) ? BigInt(value) : null
const orderedReasons = (reasons: Iterable<NativeAlphaAttributionReason>) => [...new Set(reasons)].sort()
const indexBy = <A>(values: readonly A[], key: (value: A) => string) => {
  const result = new Map<string, A[]>()
  for (const value of values) {
    const id = key(value)
    const group = result.get(id)
    if (group === undefined) result.set(id, [value])
    else group.push(value)
  }
  return result
}
const unique = <A>(index: ReadonlyMap<string, readonly A[]>, id: string): A | undefined => {
  const group = index.get(id)
  return group?.length === 1 ? group[0] : undefined
}
const sameSelectedTransaction = (selected: ForwardPerformanceTransactionEvidence, trade: AccountingTransaction) =>
  selected.transactionId === trade.transactionId &&
  selected.brokerEventId === trade.brokerEventId &&
  selected.intentId === trade.intentId &&
  selected.symbol === trade.symbol &&
  selected.side === trade.side &&
  selected.quantityAtoms === trade.quantityAtoms &&
  selected.priceAtoms === trade.priceAtoms &&
  selected.notionalMicros === trade.notionalMicros &&
  selected.feeMicros === trade.feeMicros &&
  selected.realizedPnlMicros === trade.realizedPnlMicros &&
  selected.occurredAt === trade.occurredAt

interface LegMeasurement {
  readonly output: NativeAlphaLegAttribution
  readonly entryTransactions: readonly AccountingTransaction[]
}
interface AttributionIndexes {
  readonly execution: ReadonlyMap<string, readonly ForwardPerformanceExecutionEvidence[]>
  readonly historyByEvent: ReadonlyMap<string, readonly AccountingTransaction[]>
  readonly historyById: ReadonlyMap<string, readonly AccountingTransaction[]>
  readonly historyByIntent: ReadonlyMap<string, readonly AccountingTransaction[]>
  readonly selected: ReadonlyMap<string, readonly ForwardPerformanceTransactionEvidence[]>
  readonly selectedByIntent: ReadonlyMap<string, readonly ForwardPerformanceTransactionEvidence[]>
  readonly fillEvents: ReadonlyMap<string, readonly unknown[]>
  readonly fillIds: ReadonlyMap<string, readonly unknown[]>
  readonly intentOwners: ReadonlyMap<string, readonly NativeAlphaDecisionEvidence[]>
}

const measureLeg = (
  decision: NativeAlphaDecisionEvidence,
  leg: Leg,
  indexes: AttributionIndexes,
  decisionReasons: readonly NativeAlphaAttributionReason[],
): LegMeasurement => {
  const reasons = new Set(decisionReasons)
  let persistedIntentObserved = false
  let brokerOrderObserved = false
  const unavailable = (): LegMeasurement => ({
    output: {
      ...leg,
      status: 'UNKNOWN',
      reasonCodes: orderedReasons(reasons),
      persistedIntentObserved,
      brokerOrderObserved,
      filledQuantityAtoms: null,
      unfilledQuantityAtoms: null,
      entryFillGrossNotionalMicros: null,
      entryFillSignedNotionalMicros: null,
    },
    entryTransactions: [],
  })
  if (!decision.executionEvidenceInScope) reasons.add(NativeAlphaAttributionReason.ExecutionOutsideScope)
  if (leg.intentId === null) reasons.add(NativeAlphaAttributionReason.MissingIntent)
  if (reasons.size > 0 || leg.intentId === null) return unavailable()
  const evidence = unique(indexes.execution, leg.intentId)
  if ((indexes.execution.get(leg.intentId)?.length ?? 0) > 1 || indexes.intentOwners.get(leg.intentId)?.length !== 1) {
    reasons.add(NativeAlphaAttributionReason.DuplicateExecution)
    return unavailable()
  }
  const planned = unsigned(leg.quantityAtoms)
  if (
    evidence === undefined ||
    planned === null ||
    planned === 0n ||
    evidence.cycleId !== decision.cycleId ||
    evidence.accountId !== decision.accountId ||
    evidence.decisionDocumentHash !== decision.decisionDocumentHash ||
    evidence.decisionHash !== decision.decisionHash ||
    evidence.decisionCreatedAt !== decision.decisionCreatedAt ||
    evidence.symbol !== leg.symbol ||
    evidence.side !== leg.side ||
    evidence.plannedQuantityAtoms !== leg.quantityAtoms ||
    (leg.referencePriceMicros !== null && evidence.referencePriceMicros !== leg.referencePriceMicros)
  ) {
    reasons.add(NativeAlphaAttributionReason.ExecutionIdentity)
    return unavailable()
  }
  const intent = evidence.intent
  if (
    intent === undefined ||
    intent.intentId !== leg.intentId ||
    intent.accountId !== decision.accountId ||
    intent.cycleId !== decision.cycleId ||
    intent.decisionHash !== decision.decisionHash ||
    intent.symbol !== leg.symbol ||
    intent.side !== leg.side ||
    intent.quantityAtoms !== leg.quantityAtoms ||
    intent.createdAt !== decision.decisionCreatedAt
  ) {
    reasons.add(NativeAlphaAttributionReason.MissingIntent)
    return unavailable()
  }
  persistedIntentObserved = true
  const order = evidence.terminalOrder
  if (
    order === undefined ||
    order.intentId !== leg.intentId ||
    order.accountId !== decision.accountId ||
    order.symbol !== leg.symbol ||
    order.side !== leg.side ||
    order.clientOrderId !== intent.clientOrderId ||
    order.quantityAtoms !== leg.quantityAtoms ||
    order.notionalMicros !== undefined ||
    order.occurredAt < decision.decisionCreatedAt ||
    order.observedAt < order.occurredAt ||
    order.observedAt > decision.reconciledAt
  ) {
    reasons.add(NativeAlphaAttributionReason.TerminalOrder)
    return unavailable()
  }
  brokerOrderObserved = true
  const reported = unsigned(order.filledQuantityAtoms)
  if (
    !['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(order.status) ||
    intent.terminalOutcome !== order.status ||
    reported === null ||
    reported > planned
  ) {
    reasons.add(NativeAlphaAttributionReason.TerminalOrder)
    return unavailable()
  }
  const entryTransactions: AccountingTransaction[] = []
  let quantity = 0n
  let notional = 0n
  for (const fill of evidence.fills) {
    if (
      indexes.fillEvents.get(fill.brokerEventId)?.length !== 1 ||
      indexes.fillIds.get(JSON.stringify([fill.accountId, fill.fillId]))?.length !== 1
    ) {
      reasons.add(NativeAlphaAttributionReason.DuplicateFill)
      continue
    }
    const trade = unique(indexes.historyByEvent, fill.brokerEventId)
    const selected = trade === undefined ? undefined : unique(indexes.selected, trade.transactionId)
    if (
      trade === undefined ||
      selected === undefined ||
      unique(indexes.historyById, trade.transactionId) !== trade ||
      !sameSelectedTransaction(selected, trade) ||
      selected.cycleId !== decision.cycleId ||
      fill.intentId !== leg.intentId ||
      fill.accountId !== decision.accountId ||
      fill.symbol !== leg.symbol ||
      fill.side !== leg.side ||
      fill.brokerOrderId !== order.brokerOrderId ||
      fill.clientOrderId !== order.clientOrderId ||
      trade.accountId !== decision.accountId ||
      trade.intentId !== fill.intentId ||
      trade.symbol !== fill.symbol ||
      trade.side !== fill.side ||
      trade.quantityAtoms !== fill.quantityAtoms ||
      trade.priceAtoms !== fill.priceAtoms ||
      trade.feeMicros !== fill.feeMicros ||
      trade.occurredAt !== fill.occurredAt ||
      fill.occurredAt < decision.decisionCreatedAt ||
      fill.occurredAt > order.occurredAt ||
      fill.observedAt < fill.occurredAt ||
      fill.observedAt > decision.reconciledAt ||
      unsigned(trade.quantityAtoms) === null ||
      unsigned(trade.quantityAtoms) === 0n ||
      unsigned(trade.priceAtoms) === null ||
      unsigned(trade.priceAtoms) === 0n ||
      unsigned(trade.notionalMicros) === null ||
      unsigned(trade.feeMicros) === null
    ) {
      reasons.add(NativeAlphaAttributionReason.FillBinding)
      continue
    }
    quantity += BigInt(trade.quantityAtoms)
    notional += BigInt(trade.notionalMicros)
    entryTransactions.push(trade)
  }
  // Both directions are required: an omitted canonical entry fill cannot become a terminal zero.
  // Opposite-side native protection fills close inventory and are deliberately outside the entry basket.
  const canonicalEntries = (indexes.historyByIntent.get(leg.intentId) ?? []).filter((trade) => trade.side === leg.side)
  const selectedEntries = (indexes.selectedByIntent.get(leg.intentId) ?? []).filter((trade) => trade.side === leg.side)
  const entryIds = new Set(entryTransactions.map((trade) => trade.transactionId))
  if (
    canonicalEntries.length !== entryTransactions.length ||
    selectedEntries.length !== entryTransactions.length ||
    canonicalEntries.some((trade) => !entryIds.has(trade.transactionId)) ||
    selectedEntries.some((trade) => !entryIds.has(trade.transactionId))
  )
    reasons.add(NativeAlphaAttributionReason.FillBinding)
  if (quantity !== reported || quantity > planned || (order.status === 'FILLED' && quantity !== planned))
    reasons.add(NativeAlphaAttributionReason.FillQuantity)
  if (reasons.size > 0) return unavailable()
  return {
    output: {
      ...leg,
      status: quantity === 0n ? 'ZERO' : quantity === planned ? 'FULL' : 'PARTIAL',
      reasonCodes: [],
      persistedIntentObserved,
      brokerOrderObserved,
      filledQuantityAtoms: quantity.toString(),
      unfilledQuantityAtoms: (planned - quantity).toString(),
      entryFillGrossNotionalMicros: notional.toString(),
      entryFillSignedNotionalMicros: (leg.side === 'BUY' ? notional : -notional).toString(),
    },
    entryTransactions,
  }
}

const publicDecision = (decision: NativeAlphaDecisionEvidence): DecisionIdentity => {
  const { accountId: _accountId, signals: _signals, targetPlan: _targetPlan, ...identity } = decision
  return identity
}
const engineKey = (decision: DecisionIdentity) =>
  JSON.stringify([
    decision.phase,
    decision.strategyProtocolHash,
    decision.strategyBehaviorHash,
    decision.strategyParameterHash,
    decision.policySchemaVersion,
  ])

interface BasketWork {
  readonly decision: NativeAlphaDecisionEvidence
  readonly legs: readonly LegMeasurement[]
  readonly reasons: readonly NativeAlphaAttributionReason[]
  readonly completed: PositionOutcome[]
  readonly completedTrades: AccountingTransaction[]
  readonly resolvedEntryIds: Set<string>
}

const basketEconomics = (work: BasketWork, episodesMeasured: boolean): CompletedEconomics => {
  const entryTrades = work.legs.flatMap((leg) => leg.entryTransactions)
  const unresolved = entryTrades.filter((trade) => !work.resolvedEntryIds.has(trade.transactionId)).length
  const knownGross = episodesMeasured
    ? work.completed.reduce((sum, episode) => sum + BigInt(episode.grossRealizedPnlMicros), 0n)
    : null
  const knownFees = episodesMeasured
    ? work.completedTrades.reduce((sum, trade) => sum + BigInt(trade.feeMicros), 0n)
    : null
  const executionKnown =
    work.reasons.length === 0 && work.legs.length > 0 && work.legs.every((leg) => leg.output.status !== 'UNKNOWN')
  const complete = episodesMeasured && executionKnown && unresolved === 0
  return {
    status: complete
      ? entryTrades.length === 0
        ? 'NO_FILLED_ENTRIES'
        : 'CLOSED_FILLED_ENTRIES'
      : work.completed.length > 0
        ? 'PARTIAL_COMPLETED_EPISODES'
        : 'UNAVAILABLE',
    completedEpisodeCount: work.completed.length,
    unresolvedEntryFillCount: unresolved,
    knownCompletedGrossPnlMicros: knownGross?.toString() ?? null,
    knownCompletedDirectFillFeesMicros: knownFees?.toString() ?? null,
    knownCompletedNetAfterDirectFillFeesMicros:
      knownGross === null || knownFees === null ? null : (knownGross - knownFees).toString(),
    completeGrossPnlMicros: complete ? (knownGross?.toString() ?? null) : null,
    completeNetAfterDirectFillFeesMicros:
      complete && knownGross !== null && knownFees !== null ? (knownGross - knownFees).toString() : null,
    exactBrokerNetPnlMicros: null,
    allInProfitMicros: null,
  }
}

const summarizeBasket = (work: BasketWork, episodesMeasured: boolean): NativeAlphaBasketAttribution => {
  const { decision } = work
  const legs = work.legs.map((leg) => leg.output)
  const reasons = orderedReasons([...work.reasons, ...legs.flatMap((leg) => leg.reasonCodes)])
  const known = reasons.length === 0 && legs.length > 0 && legs.every((leg) => leg.status !== 'UNKNOWN')
  const selected = decision.selectedSymbols.length
  const funded = legs.length
  const fullFunding =
    selected > 0 &&
    funded === selected &&
    decision.selectedSymbols.every((symbol) => legs.filter((leg) => leg.symbol === symbol).length === 1)
  const gross = known ? legs.reduce((sum, leg) => sum + BigInt(leg.entryFillGrossNotionalMicros ?? '0'), 0n) : null
  const net = known ? legs.reduce((sum, leg) => sum + BigInt(leg.entryFillSignedNotionalMicros ?? '0'), 0n) : null
  return {
    decision: publicDecision(decision),
    selectedSignals: decision.signals
      .filter((signal) => decision.selectedSymbols.includes(signal.symbol))
      .map(({ symbol, phase, setup, direction }) => ({ symbol, phase, setup, direction })),
    targetPlanStatus: decision.targetPlan.status,
    targetPlanReason: decision.targetPlan.reason,
    selectedLegCount: selected,
    fundedLegCount: funded,
    boundIntentLegCount: legs.filter((leg) => leg.intentId !== null).length,
    persistedIntentLegCount: legs.filter((leg) => leg.persistedIntentObserved).length,
    brokerObservedLegCount: legs.filter((leg) => leg.brokerOrderObserved).length,
    filledLegCount: known ? legs.filter((leg) => leg.status === 'FULL' || leg.status === 'PARTIAL').length : null,
    fundingStatus: selected === 0 ? 'NO_SELECTION' : funded === 0 ? 'UNFUNDED' : fullFunding ? 'FULL' : 'PARTIAL',
    executionStatus:
      selected === 0
        ? 'NO_SELECTION'
        : funded === 0
          ? 'UNFUNDED'
          : !known
            ? 'UNKNOWN'
            : legs.every((leg) => leg.status === 'ZERO')
              ? 'ZERO'
              : fullFunding && legs.every((leg) => leg.status === 'FULL')
                ? 'FULL'
                : 'PARTIAL',
    reasonCodes: reasons,
    legs,
    entryFillGrossNotionalMicros: gross?.toString() ?? null,
    entryFillSignedNotionalMicros: net?.toString() ?? null,
    economics: basketEconomics(work, episodesMeasured),
  }
}

const sumNullable = (values: readonly (string | null)[]): string | null =>
  values.some((value) => value === null)
    ? null
    : values.reduce<bigint>((sum, value) => sum + BigInt(value ?? '0'), 0n).toString()

const summarizeEngine = (
  baskets: readonly NativeAlphaBasketAttribution[],
  decisionCohortComplete: boolean,
): NativeAlphaEngineAttribution | null => {
  const first = baskets[0]
  if (first === undefined) return null
  const selected = baskets.filter((basket) => basket.selectedLegCount > 0)
  const economics = selected.map((basket) => basket.economics)
  const completeGross =
    !decisionCohortComplete || selected.length === 0
      ? null
      : sumNullable(economics.map((value) => value.completeGrossPnlMicros))
  const completeNet =
    !decisionCohortComplete || selected.length === 0
      ? null
      : sumNullable(economics.map((value) => value.completeNetAfterDirectFillFeesMicros))
  const completedCount = economics.reduce((sum, value) => sum + value.completedEpisodeCount, 0)
  return {
    phase: first.decision.phase,
    strategyProtocolHash: first.decision.strategyProtocolHash,
    strategyBehaviorHash: first.decision.strategyBehaviorHash,
    strategyParameterHash: first.decision.strategyParameterHash,
    policySchemaVersion: first.decision.policySchemaVersion,
    decisionCount: baskets.length,
    selectedBasketCount: selected.length,
    fundedBasketCount: baskets.filter((basket) => basket.fundedLegCount > 0).length,
    fullBasketCount: baskets.filter((basket) => basket.executionStatus === 'FULL').length,
    partialBasketCount: baskets.filter((basket) => basket.executionStatus === 'PARTIAL').length,
    zeroFillBasketCount: baskets.filter((basket) => basket.executionStatus === 'ZERO').length,
    unknownExecutionBasketCount: baskets.filter((basket) => basket.executionStatus === 'UNKNOWN').length,
    economics: {
      status:
        completeGross !== null
          ? economics.every((value) => value.status === 'NO_FILLED_ENTRIES')
            ? 'NO_FILLED_ENTRIES'
            : 'CLOSED_FILLED_ENTRIES'
          : completedCount > 0
            ? 'PARTIAL_COMPLETED_EPISODES'
            : 'UNAVAILABLE',
      completedEpisodeCount: completedCount,
      unresolvedEntryFillCount: economics.reduce((sum, value) => sum + value.unresolvedEntryFillCount, 0),
      knownCompletedGrossPnlMicros:
        selected.length === 0 ? null : sumNullable(economics.map((value) => value.knownCompletedGrossPnlMicros)),
      knownCompletedDirectFillFeesMicros:
        selected.length === 0 ? null : sumNullable(economics.map((value) => value.knownCompletedDirectFillFeesMicros)),
      knownCompletedNetAfterDirectFillFeesMicros:
        selected.length === 0
          ? null
          : sumNullable(economics.map((value) => value.knownCompletedNetAfterDirectFillFeesMicros)),
      completeGrossPnlMicros: completeGross,
      completeNetAfterDirectFillFeesMicros: completeNet,
      exactBrokerNetPnlMicros: null,
      allInProfitMicros: null,
    },
  }
}

/** Diagnostic attribution only. It neither changes the financial receipt nor grants trading authority. */
export const measureNativeAlphaAttribution = (
  input: ForwardPerformanceEvidenceInput,
  receipt: ForwardPerformanceReceipt,
  episodes: PositionEpisodeEvidence,
): Result.Result<NativeAlphaAttribution, CanonicalHashFailure> =>
  Result.gen(function* () {
    const decisions = [...(input.alphaDecisions ?? [])].sort(
      (a, b) => a.decisionDocumentHash.localeCompare(b.decisionDocumentHash) || a.cycleId.localeCompare(b.cycleId),
    )
    const unverified = [...new Set(input.unverifiedAlphaDecisionHashes ?? [])].sort()
    const reasons = new Set<NativeAlphaAttributionReason>()
    if (input.alphaDecisions === undefined) reasons.add(NativeAlphaAttributionReason.CaptureUnavailable)
    if (unverified.length > 0) reasons.add(NativeAlphaAttributionReason.UnverifiedDecision)
    const measuredEpisodes = episodes.status === 'MEASURED'
    const base = {
      schemaVersion,
      scope: {
        decisions: 'COMMITTED_CYCLE_DECISIONS' as const,
        controllerNoCycleAbstentionsIncluded: false as const,
        pnl: 'RECONCILED_COMPLETED_POSITION_EPISODES' as const,
        entryImbalance: 'CANONICAL_ENTRY_FILL_NOTIONAL' as const,
        markedExposureMeasured: false as const,
      },
      unverifiedDecisionHashes: unverified,
      perEngineExecutionShortfall: {
        status: 'UNDETERMINED' as const,
        reason: 'NO_VERIFIED_ENGINE_REFERENCE_PRICE_ALLOCATION' as const,
      },
      benchmarkComparison: {
        status: 'UNDETERMINED' as const,
        reason: 'NO_MATCHED_BENCHMARK_EVIDENCE_IN_FORWARD_INPUT' as const,
      },
    }
    const episodeCounts = {
      evidenceHash: episodes.evidenceHash,
      completedCount: measuredEpisodes ? episodes.completedCount : null,
      openCount: measuredEpisodes ? episodes.openCount : null,
      crossScopeCount: measuredEpisodes ? episodes.crossScopeCount : null,
    }
    const noAttribution = {
      status: 'UNDETERMINED' as const,
      scopedGrossPnlMicros: receipt.totals.grossRealizedPnlMicros,
      attributedCompletedGrossPnlMicros: null,
      unattributedGrossPnlMicros: null,
      scopedDirectFillFeesMicros: null,
      attributedCompletedDirectFillFeesMicros: null,
      unattributedDirectFillFeesMicros: null,
      scopedBrokerExecutionFeesMicros: receipt.totals.brokerExecutionFeesMicros,
      unallocatedBrokerCostsBeyondDirectFillFeesMicros: null,
      unallocatedOtherChargedCostsMicros: receipt.totals.otherChargedCostsMicros,
    }
    // Older inputs must not incur another executionEvidence getter/verification pass.
    if (decisions.length === 0) {
      const material = {
        ...base,
        status:
          input.alphaDecisions === undefined || unverified.length > 0
            ? ('UNAVAILABLE' as const)
            : ('NO_RECORDED_ALPHA_DECISIONS' as const),
        reasonCodes: orderedReasons(reasons),
        baskets: [],
        engines: [],
        episodes: { ...episodeCounts, attributedCount: 0, unassigned: [] },
        financialConservation: noAttribution,
      }
      const evidenceHash = yield* canonicalHashV1Result({
        material,
        receiptHash: receipt.receiptHash,
        account: input.account,
      })
      return { ...material, evidenceHash }
    }

    const execution = [...(input.executionEvidence ?? [])].sort((a, b) => a.intentId.localeCompare(b.intentId))
    const history = [...(input.accountTransactions ?? [])].sort(
      (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.transactionId.localeCompare(b.transactionId),
    )
    const allFills = execution.flatMap((item) => [...item.fills, ...(item.nativeProtection?.fills ?? [])])
    const indexes: AttributionIndexes = {
      execution: indexBy(execution, (item) => item.intentId),
      historyByEvent: indexBy(history, (item) => item.brokerEventId),
      historyById: indexBy(history, (item) => item.transactionId),
      historyByIntent: indexBy(history, (item) => item.intentId ?? ''),
      selected: indexBy(input.transactions, (item) => item.transactionId),
      selectedByIntent: indexBy(input.transactions, (item) => item.intentId ?? ''),
      fillEvents: indexBy(allFills, (item) => item.brokerEventId),
      fillIds: indexBy(allFills, (item) => JSON.stringify([item.accountId, item.fillId])),
      intentOwners: indexBy(
        decisions.flatMap((decision) =>
          decision.targetPlan.legs
            .filter((leg) => leg.intentId !== null)
            .map((leg) => ({ decision, intentId: leg.intentId })),
        ),
        (item) => item.intentId ?? '',
      )
        .entries()
        .reduce(
          (map, [key, values]) =>
            map.set(
              key,
              values.map((value) => value.decision),
            ),
          new Map<string, NativeAlphaDecisionEvidence[]>(),
        ),
    }
    const byCycle = indexBy(decisions, (decision) => decision.cycleId)
    const byDocument = indexBy(decisions, (decision) => decision.decisionDocumentHash)
    const works: BasketWork[] = decisions.map((decision) => {
      const decisionReasons: NativeAlphaAttributionReason[] = []
      if (byCycle.get(decision.cycleId)?.length !== 1 || byDocument.get(decision.decisionDocumentHash)?.length !== 1)
        decisionReasons.push(NativeAlphaAttributionReason.DuplicateDecision)
      if (
        decision.accountId !== input.account.accountId ||
        new Set(decision.selectedSymbols).size !== decision.selectedSymbols.length ||
        decision.targetPlan.legs.some(
          (leg) =>
            !decision.selectedSymbols.includes(leg.symbol) ||
            !decision.signals.some(
              (signal) =>
                signal.symbol === leg.symbol &&
                signal.phase === decision.phase &&
                signal.direction === (leg.side === 'BUY' ? 'LONG' : 'SHORT') &&
                !signal.vetoed,
            ),
        )
      )
        decisionReasons.push(NativeAlphaAttributionReason.DecisionIdentity)
      if (
        unverified.includes(decision.decisionDocumentHash) ||
        (input.unverifiedDecisionHashes ?? []).includes(decision.decisionDocumentHash)
      )
        decisionReasons.push(NativeAlphaAttributionReason.UnverifiedDecision)
      return {
        decision,
        reasons: decisionReasons,
        legs: decision.targetPlan.legs.map((leg) => measureLeg(decision, leg, indexes, decisionReasons)),
        completed: [],
        completedTrades: [],
        resolvedEntryIds: new Set<string>(),
      }
    })
    const transactionOwners = indexBy(
      works.flatMap((work) => work.legs.flatMap((leg) => leg.entryTransactions.map((trade) => ({ work, trade })))),
      (item) => item.trade.transactionId,
    )
    const bySymbol = indexBy(history, (trade) => trade.symbol)
    const unassigned: NativeAlphaAttribution['episodes']['unassigned'][number][] = []
    const usedTransactions = new Set<string>()
    if (!measuredEpisodes) reasons.add(NativeAlphaAttributionReason.EpisodeEvidence)
    for (const episode of measuredEpisodes ? episodes.completed : []) {
      const symbolHistory = bySymbol.get(episode.symbol) ?? []
      const firstIndex = symbolHistory.findIndex((trade) => trade.transactionId === episode.openingTransactionId)
      const lastIndex = symbolHistory.findIndex((trade) => trade.transactionId === episode.closingTransactionId)
      const trades = firstIndex < 0 || lastIndex < firstIndex ? [] : symbolHistory.slice(firstIndex, lastIndex + 1)
      const first = trades[0]
      let failure: NativeAlphaAttributionReason | null = null
      if (
        first === undefined ||
        trades.some((trade) => {
          const selected = unique(indexes.selected, trade.transactionId)
          return (
            usedTransactions.has(trade.transactionId) ||
            trade.accountId !== input.account.accountId ||
            unique(indexes.historyById, trade.transactionId) !== trade ||
            unique(indexes.historyByEvent, trade.brokerEventId) !== trade ||
            selected === undefined ||
            !sameSelectedTransaction(selected, trade) ||
            signed(trade.realizedPnlMicros) === null ||
            unsigned(trade.feeMicros) === null
          )
        }) ||
        (trades.length > 0 &&
          trades.reduce((sum, trade) => sum + (signed(trade.realizedPnlMicros) ?? 0n), 0n).toString() !==
            episode.grossRealizedPnlMicros)
      )
        failure = NativeAlphaAttributionReason.EpisodeBinding
      const openingTrades = first === undefined ? [] : trades.filter((trade) => trade.side === first.side)
      const owners = openingTrades.map((trade) => unique(transactionOwners, trade.transactionId)?.work)
      if (failure === null && owners.some((owner) => owner === undefined))
        failure = NativeAlphaAttributionReason.EpisodeOwner
      const ownerSet = new Set(owners)
      if (failure === null && ownerSet.size !== 1) failure = NativeAlphaAttributionReason.MixedEpisodeOwners
      const owner = owners[0]
      if (failure !== null || owner === undefined) {
        unassigned.push({
          openingTransactionId: episode.openingTransactionId,
          closingTransactionId: episode.closingTransactionId,
          symbol: episode.symbol,
          grossRealizedPnlMicros: episode.grossRealizedPnlMicros,
          reason: failure ?? NativeAlphaAttributionReason.EpisodeOwner,
        })
        reasons.add(failure ?? NativeAlphaAttributionReason.EpisodeOwner)
        continue
      }
      owner.completed.push(episode)
      owner.completedTrades.push(...trades)
      for (const trade of trades) usedTransactions.add(trade.transactionId)
      for (const trade of openingTrades) owner.resolvedEntryIds.add(trade.transactionId)
    }
    const baskets = works.map((work) => summarizeBasket(work, measuredEpisodes))
    for (const basket of baskets) for (const reason of basket.reasonCodes) reasons.add(reason)
    const engines = [...indexBy(baskets, (basket) => engineKey(basket.decision)).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, values]) => {
        const engine = summarizeEngine(values, unverified.length === 0)
        return engine === null ? [] : [engine]
      })
    const attributedGross = measuredEpisodes
      ? works.reduce(
          (sum, work) =>
            sum + work.completed.reduce((subtotal, episode) => subtotal + BigInt(episode.grossRealizedPnlMicros), 0n),
          0n,
        )
      : null
    const attributedFees = measuredEpisodes
      ? works.reduce(
          (sum, work) => sum + work.completedTrades.reduce((subtotal, trade) => subtotal + BigInt(trade.feeMicros), 0n),
          0n,
        )
      : null
    let directFees: bigint | null = 0n
    let selectedGross = 0n
    for (const selected of input.transactions) {
      const trade = unique(indexes.historyById, selected.transactionId)
      if (
        trade === undefined ||
        indexes.selected.get(selected.transactionId)?.length !== 1 ||
        trade.accountId !== input.account.accountId ||
        !sameSelectedTransaction(selected, trade) ||
        unsigned(trade.feeMicros) === null ||
        signed(trade.realizedPnlMicros) === null
      ) {
        directFees = null
        break
      }
      directFees += BigInt(trade.feeMicros)
      selectedGross += BigInt(trade.realizedPnlMicros)
    }
    const scopedGross = signed(receipt.totals.grossRealizedPnlMicros)
    const scopedFees = unsigned(receipt.totals.brokerExecutionFeesMicros)
    const scopeExact =
      directFees !== null &&
      scopedGross !== null &&
      selectedGross === scopedGross &&
      receipt.bindings.account.accountReferenceHash === input.account.accountReferenceHash &&
      input.accountingReceiptsExact &&
      input.ledgerExact &&
      input.missingLedgerAccountCount === 0 &&
      input.reconciliation?.performanceExact === true
    if (!scopeExact) reasons.add(NativeAlphaAttributionReason.FinancialScope)
    const directCostsConserve =
      scopeExact && directFees !== null && attributedFees !== null && directFees >= attributedFees
    const costsConserve = directCostsConserve && scopedFees !== null && directFees !== null && scopedFees >= directFees
    if (
      scopedFees !== null &&
      directFees !== null &&
      (scopedFees < directFees || (attributedFees !== null && attributedFees > directFees))
    )
      reasons.add(NativeAlphaAttributionReason.CostConservation)
    const material = {
      ...base,
      status:
        reasons.size > 0 ||
        baskets.some(
          (basket) =>
            basket.economics.status === 'PARTIAL_COMPLETED_EPISODES' ||
            (basket.fundedLegCount > 0 && basket.economics.status === 'UNAVAILABLE'),
        )
          ? ('PARTIAL' as const)
          : ('MEASURED' as const),
      reasonCodes: orderedReasons(reasons),
      baskets,
      engines,
      episodes: {
        ...episodeCounts,
        attributedCount: works.reduce((sum, work) => sum + work.completed.length, 0),
        unassigned,
      },
      financialConservation: {
        status: costsConserve && attributedGross !== null ? ('RECONCILED' as const) : ('UNDETERMINED' as const),
        scopedGrossPnlMicros: receipt.totals.grossRealizedPnlMicros,
        attributedCompletedGrossPnlMicros: attributedGross?.toString() ?? null,
        unattributedGrossPnlMicros:
          scopeExact && scopedGross !== null && attributedGross !== null
            ? (scopedGross - attributedGross).toString()
            : null,
        scopedDirectFillFeesMicros: scopeExact ? (directFees?.toString() ?? null) : null,
        attributedCompletedDirectFillFeesMicros: attributedFees?.toString() ?? null,
        unattributedDirectFillFeesMicros:
          directCostsConserve && directFees !== null && attributedFees !== null
            ? (directFees - attributedFees).toString()
            : null,
        scopedBrokerExecutionFeesMicros: receipt.totals.brokerExecutionFeesMicros,
        unallocatedBrokerCostsBeyondDirectFillFeesMicros:
          costsConserve && scopedFees !== null && directFees !== null ? (scopedFees - directFees).toString() : null,
        unallocatedOtherChargedCostsMicros: receipt.totals.otherChargedCostsMicros,
      },
    }
    const evidenceHash = yield* canonicalHashV1Result({
      material,
      receiptHash: receipt.receiptHash,
      account: input.account,
      decisions,
      execution,
      history,
      selectedTransactions: [...input.transactions].sort((a, b) => a.transactionId.localeCompare(b.transactionId)),
    })
    return { ...material, evidenceHash }
  })
