import { Data, Effect, Result, Schema } from 'effect'

import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { canonicalHashV1Result } from '../hash'
import { decideJevEntry } from '../jev/decision'
import { decodeJevBatchResult, JevBatchPlanSchema, JevBatchResultSchema, usableJevBatchInferences } from '../jev/batch'
import { JevObservationSchema } from '../jev/observation-contract'
import { JevPurpose } from '../jev/portfolio'
import { reproduceJevTradingSignalBatchEvidence } from '../jev/trading-signals'
import type { IntradayQuote } from '../market-data/intraday/model'
import { observedQuoteAt, type ObservedMarketValue } from '../market-data/streaming/projection'
import { constructSimulatedSnapshot } from '../market-data/streaming/snapshot'
import { NonNegativeIntegerSchema, PositiveIntegerSchema, Sha256Schema, strictParseOptions } from '../schemas'
import { numberToMicros, MICROS } from '../execution-model'
import { deriveIntradayMomentumSignalMetrics } from '../strategy/intraday-momentum/decision-core'
import { defaultIntradayMomentumProtocolDocument } from '../strategy/intraday-momentum/protocol'
import { utcInstantFromEpochMillis } from '../time'
import { replayQuoteRejection } from './broker-execution-evidence'
import { simulateIntradayReplayIocCore } from './execution-core'
import { applyReplayFill, createReplayLedger, type EconomicReplayFill } from './ledger'
import { BacktestSourceManifestSchema, openBacktestSource, type BacktestSourceReceipt } from './source'

export enum SignalScreenRule {
  Jev = 'JEV',
  Breakout = 'DETERMINISTIC_BREAKOUT',
  RelativeMomentum = 'RELATIVE_MOMENTUM',
}

export const signalStudyDefinition = {
  schemaVersion: 'bayn.jev-signal-study-definition.v1',
  horizonMs: 15 * 60_000,
  entryBudgetMicros: '10000000000',
  limitSlippageBps: 10,
  rules: {
    JEV: 'Reproduce the retained native entry decision at complete batch time, including its threshold and rank.',
    DETERMINISTIC_BREAKOUT:
      'Apply the retained momentum thresholds to every available candidate, ranked by exact benchmark-relative return then symbol.',
    RELATIVE_MOMENTUM:
      'Positive 30-minute return and positive benchmark-relative return, spread at most 5 bps, positive displayed sizes; rank by exact relative return then symbol.',
  },
  breakoutThresholds: {
    lookbackReturnBps: defaultIntradayMomentumProtocolDocument.minimumLookbackReturnBps,
    benchmarkReturnBps: defaultIntradayMomentumProtocolDocument.minimumBenchmarkReturnBps,
    excessReturnBps: defaultIntradayMomentumProtocolDocument.minimumExcessReturnBps,
    breakoutBps: defaultIntradayMomentumProtocolDocument.minimumBreakoutBps,
    rangeLocationPpm: defaultIntradayMomentumProtocolDocument.minimumRangeLocationPpm,
    spreadBps: defaultIntradayMomentumProtocolDocument.maximumSpreadBps,
  },
  limitations: [
    'DEVELOPMENT_SIGNAL_SCREEN, not the frozen acceptance protocol or a portfolio backtest.',
    'Only retained flat-entry observations are sampled. Missing observations and time spent holding are not covered.',
    'Hypothetical positions overlap. Their profits, notional and trade counts cannot be added into portfolio results.',
    'All rules use the same batch completion and routing times. This is not the earliest possible deterministic decision.',
    'Each hypothesis has one IOC entry and one IOC exit. Missing quotes, canceled orders and partial exits remain unresolved.',
    'Returns include spread, slippage and execution fees. Model and data costs are not allocated to hypotheses.',
    'Quote-size units and market impact require independent calibration before executable capacity can be claimed.',
    'One horizon on development data cannot establish predictive calibration, statistical significance or economic qualification.',
  ],
} as const

const Batch = Schema.Struct({
  observation: JevObservationSchema,
  batchPlan: JevBatchPlanSchema,
  batchResult: Schema.NullOr(JevBatchResultSchema),
})

export const SignalStudyInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-signal-study-input.v1'),
  runId: Sha256Schema,
  source: BacktestSourceManifestSchema,
  assumptions: Schema.Struct({
    latencyMs: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(60_000)),
    slippageBps: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(10_000)),
    availableLiquidityPpm: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1_000_000)),
    feeMultiplierPpm: PositiveIntegerSchema.check(Schema.isBetween({ minimum: 1_000_000, maximum: 10_000_000 })),
  }),
  batches: Schema.Array(Batch).check(Schema.isMinLength(1)),
})

export class SignalStudyFailure extends Data.TaggedError('SignalStudyFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const prepareSignalStudyBatch = (input: unknown) =>
  Result.gen(function* () {
    const batch = yield* Schema.decodeUnknownResult(Batch, strictParseOptions)(input)
    const { observation, plan } = yield* reproduceJevTradingSignalBatchEvidence(batch.observation, batch.batchPlan)
    if (observation.schemaVersion !== 'bayn.jev-observation.v1')
      return yield* Result.fail(new SignalStudyFailure({ message: 'The study requires native Jev observations' }))
    if (batch.batchResult !== null) yield* decodeJevBatchResult(plan, batch.batchResult)
    const decidedAt = batch.batchResult?.completedAt ?? plan.expiresAt
    const native =
      batch.batchResult === null || observation.portfolio.purpose !== JevPurpose.Entry
        ? null
        : decideJevEntry({ ...batch, decidedAt })
    const usable =
      batch.batchResult === null ? null : usableJevBatchInferences(plan, batch.batchResult, Date.parse(decidedAt))
    const inferences = usable !== null && Result.isSuccess(usable) ? usable.success : []
    const snapshot = observation.snapshot
    const prices = (symbol: string) =>
      Result.gen(function* () {
        const rolling = snapshot.manifest.streaming.features.find((entry) => entry.value.material.symbol === symbol)
        const quote = snapshot.latestQuotes[symbol]
        const trade = snapshot.trades
          .filter((entry) => entry.symbol === symbol)
          .toSorted((a, b) => a.eventAt.localeCompare(b.eventAt))
          .at(-1)
        if (rolling === undefined || quote === undefined || trade === undefined)
          return yield* Result.fail(new SignalStudyFailure({ message: `Missing verified signal for ${symbol}` }))
        return {
          reference: BigInt(rolling.value.material.values.referencePriceMicros),
          high: BigInt(rolling.value.material.values.rangeHighPriceMicros),
          low: BigInt(rolling.value.material.values.rangeLowPriceMicros),
          bid: yield* numberToMicros(quote.bidPrice),
          ask: yield* numberToMicros(quote.askPrice),
          trade: yield* numberToMicros(trade.price),
          quote,
        }
      })
    const benchmark = yield* prices(observation.protocol.benchmarkSymbol)
    const signals = []
    for (const candidate of plan.candidates) {
      if (candidate.status === 'EXCLUDED') continue
      const values = yield* prices(candidate.symbol)
      const { metrics, excessReturn } = yield* deriveIntradayMomentumSignalMetrics(values, candidate.symbol, benchmark)
      const t = signalStudyDefinition.breakoutThresholds
      const liquid = values.quote.bidSize > 0 && values.quote.askSize > 0 && metrics.spreadBps <= t.spreadBps
      const answer = inferences.find((entry) => entry.symbol === candidate.symbol)?.inference.response.answers['action']
      signals.push({
        symbol: candidate.symbol,
        metrics,
        excessReturn,
        enterProbability: answer?.type === 'choice' ? (answer.probabilities['enter'] ?? null) : null,
        breakout:
          liquid &&
          metrics.lookbackReturnBps >= t.lookbackReturnBps &&
          metrics.benchmarkReturnBps >= t.benchmarkReturnBps &&
          excessReturn.numerator * 10_000n >= BigInt(t.excessReturnBps) * excessReturn.denominator &&
          metrics.breakoutBps >= t.breakoutBps &&
          metrics.rangeLocationPpm >= t.rangeLocationPpm,
        relativeMomentum: liquid && metrics.lookbackReturnBps > 0 && excessReturn.numerator > 0n,
      })
    }
    signals.sort((a, b) => {
      const order =
        a.excessReturn.numerator * b.excessReturn.denominator - b.excessReturn.numerator * a.excessReturn.denominator
      return order === 0n ? a.symbol.localeCompare(b.symbol) : order > 0n ? -1 : 1
    })
    return {
      observation: batch.observation,
      snapshot,
      plan,
      decidedAt,
      modelStatus: native !== null && Result.isSuccess(native) ? ('AVAILABLE' as const) : ('UNAVAILABLE' as const),
      selected: {
        [SignalScreenRule.Jev]:
          native !== null && Result.isSuccess(native) ? (native.success.selectedSymbols[0] ?? null) : null,
        [SignalScreenRule.Breakout]: signals.find((entry) => entry.breakout)?.symbol ?? null,
        [SignalScreenRule.RelativeMomentum]: signals.find((entry) => entry.relativeMomentum)?.symbol ?? null,
      },
      signals: signals.map(({ excessReturn: _exact, ...signal }) => signal),
    }
  }).pipe(Result.mapError((cause) => new SignalStudyFailure({ message: 'Invalid retained study batch', cause })))

type PreparedBatch = Result.Result.Success<ReturnType<typeof prepareSignalStudyBatch>>
type Quote = ObservedMarketValue<IntradayQuote> | undefined

export const studyIoc = (input: {
  readonly symbol: string
  readonly side: OrderSide
  readonly quantityMicros: bigint
  readonly decisionQuote: Quote
  readonly arrivalQuote: Quote
  readonly decisionAtMs: number
  readonly arrivalAtMs: number
  readonly protocol: PreparedBatch['observation']['protocol']
  readonly assumptions: typeof SignalStudyInputSchema.Type.assumptions
}) =>
  Result.gen(function* () {
    if (input.arrivalAtMs !== input.decisionAtMs + input.assumptions.latencyMs)
      return yield* Result.fail(new SignalStudyFailure({ message: 'Study routing time differs from its assumptions' }))
    for (const [quote, at] of [
      [input.decisionQuote, input.decisionAtMs],
      [input.arrivalQuote, input.arrivalAtMs],
    ] as const) {
      const reason = replayQuoteRejection(quote, input.symbol, at, input.protocol)
      if (reason !== null || quote === undefined)
        return { status: 'UNRESOLVED' as const, reason: reason ?? 'missing-quote' }
    }
    const decision = input.decisionQuote
    const arrival = input.arrivalQuote
    if (decision === undefined || arrival === undefined)
      return { status: 'UNRESOLVED' as const, reason: 'missing-quote' }
    const buy = input.side === OrderSide.Buy
    const price = yield* numberToMicros(buy ? decision.value.askPrice : decision.value.bidPrice)
    const terms = yield* deriveExecutionIntentPricing({
      side: input.side,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      quantityMicros: input.quantityMicros,
      referencePriceMicros: price,
      executionModel: input.protocol.executionModel,
      limitSlippageBps: BigInt(signalStudyDefinition.limitSlippageBps),
    })
    const outcome = yield* simulateIntradayReplayIocCore({
      order: {
        side: input.side,
        quantityMicros: input.quantityMicros,
        limitPriceMicros: terms.expectedExecutionPriceMicros,
      },
      quote: {
        priceMicros: yield* numberToMicros(buy ? arrival.value.askPrice : arrival.value.bidPrice),
        displayedQuantityMicros: yield* numberToMicros(buy ? arrival.value.askSize : arrival.value.bidSize),
      },
      executionModel: input.protocol.executionModel,
      assumptions: input.assumptions,
    })
    if (outcome.status === 'canceled') return { status: 'CANCELED' as const, reason: outcome.reason }
    return {
      status: 'FILLED' as const,
      fill: {
        symbol: input.symbol,
        side: buy ? ('buy' as const) : ('sell' as const),
        observedAt: utcInstantFromEpochMillis(input.arrivalAtMs),
        quantityMicros: String(outcome.filledQuantityMicros),
        priceMicros: String(outcome.fillPriceMicros),
        notionalMicros: String(outcome.fillNotionalMicros),
      },
      quoteHash: arrival.recordHash,
      decisionQuoteHash: decision.recordHash,
    }
  }).pipe(Result.mapError((cause) => new SignalStudyFailure({ message: 'Cannot simulate study IOC', cause })))

type HypothesisOutcome =
  | { readonly status: 'UNRESOLVED' | 'NO_ENTRY_FILL'; readonly reason: string }
  | {
      readonly status: 'RESOLVED'
      readonly entryNotionalMicros: string
      readonly netExecutionPnlMicros: string
      readonly netExecutionReturnBps: number
    }

export const studyRoundTrip = (input: {
  readonly symbol: string
  readonly protocol: PreparedBatch['observation']['protocol']
  readonly assumptions: typeof SignalStudyInputSchema.Type.assumptions
  readonly decidedAtMs: number
  readonly entryDecisionQuote: Quote
  readonly entryArrivalQuote: Quote
  readonly exitDecisionQuote: Quote
  readonly exitArrivalQuote: Quote
}) =>
  Result.gen(function* () {
    const entryAtMs = input.decidedAtMs + input.assumptions.latencyMs
    const exitDecisionAtMs = entryAtMs + signalStudyDefinition.horizonMs
    let ledger = yield* createReplayLedger(signalStudyDefinition.entryBudgetMicros)
    const quoteHashes: string[] = []
    const finish = (outcome: HypothesisOutcome) => ({ outcome, fills: ledger.fills, quoteHashes })
    const reference = input.entryDecisionQuote?.value.askPrice
    if (reference === undefined || reference <= 0)
      return finish({ status: 'UNRESOLVED', reason: 'missing-entry-pricing' })
    const sizing = yield* deriveExecutionIntentPricing({
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      quantityMicros: MICROS,
      referencePriceMicros: yield* numberToMicros(reference),
      executionModel: input.protocol.executionModel,
      limitSlippageBps: BigInt(signalStudyDefinition.limitSlippageBps),
    })
    const quantity = (BigInt(signalStudyDefinition.entryBudgetMicros) / sizing.expectedExecutionPriceMicros) * MICROS
    if (quantity === 0n) return finish({ status: 'NO_ENTRY_FILL', reason: 'budget-below-one-share' })
    const entry = yield* studyIoc({
      ...input,
      side: OrderSide.Buy,
      quantityMicros: quantity,
      decisionQuote: input.entryDecisionQuote,
      arrivalQuote: input.entryArrivalQuote,
      decisionAtMs: input.decidedAtMs,
      arrivalAtMs: entryAtMs,
    })
    if (entry.status !== 'FILLED')
      return finish({ status: entry.status === 'CANCELED' ? 'NO_ENTRY_FILL' : 'UNRESOLVED', reason: entry.reason })
    quoteHashes.push(entry.decisionQuoteHash, entry.quoteHash)
    ledger = yield* applyReplayFill(
      ledger,
      entry.fill,
      String(quantity),
      input.protocol.executionModel,
      input.assumptions.feeMultiplierPpm,
    )
    const exit = yield* studyIoc({
      ...input,
      side: OrderSide.Sell,
      quantityMicros: BigInt(entry.fill.quantityMicros),
      decisionQuote: input.exitDecisionQuote,
      arrivalQuote: input.exitArrivalQuote,
      decisionAtMs: exitDecisionAtMs,
      arrivalAtMs: exitDecisionAtMs + input.assumptions.latencyMs,
    })
    if (exit.status !== 'FILLED') return finish({ status: 'UNRESOLVED', reason: `exit-${exit.reason}` })
    quoteHashes.push(exit.decisionQuoteHash, exit.quoteHash)
    ledger = yield* applyReplayFill(
      ledger,
      exit.fill,
      entry.fill.quantityMicros,
      input.protocol.executionModel,
      input.assumptions.feeMultiplierPpm,
    )
    return finish(
      ledger.netRealizedPnlAfterCostsMicros === null
        ? { status: 'UNRESOLVED', reason: 'partial-exit' }
        : {
            status: 'RESOLVED',
            entryNotionalMicros: entry.fill.notionalMicros,
            netExecutionPnlMicros: ledger.netRealizedPnlAfterCostsMicros,
            netExecutionReturnBps:
              (Number(ledger.netRealizedPnlAfterCostsMicros) / Number(entry.fill.notionalMicros)) * 10_000,
          },
    )
  }).pipe(Result.mapError((cause) => new SignalStudyFailure({ message: 'Cannot evaluate study round trip', cause })))

export const runSignalStudy = (raw: unknown, arrivalsPath: string, receipt: BacktestSourceReceipt) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(SignalStudyInputSchema, strictParseOptions)(raw)
    const sourceHash = yield* Effect.fromResult(canonicalHashV1Result(input.source))
    const batches = yield* Effect.forEach(input.batches, (batch) => Effect.fromResult(prepareSignalStudyBatch(batch)))
    const ids = new Set<string>()
    for (const batch of batches) {
      const manifest = batch.snapshot.manifest
      if (ids.has(batch.plan.batchId)) return yield* new SignalStudyFailure({ message: 'Duplicate retained batch' })
      ids.add(batch.plan.batchId)
      if (
        manifest.schemaVersion !== 'bayn.simulated-market-snapshot.v1' ||
        manifest.streaming.runId !== input.runId ||
        manifest.streaming.sourceManifestHash !== sourceHash
      )
        return yield* new SignalStudyFailure({ message: 'Study observation belongs to another source or run' })
    }
    const source = yield* openBacktestSource(arrivalsPath, input.source, input.runId, receipt)
    const entries = batches.filter((batch) => batch.observation.portfolio.purpose === JevPurpose.Entry)
    const rows: {
      readonly batchId: string
      readonly observedAt: string
      readonly decidedAt: string
      readonly symbol: string
      readonly selectedBy: readonly SignalScreenRule[]
      readonly enterProbability: number | null
      readonly outcome: HypothesisOutcome
      readonly fills: readonly EconomicReplayFill[]
      readonly quoteHashes: readonly string[]
    }[] = []
    const tasks: { readonly atMs: number; readonly run: Effect.Effect<void, SignalStudyFailure> }[] = []
    const addTask = (atMs: number, run: Effect.Effect<void, SignalStudyFailure>) => tasks.push({ atMs, run })
    for (const batch of entries) {
      const { observation, plan } = batch
      const { protocol } = observation
      const manifest = batch.snapshot.manifest
      addTask(
        Date.parse(observation.observedAt),
        Effect.gen(function* () {
          const snapshot = yield* Effect.fromResult(
            constructSimulatedSnapshot(yield* source.cursor, source.source, {
              ...manifest,
              universe: protocol.universe,
            }),
          )
          if (
            snapshot.manifest.contentHash !== manifest.contentHash ||
            snapshot.manifest.snapshotId !== manifest.snapshotId
          )
            return yield* new SignalStudyFailure({
              message: 'Frozen arrivals do not reproduce the retained observation',
            })
        }).pipe(
          Effect.mapError((cause) => new SignalStudyFailure({ message: 'Study source reproduction failed', cause })),
        ),
      )
      const decisionAtMs = Date.parse(batch.decidedAt)
      const entryAtMs = decisionAtMs + input.assumptions.latencyMs
      const exitDecisionAtMs = entryAtMs + signalStudyDefinition.horizonMs
      const exitAtMs = exitDecisionAtMs + input.assumptions.latencyMs
      const session = manifest.calendar.sessions.find((value) => value.date === manifest.sessionDate)
      if (session === undefined) return yield* new SignalStudyFailure({ message: 'Missing study session' })
      for (const signal of batch.signals) {
        const identity = {
          batchId: plan.batchId,
          observedAt: observation.observedAt,
          decidedAt: batch.decidedAt,
          symbol: signal.symbol,
          selectedBy: Object.values(SignalScreenRule).filter((rule) => batch.selected[rule] === signal.symbol),
          enterProbability: signal.enterProbability,
        }
        if (exitAtMs >= Date.parse(session.closeAt) || exitAtMs > input.source.coverageEndMs) {
          rows.push({
            ...identity,
            outcome: { status: 'UNRESOLVED', reason: 'horizon-outside-session-or-source' },
            fills: [],
            quoteHashes: [],
          })
          continue
        }
        const quotes = new Map<number, Quote>()
        for (const at of [decisionAtMs, entryAtMs, exitDecisionAtMs, exitAtMs])
          addTask(
            at,
            Effect.gen(function* () {
              quotes.set(at, observedQuoteAt((yield* source.cursor).projection, signal.symbol, at))
            }),
          )
        addTask(
          exitAtMs,
          Effect.gen(function* () {
            const result = yield* Effect.fromResult(
              studyRoundTrip({
                symbol: signal.symbol,
                protocol,
                assumptions: input.assumptions,
                decidedAtMs: decisionAtMs,
                entryDecisionQuote: quotes.get(decisionAtMs),
                entryArrivalQuote: quotes.get(entryAtMs),
                exitDecisionQuote: quotes.get(exitDecisionAtMs),
                exitArrivalQuote: quotes.get(exitAtMs),
              }),
            )
            rows.push({ ...identity, ...result })
          }),
        )
      }
    }
    tasks.sort((a, b) => a.atMs - b.atMs)
    for (const task of tasks) {
      yield* source.advanceTo(task.atMs)
      yield* task.run
    }
    yield* source.finish
    rows.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.symbol.localeCompare(b.symbol))
    const summary = Object.values(SignalScreenRule).map((rule) => {
      const selected = rows.filter((row) => row.selectedBy.includes(rule))
      const resolved = selected.flatMap((row) => (row.outcome.status === 'RESOLVED' ? [row.outcome] : []))
      return {
        rule,
        selectedObservations: selected.length,
        resolved: resolved.length,
        noEntryFill: selected.filter((row) => row.outcome.status === 'NO_ENTRY_FILL').length,
        unresolved: selected.filter((row) => row.outcome.status === 'UNRESOLVED').length,
        positive: resolved.filter((value) => value.netExecutionReturnBps > 0).length,
        meanExecutionReturnBpsAmongResolved:
          resolved.length === 0
            ? null
            : resolved.reduce((sum, value) => sum + value.netExecutionReturnBps, 0) / resolved.length,
      }
    })
    const report = {
      schemaVersion: 'bayn.jev-signal-study.v1',
      definition: signalStudyDefinition,
      definitionHash: yield* Effect.fromResult(canonicalHashV1Result(signalStudyDefinition)),
      inputHash: yield* Effect.fromResult(canonicalHashV1Result(input)),
      sourceReceiptHash: receipt.contentHash,
      sourceManifestHash: sourceHash,
      sourceRecordCount: input.source.recordCount,
      entryObservationCount: entries.length,
      managementObservationsNotStudied: batches.length - entries.length,
      unavailableModelBatches: entries
        .filter((batch) => batch.modelStatus === 'UNAVAILABLE')
        .map((batch) => batch.plan.batchId),
      observations: entries.map((batch) => ({
        batchId: batch.plan.batchId,
        observedAt: batch.observation.observedAt,
        decidedAt: batch.decidedAt,
        modelStatus: batch.modelStatus,
        selected: batch.selected,
        exclusions: batch.plan.candidates.filter((candidate) => candidate.status === 'EXCLUDED'),
      })),
      summary,
      rows,
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  })
