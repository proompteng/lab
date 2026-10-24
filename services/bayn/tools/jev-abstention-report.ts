import { readFileSync } from 'node:fs'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../src/hash'
import { decideJevEntry, JevEntryTargetSchema } from '../src/jev/decision'
import { JevCandidatePlanStatus, JevCandidateResultStatus } from '../src/jev/batch'
import { JevOutcome } from '../src/jev/evidence'
import { JevFundedExitPlanSchema } from '../src/jev/strategy-exit-plan'
import { PositiveMicrosSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../src/schemas'
import { jevProtectiveStopCrossed } from '../src/jev/exit'
import { jevMarketForSymbol } from '../src/jev/markets'
import { replayQuoteRejection } from '../src/intraday-replay/broker-execution-evidence'
import { replayInstrument, ReplayInstrumentsSchema } from '../src/intraday-replay/execution-core'
import type { IntradayQuote } from '../src/market-data/intraday/model'
import type { ObservedMarketValue } from '../src/market-data/streaming/projection'
import { StrategySnapshotManifestSchema } from '../src/market-data/streaming/manifest-schema'
import { NativeArrivalEpochSchema } from '../src/market-data/streaming/native-arrival'
import { priceNumberToMicros } from '../src/strategy/execution-model/fixed-point'
import { auditNativeArrivalCoverage, nativeCoverageMaximumInputBytes } from './native-arrival-coverage'
import { historicalFeeProvenance, hypotheticalCryptoFeeSensitivity } from './jev-fee-sensitivity'
import { AccountingTransactionSchema } from '../src/accounting/schema'
import { PositionOutcomeSchema } from '../src/forward-performance/position-outcomes'
import { instrumentMarket, MarketKind } from '../src/instruments'

const JoinedCycle = Schema.Struct({
  cycleId: Sha256Schema,
  state: Schema.Literals(['COMPLETED', 'NO_TRADE', 'BLOCKED', 'ACTIVE']),
  sourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  authorityGenerationHash: Sha256Schema,
  decisionDocument: Schema.NullOr(Schema.Unknown),
  strategyDecisionHash: Schema.NullOr(Sha256Schema),
  transactions: Schema.Array(
    Schema.Struct({
      cycleId: Sha256Schema,
      strategyDecisionHash: Sha256Schema,
      transaction: AccountingTransactionSchema,
    }),
  ),
  outcome: Schema.NullOr(Schema.Struct({ contentHash: Sha256Schema, value: PositionOutcomeSchema })),
  exitObservation: Schema.NullOr(
    Schema.Struct({
      cycleId: Sha256Schema,
      openingTransactionId: Sha256Schema,
      sourceHash: Sha256Schema,
      reason: Schema.Literals(['PROTECTIVE_STOP', 'PROFIT_TARGET', 'MAXIMUM_HOLD', 'RECOVERY', 'OTHER']),
    }),
  ),
})

/** Consistency join of private exports, not a replacement for receipt/ledger verification. */
export const reportJevRealizedEvidence = (input: unknown) => {
  const bundle = Result.getOrThrow(
    Schema.decodeUnknownResult(
      Schema.Struct({
        schemaVersion: Schema.Literal('bayn.jev-realized-evidence-input.v1'),
        cycles: Schema.Array(JoinedCycle),
      }),
      strictParseOptions,
    )(input),
  )
  const cycleIds = new Set<string>()
  const transactionIds = new Set<string>()
  const rows = bundle.cycles.map((row) => {
    if (cycleIds.has(row.cycleId)) throw new Error('Duplicate cycle in denominator')
    cycleIds.add(row.cycleId)
    const document =
      row.decisionDocument === null
        ? null
        : Result.getOrThrow(Schema.decodeUnknownResult(Document)(row.decisionDocument))
    const decision = document === null ? null : reportJevAbstention(row.decisionDocument)
    if ((document === null) !== (row.strategyDecisionHash === null))
      throw new Error('Decision/hash availability differs')
    if (
      document !== null &&
      (document.bindings.cycleId !== row.cycleId ||
        document.strategyDecision.evidence.observation.authorityGenerationHash !== row.authorityGenerationHash ||
        Result.getOrThrow(canonicalHashV1Result(document.strategyDecision)) !== row.strategyDecisionHash)
    )
      throw new Error('Foreign cycle or strategy decision hash')
    const trades = row.transactions
      .map((link) => {
        const trade = link.transaction
        if (
          document === null ||
          link.cycleId !== row.cycleId ||
          link.strategyDecisionHash !== row.strategyDecisionHash ||
          trade.intentId === undefined ||
          trade.accountId !== document.strategyDecision.evidence.observation.portfolio.brokerState.account.accountId ||
          !document.strategyDecision.selectedSymbols.includes(trade.symbol) ||
          trade.occurredAt < document.strategyDecision.observedAt
        )
          throw new Error('Transaction is not bound to this selected cycle/account/symbol')
        if (transactionIds.has(trade.transactionId)) throw new Error('Duplicate transaction in cohort')
        transactionIds.add(trade.transactionId)
        return trade
      })
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.transactionId.localeCompare(b.transactionId))
    if (row.state === 'NO_TRADE' && trades.length > 0) throw new Error('No-entry cycle has execution transactions')
    const outcome = row.outcome?.value ?? null
    if (row.outcome !== null && Result.getOrThrow(canonicalHashV1Result(outcome)) !== row.outcome.contentHash)
      throw new Error('Imported outcome hash differs')
    if (outcome !== null) {
      const first = trades.find((trade) => trade.transactionId === outcome.openingTransactionId)
      const last = trades.find((trade) => trade.transactionId === outcome.closingTransactionId)
      const buys = trades.filter((trade) => trade.side === 'BUY')
      const sum = (key: 'notionalMicros' | 'realizedPnlMicros', values = trades) =>
        values.reduce((n, t) => n + BigInt(t[key]), 0n)
      if (
        row.state !== 'COMPLETED' ||
        first?.side !== 'BUY' ||
        last?.side !== 'SELL' ||
        first.symbol !== outcome.symbol ||
        trades.some(
          (trade) =>
            trade.symbol !== outcome.symbol ||
            trade.occurredAt < outcome.openedAt ||
            trade.occurredAt > outcome.closedAt,
        ) ||
        first.occurredAt !== outcome.openedAt ||
        last.occurredAt !== outcome.closedAt ||
        Date.parse(outcome.closedAt) - Date.parse(outcome.openedAt) !== outcome.holdingDurationMs ||
        buys.length !== outcome.buyFillCount ||
        trades.length - buys.length !== outcome.sellFillCount ||
        sum('notionalMicros', buys).toString() !== outcome.buyNotionalMicros ||
        sum('notionalMicros').toString() !== outcome.turnoverMicros ||
        sum('realizedPnlMicros').toString() !== outcome.grossRealizedPnlMicros
      )
        throw new Error('Imported episode does not match linked transaction set')
      if (
        outcome.costs.status === 'ATTRIBUTED_ACCRUALS' &&
        (instrumentMarket(outcome.symbol) !== MarketKind.Crypto ||
          BigInt(outcome.costs.attributedCostMicros) <
            trades.reduce((sum, trade) => sum + BigInt(trade.feeMicros), 0n) ||
          BigInt(outcome.grossRealizedPnlMicros) - BigInt(outcome.costs.attributedCostMicros) !==
            BigInt(outcome.costs.netPnlAfterAttributedCostsMicros))
      )
        throw new Error('Imported attributed net is inconsistent')
    }
    if (
      row.exitObservation !== null &&
      (outcome === null ||
        row.exitObservation.cycleId !== row.cycleId ||
        row.exitObservation.openingTransactionId !== outcome.openingTransactionId)
    )
      throw new Error('Exit observation belongs to a different episode')
    return {
      cycleId: row.cycleId,
      state: row.state,
      sourceRevision: row.sourceRevision,
      authorityGenerationHash: row.authorityGenerationHash,
      authorityBinding: document === null ? 'DECLARED_UNVERIFIED' : 'SEALED_DECISION_MATCH',
      sourceRevisionBinding: 'DECLARED_UNVERIFIED',
      transactionIntegrity: 'NOT_REVERIFIED',
      exitSourceProvenance: 'DECLARED_UNVERIFIED',
      strategyDecisionHash: row.strategyDecisionHash,
      decision,
      transactionIds: trades.map((trade) => trade.transactionId),
      importedOutcomeHash: row.outcome?.contentHash ?? null,
      importedOutcome: outcome,
      observedExit: row.exitObservation,
      targetBeforeStop: 'UNKNOWN',
      targetPathCensored: true,
      quantityConservation: 'NOT_REVERIFIED',
      executionEvidence: outcome === null ? 'UNKNOWN_OR_OPEN' : 'IMPORTED_EPISODE_CONSISTENT',
      allInProfitMicros: null,
    }
  })
  return {
    schemaVersion: 'bayn.jev-realized-evidence-report.v1',
    inputHash: Result.getOrThrow(canonicalHashV1Result(bundle)),
    qualification: 'UNQUALIFIED_IMPORTED_EVIDENCE_JOIN',
    independentlyVerifiedLedger: false,
    completeOpportunityScheduleProven: false,
    probabilityInterpretation: 'CATEGORICAL_CHOICE_MASS_NOT_PROFIT_PROBABILITY',
    calibrationFitted: false,
    denominatorCount: rows.length,
    rows,
  }
}

const Document = Schema.Struct({
  bindings: Schema.Struct({ cycleId: Sha256Schema }),
  mode: Schema.Literal('PAPER'),
  strategyDecision: JevEntryTargetSchema,
})
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const State = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-trading-signal-state.v18'),
  task: Schema.Struct({ horizonMinutes: Schema.Finite }),
  execution: Schema.Struct({ estimatedFeeBpsPerSide: NonNegative, estimatedRoundTripFeesBps: NonNegative }),
  entryEconomics: Schema.NullOr(
    Schema.Struct({
      holdingExitRequiredBidRiseBps: Schema.Finite,
      holdingExitBreakEvenBidUsd: Schema.Finite,
      takeProfitRequiredBidRiseBps: Schema.Finite,
      takeProfitBreakEvenLimitUsd: Schema.Finite,
      estimatedEntryFeesUsd: NonNegative,
      maximumHoldingMinutes: Schema.Finite,
      maximumEntryQuoteDriftBps: NonNegative,
      maximumEntryLimitSlippageBps: NonNegative,
      operatingCostCoverage: Schema.String,
    }),
  ),
  candidate: Schema.Struct({
    quote: Schema.Struct({ bid: Schema.Finite.check(Schema.isGreaterThan(0)), ask: Schema.Finite, ageMs: NonNegative }),
    bars1m: Schema.Array(Schema.Struct({ volume: NonNegative, tradeCount: Schema.NullOr(Schema.String) })),
    priceWindow: Schema.Struct({ expectedBarCount: NonNegative, observedBarCount: NonNegative }),
    latestTrade: Schema.optionalKey(Schema.Struct({ ageMs: NonNegative })),
    minuteLogReturnVolatilityBps: Schema.NullOr(NonNegative),
  }),
})

// These are categorical choice masses, not calibrated probabilities of making money.
export const summarizeJevChoiceMass = (probabilities: Readonly<Record<string, number>>) => {
  const plans = Object.entries(probabilities)
    .filter(([key]) => key.startsWith('plan_'))
    .map(([, value]) => value)
  return {
    interpretation: 'CATEGORICAL_CHOICE_MASS_NOT_PROFIT_PROBABILITY',
    aggregatePlanMass: plans.reduce((sum, value) => sum + value, 0),
    maximumPlanMass: plans.length === 0 ? null : Math.max(...plans),
    waitMass: probabilities['wait'] ?? null,
    avoidMass: probabilities['avoid'] ?? null,
    reportedTotalMass: Object.values(probabilities).reduce((sum, value) => sum + value, 0),
  }
}

const range = (values: readonly number[]) =>
  values.length === 0 ? null : { minimum: Math.min(...values), maximum: Math.max(...values) }

export const reportJevAbstention = (input: unknown, historicalMatchedFees?: unknown) => {
  const document = Result.getOrThrowWith(
    Schema.decodeUnknownResult(Document)(input),
    () =>
      new Error(
        'Unsupported or invalid sealed Jev decision. Use a source revision matching the original contract; never rewrite evidence versions.',
      ),
  )
  const target = document.strategyDecision
  if (document.bindings.cycleId !== target.evidence.observation.cycleId)
    throw new Error('Decision bindings identify a different cycle')
  const reproduced = Result.getOrThrow(decideJevEntry(target.evidence))
  if (Result.getOrThrow(canonicalHashV1Result(reproduced)) !== Result.getOrThrow(canonicalHashV1Result(target)))
    throw new Error('Persisted decision does not reproduce from sealed evidence')
  const feeProvenance =
    historicalMatchedFees === undefined
      ? undefined
      : historicalFeeProvenance(
          historicalMatchedFees,
          target.evidence.observation.portfolio.brokerState.account.accountId,
          target.evidence.observation.observedAt,
        )

  const candidates = target.evidence.batchPlan.candidates.map((candidate) => {
    if (candidate.status === JevCandidatePlanStatus.Excluded)
      return { symbol: candidate.symbol, status: candidate.status, reason: candidate.reason }
    const request = candidate.request.request
    const state = Result.getOrThrow(Schema.decodeUnknownResult(State)(request.state))
    const question = request.questions['action']
    if (question?.type !== 'choice') throw new Error('Expected a complete-plan choice')
    const plans = Object.entries(question.criteria)
      .filter(([key]) => key.startsWith('plan_'))
      .map(([choice, value]) => {
        const { plan } = Result.getOrThrow(
          Schema.decodeUnknownResult(Schema.Struct({ plan: JevFundedExitPlanSchema }))(value),
        )
        const acquisition = BigInt(plan.acquisitionCostMicros)
        const loss = acquisition - BigInt(plan.estimatedStopNetMicros)
        const profit = BigInt(plan.estimatedTargetNetMicros) - acquisition
        if (loss <= 0n || profit <= 0n) throw new Error('Funded plan has invalid net economics')
        return {
          choice,
          targetRiseFromBidBps:
            (Number(plan.levels.profitLimitPriceMicros) / 1_000_000 / state.candidate.quote.bid - 1) * 10_000,
          estimatedLossUsd: Number(loss) / 1_000_000,
          estimatedProfitUsd: Number(profit) / 1_000_000,
          netRewardRisk: Number(profit) / Number(loss),
        }
      })
    const result = target.evidence.batchResult.candidates.find((value) => value.symbol === candidate.symbol)
    const response =
      result?.status === JevCandidateResultStatus.Resolved && result.receipt?.outcome.status === JevOutcome.Received
        ? result.receipt.outcome.inference.response
        : null
    const answer = response?.answers['action']
    const setup = response?.answers['setup']
    if (answer !== undefined && answer.type !== 'choice') throw new Error('Expected a choice answer')
    if (setup !== undefined && setup.type !== 'choice') throw new Error('Expected a setup choice answer')
    return {
      symbol: candidate.symbol,
      status: candidate.status,
      requestHash: candidate.request.requestHash,
      inputDefinition: state.schemaVersion,
      chosenAction: answer?.choice ?? null,
      chosenSetup: setup?.choice ?? null,
      setupProbabilities: setup?.probabilities ?? null,
      planChoiceCondition: 'SUPPORTED_LONG_SETUP_ASSUMED',
      rejection: target.entryPlanRejections[candidate.symbol] ?? null,
      choiceMass: answer === undefined ? null : summarizeJevChoiceMass(answer.probabilities),
      fundedPlanCount: plans.length,
      targetRiseFromBidBps: range(plans.map((plan) => plan.targetRiseFromBidBps)),
      netRewardRisk: range(plans.map((plan) => plan.netRewardRisk)),
      horizonMinutes: state.task.horizonMinutes,
      entryEconomics: state.entryEconomics,
      fees: state.execution,
      ...(feeProvenance === undefined || state.entryEconomics === null || !candidate.symbol.endsWith('/USD')
        ? {}
        : {
            feeSensitivity: hypotheticalCryptoFeeSensitivity({
              symbol: candidate.symbol,
              protocol: target.evidence.observation.protocol,
              economics: Result.getOrThrow(
                Schema.decodeUnknownResult(Schema.Struct({ entryEconomics: Schema.Unknown }))(request.state),
              ).entryEconomics,
              bidMicros: Result.getOrThrow(
                priceNumberToMicros(state.candidate.quote.bid, 'sealed sensitivity bid', 'DOWN'),
              ),
            }),
          }),
      coverage: {
        ...state.candidate.priceWindow,
        suppliedBarCount: state.candidate.bars1m.length,
        zeroVolumeBarCount: state.candidate.bars1m.filter((bar) => bar.volume === 0).length,
        zeroTradeBarCount: state.candidate.bars1m.filter(
          (bar) => bar.tradeCount !== null && BigInt(bar.tradeCount) === 0n,
        ).length,
        unknownTradeCountBarCount: state.candidate.bars1m.filter((bar) => bar.tradeCount === null).length,
        latestTradeAgeMs: state.candidate.latestTrade?.ageMs ?? null,
        quoteAgeMs: state.candidate.quote.ageMs,
        minuteLogReturnVolatilityBps: state.candidate.minuteLogReturnVolatilityBps,
      },
      plans,
    }
  })
  return {
    schemaVersion: 'bayn.jev-abstention-report.v2',
    diagnosticOnly: true,
    modelRationaleAvailable: false,
    profitableEdgeProven: false,
    brokerExecutionProven: false,
    reproducedFromSealedEvidence: true,
    cycleId: document.bindings.cycleId,
    observedAt: target.evidence.observation.observedAt,
    protocol: target.evidence.observation.protocol.schemaVersion,
    inputDefinition: target.evidence.observation.protocol.inputDefinition,
    selectedSymbols: target.selectedSymbols,
    ...(feeProvenance === undefined ? {} : { feeProvenance }),
    candidates,
  }
}

const Integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const JevPlanPathAssumptionsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-plan-path-assumptions.v1'),
  decisionHash: Sha256Schema,
  sourceEvidenceSha256: Sha256Schema,
  symbol: Schema.NonEmptyString,
  choice: Schema.String.check(Schema.isPattern(/^plan_[0-9]+$/)),
  windowAnchor: Schema.Literals(['OBSERVATION', 'HYPOTHETICAL_FIRST_FILL']),
  windowStartAt: UtcInstantSchema,
  entryLatencyMs: Integer.check(Schema.isLessThanOrEqualTo(60_000)),
  quantityAtoms: PositiveMicrosSchema,
  feeMultiplierPpm: Integer.check(Schema.isGreaterThanOrEqualTo(1_000_000), Schema.isLessThanOrEqualTo(10_000_000)),
  instruments: ReplayInstrumentsSchema,
  fillAssumption: Schema.Literal('NOT_SIMULATED'),
})

/** Describes original quote deliveries, never an executed or simulated trade.
 * The caller must obtain quotes from the native arrival auditor, not reconstruct bars. */
export const reportJevPlanPath = (input: {
  readonly decisionDocument: unknown
  readonly assumptions: unknown
  readonly quotes: readonly ObservedMarketValue<IntradayQuote>[]
  readonly sourceEvidenceSha256: string
}) => {
  const abstention = reportJevAbstention(input.decisionDocument)
  const { strategyDecision: target } = Result.getOrThrow(Schema.decodeUnknownResult(Document)(input.decisionDocument))
  const assumptions = Result.getOrThrow(
    Schema.decodeUnknownResult(JevPlanPathAssumptionsSchema, strictParseOptions)(input.assumptions),
  )
  const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
  if (hash(target) !== assumptions.decisionHash || input.sourceEvidenceSha256 !== assumptions.sourceEvidenceSha256)
    throw new Error('Plan path evidence binding differs from its assumptions')
  const candidate = target.evidence.batchPlan.candidates.find((value) => value.symbol === assumptions.symbol)
  if (candidate?.status !== JevCandidatePlanStatus.Requested)
    throw new Error('Plan path requires a requested candidate')
  const question = candidate.request.request.questions['action']
  if (question?.type !== 'choice') throw new Error('Plan path requires the original complete-plan choice')
  const { plan } = Result.getOrThrow(
    Schema.decodeUnknownResult(Schema.Struct({ plan: JevFundedExitPlanSchema }))(question.criteria[assumptions.choice]),
  )
  const quantity = BigInt(assumptions.quantityAtoms)
  const instrument = Result.getOrThrow(replayInstrument(assumptions.symbol, assumptions.instruments))
  if (
    plan.levels.symbol !== assumptions.symbol ||
    quantity > BigInt(plan.maximumQuantityAtoms) ||
    quantity < instrument.minimumQuantityAtoms ||
    quantity % instrument.quantityIncrementAtoms !== 0n
  )
    throw new Error('Declared quantity or symbol violates its sealed plan and instrument')
  const observedMs = Date.parse(target.observedAt)
  const entryArrivalMs = observedMs + assumptions.entryLatencyMs
  const startMs = Date.parse(assumptions.windowStartAt)
  if (
    entryArrivalMs >= Date.parse(candidate.request.expiresAt) ||
    (assumptions.windowAnchor === 'OBSERVATION'
      ? startMs !== observedMs
      : startMs < entryArrivalMs || startMs >= Date.parse(candidate.request.expiresAt))
  )
    throw new Error('Declared clock is outside the sealed request or differs from its anchor')
  const endMs = startMs + plan.levels.maximumHoldingMinutes * 60_000
  type Crossing = { availableAtMs: number; sequence: number; recordHash: string; bidMicros: string }
  let firstTarget: Crossing | null = null
  let firstStop: Crossing | null = null
  let previousAt = -Infinity
  let previousSequence = -1
  let accepted = 0
  let inWindow = 0
  const rejected: Record<string, number> = {}
  let firstAt: number | null = null
  let lastAt: number | null = null
  let largestGapMs = 0
  for (const quote of input.quotes) {
    if (
      !Number.isSafeInteger(quote.availableAtMs) ||
      !Number.isSafeInteger(quote.sequence) ||
      quote.availableAtMs < previousAt ||
      quote.sequence <= previousSequence ||
      !Schema.is(Sha256Schema)(quote.recordHash)
    )
      throw new Error('Native quote delivery clock, sequence or identity is invalid')
    previousAt = quote.availableAtMs
    previousSequence = quote.sequence
    if (quote.value.symbol !== assumptions.symbol || quote.availableAtMs < startMs || quote.availableAtMs > endMs)
      continue
    inWindow++
    const reason = replayQuoteRejection(quote, assumptions.symbol, quote.availableAtMs, {
      ...target.evidence.observation.protocol,
      ...jevMarketForSymbol(assumptions.symbol),
    })
    if (reason !== null) {
      rejected[reason] = (rejected[reason] ?? 0) + 1
      continue
    }
    accepted++
    firstAt ??= quote.availableAtMs
    largestGapMs = Math.max(largestGapMs, quote.availableAtMs - (lastAt ?? startMs))
    lastAt = quote.availableAtMs
    const bid = Result.getOrThrow(priceNumberToMicros(quote.value.bidPrice, 'path.bid', 'DOWN'))
    const crossing = {
      availableAtMs: quote.availableAtMs,
      sequence: quote.sequence,
      recordHash: quote.recordHash,
      bidMicros: bid.toString(),
    }
    if (firstStop === null && jevProtectiveStopCrossed(bid, plan.levels)) firstStop = crossing
    if (firstTarget === null && bid >= BigInt(plan.levels.profitLimitPriceMicros)) firstTarget = crossing
  }
  largestGapMs = Math.max(largestGapMs, endMs - (lastAt ?? startMs))
  return {
    schemaVersion: 'bayn.jev-plan-path-diagnostic.v1' as const,
    protocol: abstention.protocol,
    inputDefinition: abstention.inputDefinition,
    diagnosticOnly: true,
    status: 'INCOMPLETE' as const,
    qualification: 'UNQUALIFIED' as const,
    actualExecutionProven: false,
    profitableEdgeProven: false,
    netEconomicPnlMicros: null,
    feeStressApplied: false,
    fillsSimulated: false,
    instrumentTermsIndependentlyVerified: false,
    assumptionManifest: assumptions,
    assumptionManifestHash: hash(assumptions),
    plan,
    originalSelectedSymbols: abstention.selectedSymbols,
    hypotheticalEntryArrivalAt: new Date(entryArrivalMs).toISOString(),
    windowEndAt: new Date(endMs).toISOString(),
    firstTarget,
    firstStop,
    observedOrder:
      firstTarget === null && firstStop === null
        ? 'NO_THRESHOLD_OBSERVED'
        : firstStop === null || (firstTarget !== null && firstTarget.sequence < firstStop.sequence)
          ? 'TARGET_OBSERVED_FIRST'
          : 'STOP_OBSERVED_FIRST',
    coverage: { inWindowQuotes: inWindow, acceptedQuotes: accepted, rejected, firstAt, lastAt, largestGapMs },
    unsupported: [
      'NATIVE_GTC_AND_CONTROLLER_REPLAY',
      'ACTUAL_FIRST_FILL_AND_CAPACITY',
      'FULL_SOURCE_AND_CONTROLLER_COMPLETENESS',
      'OPERATING_COST_ALLOCATION',
    ],
  }
}

/** Public file boundary: never accepts a caller-supplied audit report or quote array. */
export const reportAuditedJevPlanPath = (input: {
  readonly decisionDocument: unknown
  readonly assumptions: unknown
  readonly sourceBundle: Uint8Array
}) => {
  if (input.sourceBundle.byteLength > nativeCoverageMaximumInputBytes)
    throw new Error('Native source bundle exceeds byte limit')
  const assumptions = Result.getOrThrow(
    Schema.decodeUnknownResult(JevPlanPathAssumptionsSchema, strictParseOptions)(input.assumptions),
  )
  const sourceEvidenceSha256 = sha256(input.sourceBundle)
  if (sourceEvidenceSha256 !== assumptions.sourceEvidenceSha256)
    throw new Error('Native source bundle bytes differ from declared hash')
  const sourceBundle: unknown = JSON.parse(Buffer.from(input.sourceBundle).toString('utf8'))
  const audited = Result.getOrThrowWith(auditNativeArrivalCoverage(sourceBundle), (error) => error)
  const path = reportJevPlanPath({ ...input, quotes: audited.quotes, sourceEvidenceSha256 })
  const { strategyDecision: target } = Result.getOrThrow(Schema.decodeUnknownResult(Document)(input.decisionDocument))
  const manifest = Result.getOrThrow(
    Schema.decodeUnknownResult(StrategySnapshotManifestSchema)(target.evidence.observation.manifest),
  )
  const startMs = Date.parse(assumptions.windowStartAt)
  const endMs = Date.parse(path.windowEndAt)
  if (
    manifest.schemaVersion !== 'bayn.streaming-market-snapshot.v1' ||
    audited.report.consumerEpoch !== manifest.streaming.bootstrap.epoch ||
    audited.report.interval.startMs !== startMs ||
    audited.report.interval.endMs !== endMs ||
    !audited.report.symbols.some((value) => value.symbol === assumptions.symbol)
  )
    throw new Error('Native source epoch, interval or symbol differs from the sealed observation and declared window')
  const {
    epoch: { epoch },
  } = Result.getOrThrow(
    Schema.decodeUnknownResult(Schema.Struct({ epoch: Schema.Struct({ epoch: NativeArrivalEpochSchema }) }))(
      sourceBundle,
    ),
  )
  const source = epoch.sources.find((value) => value.symbols.includes(assumptions.symbol))
  if (source === undefined) throw new Error('Native source inventory omits the declared symbol')
  // Match constructStreamingSnapshot's source-specific bootstrap projection.
  const topics = new Set(Object.values(source.topics))
  const bootstrap = {
    ...epoch.bootstrap,
    partitions: epoch.bootstrap.partitions.filter((partition) => topics.has(partition.topic)),
  }
  const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
  if (
    hash(bootstrap) !== hash(manifest.streaming.bootstrap) ||
    source.universeId !== manifest.universeId ||
    source.universeSymbolHash !== manifest.universeSymbolHash ||
    source.topics.bars !== manifest.sourceTopics.bars ||
    source.topics.quotes !== manifest.sourceTopics.quotes ||
    source.topics.trades !== manifest.sourceTopics.trades
  )
    throw new Error('Native source bootstrap or market identity differs from the sealed observation')
  for (const quote of audited.quotes) {
    if (quote.availableAtMs >= startMs && quote.availableAtMs <= endMs && quote.sequence <= manifest.streaming.sequence)
      throw new Error('Native future quote does not follow the sealed observation sequence')
  }
  return { ...path, sourceAudit: audited.report }
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined) throw new Error('Usage: bun tools/jev-abstention-report.ts <private-decision.json>')
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const assumptionsPath = process.argv[3]
  const sourcePath = process.argv[4]
  if (assumptionsPath === '--realized-evidence' && sourcePath === undefined) {
    console.log(JSON.stringify(reportJevRealizedEvidence(raw)))
  } else {
    if ((assumptionsPath === undefined) !== (sourcePath === undefined) || process.argv.length > 5)
      throw new Error('Provide both an assumption manifest and native source bundle, or neither')
    console.log(
      JSON.stringify(
        assumptionsPath === undefined || sourcePath === undefined
          ? reportJevAbstention(raw)
          : reportAuditedJevPlanPath({
              decisionDocument: raw,
              assumptions: JSON.parse(readFileSync(assumptionsPath, 'utf8')),
              sourceBundle: readFileSync(sourcePath),
            }),
      ),
    )
  }
}
