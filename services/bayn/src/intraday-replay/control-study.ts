import { Clock, Effect, FileSystem, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { AssetStatus, type MarketCalendarObservation, type MarketCalendarSession } from '../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { OrderSide } from '../execution/contracts'
import { numberToMicros } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import type { JevProtocol } from '../jev/protocol'
import type { IntradaySnapshotQuery } from '../market-data/intraday/model'
import { observedQuoteAt } from '../market-data/streaming/projection'
import {
  constructSimulatedSnapshot,
  type StrategyMarketSnapshot,
  type VerifiedStrategyMarketSnapshot,
} from '../market-data/streaming/snapshot'
import { loadQuoteBoundExecutionRiskPolicy } from '../observe-composition/decision-builder'
import type { Policy } from '../risk'
import { IsoDateSchema, NonNegativeIntegerSchema, PositiveIntegerSchema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import { BacktestInputSchema, prepareBacktest } from './backtest'
import { replayQuoteRejection } from './broker-execution-evidence'
import { makeControlJevManagement, type ControlJevBinding } from './control-jev'
import { makeControlJevJournal } from './control-jev-journal'
import type { makeControlManagementBatch } from './control-management'
import { calculateReplayJevCosts, type ReplayJevCostModelSchema } from './jev-costs'
import {
  applyControlOrder,
  controlCandidates,
  controlEntryQuantity,
  ControlPolicy,
  ControlStudyFailure,
  createControlPortfolio,
  selectControlSymbol,
  triggerControlExit,
  type ControlQuote,
} from './control-portfolio'
import { openBacktestSource, type BacktestSourceReceipt } from './source'

export enum ControlManagementMode {
  Mechanical = 'MECHANICAL',
  Jev = 'JEV',
}

export type ControlStudyManagement =
  | { readonly mode: ControlManagementMode.Mechanical }
  | {
      readonly mode: ControlManagementMode.Jev
      readonly evidenceDirectory: string
      readonly provider: ControlJevBinding['provider']
      readonly providerClock: Clock.Clock
    }

export const ControlStudyInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.control-study-input.v2'),
  management: Schema.Enum(ControlManagementMode),
  backtest: BacktestInputSchema,
  decisionLatencyMs: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(60_000)),
  repeatedTargetWeightPpm: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(200_000)),
})

export const controlStudyDefinition = {
  schemaVersion: 'bayn.control-study-definition.v3',
  policies: {
    RETAINED_BREAKOUT_CLOSE:
      'Six retained candidates, retained breakout thresholds, 10 percent allocation, hold until the close window.',
    REPEATED_BREAKOUT:
      'Jev candidate universe and retained breakout thresholds, mechanical stop and maximum hold, repeated entries.',
    REPEATED_RELATIVE_MOMENTUM:
      'Jev candidate universe, exact positive return and benchmark-relative return, mechanical stop and maximum hold, repeated entries.',
  },
  opportunityClock:
    'Polls are anchored to session open. After decision and routing work, resume at the first scheduled poll at or after completion; never replay missed polls. Each flat portfolio evaluates the latest eligible completed signal window once successfully observed. Breakout policies use native momentum ranking including all tie-breaks. Relative momentum ranks by exact relative return, then symbol.',
  sizing:
    'Bayn target allocation and order/symbol/turnover bounds, whole shares, cash reserved for cumulative fees at the adverse buy limit.',
  execution:
    'Fresh decision and arrival quotes, shared native IOC execution and accounting. Each portfolio consumes displayed liquidity once per quote identity, symbol and side. One entry IOC; persistent risk-reducing exit retries on the next poll.',
  management:
    'JEV mode uses native observation, evaluation, deadline and management decisions for each repeated control from its own filled position. An exclusive simulation journal records source observations, batches, request claims, receipts and resolutions. Measured provider and journal work advance an independent market clock. Entry and management consume signal windows independently. Existing exit triggers, stops, holding deadlines and the close window precede inference.',
  valuation:
    'Retain session boundaries, one-minute marks, each poll, decision completion and before/after order outcomes. Broker equity and its carried peak govern risk. Net equity deducts cumulative external costs only for reported performance, drawdown and session loss, matching native replay. External costs never change broker cash, sizing or risk.',
  limitations: [
    'DEVELOPMENT_CONTROL_PORTFOLIOS. Not the frozen matched-control acceptance experiment or a prospective qualification.',
    'Management is explicitly selected. JEV gives each repeated control its own native held-position decisions; MECHANICAL deliberately removes model management. The retained close control never calls Jev. No model responses are synthesized.',
    'The retained selection and close lifecycle do not reproduce historical persistence, reconciliation, authority, retry and market-close fallback machinery.',
    'Deterministic entry latency is a declared scenario. Jev management measures its provider and simulation-journal work, not production PostgreSQL persistence or a full-controller p95. Timing still requires calibration for the frozen matched comparison. Routing latency is added separately.',
    'Quote size units and impact remain uncalibrated. Source completeness and a flat simulated close do not establish executable live capacity.',
    'Missing decision or valuation evidence remains explicit and makes a session incomplete. Candidate-local exclusions remain in the decision trace.',
  ],
} as const

export interface ControlMarket {
  readonly advanceTo: (atMs: number) => Effect.Effect<void, ControlStudyFailure>
  readonly quoteAt: (symbol: string, atMs: number) => Effect.Effect<ControlQuote, ControlStudyFailure>
  readonly snapshot: (
    query: IntradaySnapshotQuery,
  ) => Effect.Effect<
    | { readonly status: 'AVAILABLE'; readonly snapshot: VerifiedStrategyMarketSnapshot }
    | { readonly status: 'UNAVAILABLE'; readonly cause: unknown },
    ControlStudyFailure
  >
}

export interface ControlCapital {
  readonly cashMicros: string
  readonly peakBrokerEquityMicros: string
  readonly peakNetEquityMicros: string
  readonly accruedExternalCostMicros: string
}

const failureDetails = (cause: unknown) =>
  Result.try({
    try: () => JSON.stringify(cause),
    catch: (error) => new ControlStudyFailure({ message: 'Cannot retain control failure details', cause: error }),
  }).pipe(
    Result.flatMap((value) =>
      value === undefined
        ? Result.fail(new ControlStudyFailure({ message: 'Control failure has no serializable details' }))
        : Result.succeed(value),
    ),
  )

export const runControlSession = (input: {
  readonly policy: ControlPolicy
  readonly protocol: JevProtocol
  readonly risk: Policy
  readonly session: MarketCalendarSession
  readonly calendar: MarketCalendarObservation
  readonly openingCapital: ControlCapital
  readonly dataCostMicros: string
  readonly targetWeight: number
  readonly decisionLatencyMs: number
  readonly pollIntervalMs: number
  readonly assumptions: typeof BacktestInputSchema.Type.assumptions
  readonly eligibleSymbols: ReadonlySet<string>
  readonly market: ControlMarket
  readonly management: null | {
    readonly runId: string
    readonly binding: ControlJevBinding
    readonly costs: typeof ReplayJevCostModelSchema.Type
  }
}) =>
  Effect.gen(function* () {
    const { market, protocol, risk, session, assumptions } = input
    const sessionDate = yield* Schema.decodeUnknownEffect(IsoDateSchema)(session.date)
    const openMs = Date.parse(session.openAt)
    const closeMs = Date.parse(session.closeAt)
    const cutoffMs = closeMs - protocol.entryCutoffMinutesBeforeClose * 60_000
    const warmupMs = openMs + protocol.lookbackMinutes * 60_000 + protocol.decisionDelaySeconds * 1000
    const openingCash = BigInt(input.openingCapital.cashMicros)
    const dataCost = BigInt(input.dataCostMicros)
    const openingNetEquity = openingCash - BigInt(input.openingCapital.accruedExternalCostMicros)
    const accruedExternalCost = BigInt(input.openingCapital.accruedExternalCostMicros) + dataCost
    const firstCallIndex = input.management === null ? 0 : (yield* input.management.binding.journal.calls).length
    const modelCosts = (atMs: number) =>
      Effect.gen(function* () {
        if (input.management === null) return { knownCostMicros: '0', unresolvedCallCount: 0, callCount: 0 }
        const calls = (yield* input.management.binding.journal.calls)
          .slice(firstCallIndex)
          .filter(
            (call) =>
              Date.parse(call.simulatedStartedAt) +
                Date.parse(call.providerCompletedAt) -
                Date.parse(call.providerStartedAt) <=
              atMs,
          )
        return calculateReplayJevCosts(calls, input.management.costs)
      })
    let portfolio = yield* Effect.fromResult(createControlPortfolio(String(openingCash)))
    let peakBrokerEquity = BigInt(input.openingCapital.peakBrokerEquityMicros)
    let peakNetEquity = BigInt(input.openingCapital.peakNetEquityMicros)
    let maximumDrawdown = 0n
    let maximumSessionLoss = dataCost
    let lastWindow = -1
    let lastEntryDecisionHash: string | undefined
    let entryBinding: Omit<Parameters<typeof makeControlManagementBatch>[0], 'runId' | 'snapshot'> | null = null
    const decisions: {
      observedAt: string
      status: string
      symbol?: string
      snapshotHash?: string
      exclusions?: StrategyMarketSnapshot['manifest']['candidateExclusions']
      cause?: unknown
      management?: { batchId: string; decisionHash: string; decidedAt: string; committedAt: string }
    }[] = []
    const orders: {
      submittedAt: string
      arrivedAt: string
      side: OrderSide
      symbol: string
      requestedQuantityMicros: string
      outcome: unknown
    }[] = []
    const marks: {
      observedAt: string
      brokerEquityMicros: string | null
      netEquityAfterKnownCostsMicros: string | null
      quoteHash: string | null
      cause: string | null
    }[] = []
    let missingDecisions = 0
    let missingExecutionQuotes = 0
    let unavailableManagement = 0
    let nextMarkMs = openMs
    const mark = (atMs: number) =>
      Effect.gen(function* () {
        const position = portfolio.ledger.positions[0]
        const quote = position === undefined ? undefined : yield* market.quoteAt(position.symbol, atMs)
        const rejection =
          position === undefined
            ? null
            : (replayQuoteRejection(quote, position.symbol, atMs, protocol) ??
              (quote !== undefined && Number.isFinite(quote.value.bidSize) && quote.value.bidSize > 0
                ? null
                : 'no-displayed-bid-liquidity'))
        if (rejection !== null) {
          marks.push({
            observedAt: utcInstantFromEpochMillis(atMs),
            brokerEquityMicros: null,
            netEquityAfterKnownCostsMicros: null,
            quoteHash: quote?.recordHash ?? null,
            cause: rejection,
          })
          return
        }
        const brokerEquity =
          BigInt(portfolio.ledger.cashMicros) +
          (position !== undefined && quote !== undefined
            ? (BigInt(position.quantityMicros) * (yield* Effect.fromResult(numberToMicros(quote.value.bidPrice)))) /
              1_000_000n
            : 0n)
        const netEquity = brokerEquity - accruedExternalCost - BigInt((yield* modelCosts(atMs)).knownCostMicros)
        if (brokerEquity > peakBrokerEquity) peakBrokerEquity = brokerEquity
        if (netEquity > peakNetEquity) peakNetEquity = netEquity
        if (peakNetEquity - netEquity > maximumDrawdown) maximumDrawdown = peakNetEquity - netEquity
        if (openingNetEquity - netEquity > maximumSessionLoss) maximumSessionLoss = openingNetEquity - netEquity
        marks.push({
          observedAt: utcInstantFromEpochMillis(atMs),
          brokerEquityMicros: String(brokerEquity),
          netEquityAfterKnownCostsMicros: String(netEquity),
          quoteHash: quote?.recordHash ?? null,
          cause: null,
        })
      })
    const advanceTo = (atMs: number) =>
      Effect.gen(function* () {
        while (nextMarkMs <= Math.min(atMs, closeMs)) {
          yield* market.advanceTo(nextMarkMs)
          yield* mark(nextMarkMs)
          nextMarkMs += 60_000
        }
        yield* market.advanceTo(atMs)
        if (atMs <= closeMs && marks.at(-1)?.observedAt !== utcInstantFromEpochMillis(atMs)) yield* mark(atMs)
      })
    const management =
      input.management === null
        ? null
        : yield* makeControlJevManagement(input.management.binding, (atMs) =>
            advanceTo(atMs).pipe(
              Effect.mapError(
                (cause) => new ControlStudyFailure({ message: 'Cannot mark control management time', cause }),
              ),
            ),
          )
    let atMs = openMs
    let nextPollMs = openMs
    while (atMs < closeMs) {
      yield* advanceTo(atMs)
      const held = portfolio.ledger.positions[0]
      portfolio = yield* Effect.fromResult(
        triggerControlExit({
          portfolio,
          policy: input.policy,
          protocol,
          atMs,
          cutoffMs,
          quote: held === undefined ? undefined : yield* market.quoteAt(held.symbol, atMs),
        }),
      )
      if (
        portfolio.inventory.status === 'HOLDING' &&
        management !== null &&
        input.management !== null &&
        held !== undefined
      ) {
        if (entryBinding === null)
          return yield* new ControlStudyFailure({ message: 'Held control position has no entry evidence' })
        const rangeEndMs = Math.floor((atMs - protocol.decisionDelaySeconds * 1000) / 60_000) * 60_000
        const observedAt = utcInstantFromEpochMillis(atMs)
        const observed = yield* market.snapshot({
          sessionDate,
          calendar: input.calendar,
          observedAt,
          rangeStartAt: utcInstantFromEpochMillis(rangeEndMs - protocol.lookbackMinutes * 60_000),
          rangeEndAt: utcInstantFromEpochMillis(rangeEndMs),
          universeId: protocol.universeId,
          universeSymbolHash: protocol.universeSymbolHash,
          universe: protocol.universe,
          symbols: [held.symbol, protocol.benchmarkSymbol].sort(),
          candidateSymbols: [held.symbol],
          feed: protocol.feed,
          delayClass: protocol.delayClass,
          sourceTopics: protocol.sourceTopics,
          maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
          minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1000,
        })
        if (observed.status === 'UNAVAILABLE') {
          unavailableManagement++
          decisions.push({
            observedAt,
            status: 'MANAGEMENT_UNAVAILABLE',
            symbol: held.symbol,
            cause: yield* Effect.fromResult(failureDetails(observed.cause)),
          })
        } else {
          const outcome = yield* management.evaluate(
            { ...entryBinding, runId: input.management.runId, snapshot: observed.snapshot },
            portfolio,
          )
          atMs = yield* Clock.currentTimeMillis
          if (outcome.status === 'DECIDED') {
            portfolio = outcome.applied.portfolio
            decisions.push({
              observedAt,
              status: `MANAGEMENT_${outcome.applied.action}`,
              symbol: held.symbol,
              management: {
                batchId: outcome.applied.decision.evidence.batchPlan.batchId,
                decisionHash: yield* Effect.fromResult(canonicalHashV1Result(outcome.applied.decision)),
                decidedAt: outcome.applied.decision.evidence.decidedAt,
                committedAt: utcInstantFromEpochMillis(outcome.committedAtMs),
              },
            })
          } else if (outcome.status === 'UNAVAILABLE') {
            unavailableManagement++
            decisions.push({
              observedAt,
              status: 'MANAGEMENT_UNAVAILABLE',
              symbol: held.symbol,
              cause: yield* Effect.fromResult(failureDetails(outcome.cause)),
            })
          }
          portfolio = yield* Effect.fromResult(
            triggerControlExit({
              portfolio,
              policy: input.policy,
              protocol,
              atMs,
              cutoffMs,
              quote: yield* market.quoteAt(held.symbol, atMs),
            }),
          )
        }
      }
      let symbol: string | null = null
      let side = OrderSide.Buy
      if (portfolio.inventory.status === 'EXITING') {
        symbol = held?.symbol ?? null
        side = OrderSide.Sell
      } else if (portfolio.inventory.status === 'FLAT' && atMs >= warmupMs && atMs < cutoffMs) {
        const rangeEndMs = Math.floor((atMs - protocol.decisionDelaySeconds * 1000) / 60_000) * 60_000
        if (rangeEndMs > lastWindow) {
          const observedAt = utcInstantFromEpochMillis(atMs)
          const candidates = controlCandidates(input.policy, protocol)
          const observed = yield* market.snapshot({
            sessionDate,
            calendar: input.calendar,
            observedAt,
            rangeStartAt: utcInstantFromEpochMillis(rangeEndMs - protocol.lookbackMinutes * 60_000),
            rangeEndAt: utcInstantFromEpochMillis(rangeEndMs),
            universeId: protocol.universeId,
            universeSymbolHash: protocol.universeSymbolHash,
            universe: protocol.universe,
            symbols: [...candidates, protocol.benchmarkSymbol].sort(),
            candidateSymbols: candidates,
            feed: protocol.feed,
            delayClass: protocol.delayClass,
            sourceTopics: protocol.sourceTopics,
            maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
            minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1000,
          })
          if (observed.status === 'UNAVAILABLE') {
            missingDecisions += 1
            decisions.push({
              observedAt,
              status: 'UNAVAILABLE',
              cause: yield* Effect.fromResult(failureDetails(observed.cause)),
            })
          } else {
            lastWindow = rangeEndMs
            const selected = selectControlSymbol(observed.snapshot, input.policy, protocol)
            if (Result.isFailure(selected)) {
              missingDecisions += 1
              decisions.push({
                observedAt,
                status: 'UNAVAILABLE',
                cause: yield* Effect.fromResult(failureDetails(selected.failure)),
              })
            } else {
              symbol = selected.success
              lastEntryDecisionHash = yield* Effect.fromResult(
                canonicalHashV1Result({
                  policy: input.policy,
                  observedAt,
                  symbol,
                  snapshotHash: observed.snapshot.manifest.contentHash,
                }),
              )
              decisions.push({
                observedAt,
                status: symbol === null ? 'NO_SIGNAL' : 'SELECTED',
                ...(symbol === null ? {} : { symbol }),
                snapshotHash: observed.snapshot.manifest.contentHash,
                exclusions: observed.snapshot.manifest.candidateExclusions ?? [],
              })
              atMs = Math.min(atMs + input.decisionLatencyMs, closeMs)
              yield* advanceTo(atMs)
              if (atMs >= cutoffMs || input.decisionLatencyMs >= protocol.inferenceValidityMs) {
                decisions.push({ observedAt: utcInstantFromEpochMillis(atMs), status: 'DECISION_EXPIRED' })
                symbol = null
              }
            }
          }
        }
      }
      if (symbol !== null && atMs + assumptions.latencyMs < closeMs) {
        const decisionQuote = yield* market.quoteAt(symbol, atMs)
        const rejection = replayQuoteRejection(decisionQuote, symbol, atMs, protocol)
        if (rejection !== null || decisionQuote === undefined) {
          missingExecutionQuotes += 1
          decisions.push({
            observedAt: utcInstantFromEpochMillis(atMs),
            status: 'MISSING_PRICING',
            symbol,
            cause: rejection,
          })
        } else {
          const riskBlocked =
            side === OrderSide.Buy &&
            (!input.eligibleSymbols.has(symbol) ||
              openingCash - BigInt(portfolio.ledger.cashMicros) > BigInt(risk.maxDailyLossMicros) ||
              peakBrokerEquity - BigInt(portfolio.ledger.cashMicros) > BigInt(risk.maxDrawdownMicros))
          const quantity = riskBlocked
            ? 0n
            : side === OrderSide.Sell
              ? BigInt(held?.quantityMicros ?? '0')
              : yield* Effect.fromResult(
                  controlEntryQuantity({
                    portfolio,
                    policy: risk,
                    protocol,
                    targetWeight: input.targetWeight,
                    symbol,
                    referencePriceMicros: yield* Effect.fromResult(numberToMicros(decisionQuote.value.askPrice)),
                    atMs,
                    feeMultiplierPpm: assumptions.feeMultiplierPpm,
                  }),
                )
          if (quantity > 0n) {
            const submittedAtMs = atMs
            atMs += assumptions.latencyMs
            yield* advanceTo(atMs)
            const entryOrder: Parameters<typeof applyControlOrder>[1] = {
              symbol,
              side,
              quantityMicros: quantity,
              protocol,
              assumptions,
              decisionQuote,
              arrivalQuote: yield* market.quoteAt(symbol, atMs),
              decisionAtMs: submittedAtMs,
              arrivalAtMs: atMs,
            }
            const result = yield* Effect.fromResult(applyControlOrder(portfolio, entryOrder))
            if (side === OrderSide.Buy && result.outcome.status === 'FILLED') {
              if (lastEntryDecisionHash === undefined)
                return yield* new ControlStudyFailure({ message: 'Filled control entry has no decision identity' })
              entryBinding = { beforeEntry: portfolio, entryOrder, entryDecisionHash: lastEntryDecisionHash }
            } else if (result.portfolio.inventory.status === 'FLAT') entryBinding = null
            portfolio = result.portfolio
            yield* mark(atMs)
            if (result.outcome.status === 'UNRESOLVED') missingExecutionQuotes += 1
            orders.push({
              submittedAt: utcInstantFromEpochMillis(submittedAtMs),
              arrivedAt: utcInstantFromEpochMillis(atMs),
              side,
              symbol,
              requestedQuantityMicros: String(quantity),
              outcome: result.outcome,
            })
          } else
            decisions.push({ observedAt: utcInstantFromEpochMillis(atMs), status: 'RISK_OR_CAPITAL_BLOCKED', symbol })
        }
      }
      nextPollMs += Math.max(1, Math.ceil((atMs - nextPollMs) / input.pollIntervalMs)) * input.pollIntervalMs
      atMs = Math.max(atMs, Math.min(nextPollMs, closeMs))
    }
    yield* advanceTo(Math.max(atMs, closeMs))
    const sessionModelCosts = yield* modelCosts(Number.POSITIVE_INFINITY)
    const totalExternalCost = accruedExternalCost + BigInt(sessionModelCosts.knownCostMicros)
    const issues = [
      ...(missingDecisions > 0 ? ['MISSING_DECISION_DATA'] : []),
      ...(missingExecutionQuotes > 0 ? ['MISSING_EXECUTION_QUOTES'] : []),
      ...(marks.some((entry) => entry.netEquityAfterKnownCostsMicros === null) ? ['MISSING_VALUATION'] : []),
      ...(portfolio.ledger.positions.length > 0 ? ['UNCLOSED_POSITION'] : []),
      ...(unavailableManagement > 0 ? ['UNAVAILABLE_MANAGEMENT'] : []),
      ...(sessionModelCosts.unresolvedCallCount > 0 ? ['UNPRICED_MODEL_CALLS'] : []),
      ...(atMs > closeMs ? ['MANAGEMENT_AFTER_CLOSE'] : []),
    ]
    const netPnl =
      portfolio.ledger.positions.length === 0
        ? String(BigInt(portfolio.ledger.cashMicros) - totalExternalCost - openingNetEquity)
        : null
    return {
      sessionDate: session.date,
      policy: input.policy,
      completion: issues.length === 0 ? ('COMPLETE' as const) : ('INCOMPLETE' as const),
      issues,
      targetWeight: input.targetWeight,
      completedEpisodes: portfolio.episodes.length,
      filledNotionalMicros: String(portfolio.tradedNotionalMicros),
      netPnlAfterKnownCostsMicros: netPnl,
      netAfterAdditional10BpsMicros:
        netPnl === null ? null : String(BigInt(netPnl) - (portfolio.tradedNotionalMicros + 999n) / 1000n),
      executionFeesMicros: portfolio.ledger.executionFeesMicros,
      modelCostMicros: sessionModelCosts.unresolvedCallCount === 0 ? sessionModelCosts.knownCostMicros : null,
      knownModelCostMicros: sessionModelCosts.knownCostMicros,
      modelCallCount: sessionModelCosts.callCount,
      unpricedModelCallCount: sessionModelCosts.unresolvedCallCount,
      managementMode: input.management === null ? ControlManagementMode.Mechanical : ControlManagementMode.Jev,
      unavailableManagement,
      dataCostMicros: input.dataCostMicros,
      maximumMarkedDrawdownMicros: String(maximumDrawdown),
      maximumMarkedSessionLossMicros: String(maximumSessionLoss),
      closingCapital: {
        cashMicros: portfolio.ledger.cashMicros,
        peakBrokerEquityMicros: String(peakBrokerEquity),
        peakNetEquityMicros: String(peakNetEquity),
        accruedExternalCostMicros: String(totalExternalCost),
      } satisfies ControlCapital,
      missingDecisions,
      missingExecutionQuotes,
      ledger: portfolio.ledger,
      episodes: portfolio.episodes,
      decisions,
      orders,
      marks,
    }
  }).pipe(Effect.mapError((cause) => new ControlStudyFailure({ message: 'Control session failed', cause })))

export const runControlStudy = (
  raw: unknown,
  arrivalsPath: string,
  receipt: BacktestSourceReceipt,
  management: ControlStudyManagement,
) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(ControlStudyInputSchema, strictParseOptions)(raw)
    if (input.management !== management.mode)
      return yield* new ControlStudyFailure({ message: 'Control management binding differs from its frozen input' })
    const prepared = yield* Effect.fromResult(prepareBacktest(input.backtest, receipt))
    if (prepared.input.cadence.pollIntervalMs > 60_000 || prepared.input.assumptions.latencyMs > 60_000)
      return yield* new ControlStudyFailure({
        message: 'Control polling and routing latency must each be at most one minute',
      })
    const risk = yield* loadQuoteBoundExecutionRiskPolicy(prepared.identity.accountId, prepared.protocol.universe)
    const firstDate = prepared.input.sessionDates[0]
    const lastDate = prepared.input.calendar.at(-1)?.date
    if (firstDate === undefined || lastDate === undefined)
      return yield* new ControlStudyFailure({ message: 'Control calendar has no boundary sessions' })
    const calendar = yield* Effect.fromResult(
      normalizeMarketCalendarResult(prepared.input.calendar, {
        start: firstDate,
        end: lastDate,
      }),
    )
    const runId = yield* Effect.fromResult(
      canonicalHashV1Result({ input, receiptHash: receipt.contentHash, definition: controlStudyDefinition, risk }),
    )
    if (management.mode === ControlManagementMode.Jev) {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(management.evidenceDirectory)
      yield* Effect.gen(function* () {
        const file = yield* fs.open(`${management.evidenceDirectory}/registration.json`, { flag: 'wx' })
        yield* file.writeAll(
          new TextEncoder().encode(
            `${JSON.stringify({ runId, input, sourceReceiptHash: receipt.contentHash, definition: controlStudyDefinition, risk })}\n`,
          ),
        )
        yield* file.sync
        const directory = yield* fs.open(management.evidenceDirectory, { flag: 'r' })
        yield* directory.sync
      }).pipe(Effect.scoped)
    }
    const sessions = []
    for (const policy of Object.values(ControlPolicy)) {
      const results = yield* Effect.gen(function* () {
        yield* TestClock.setTime(prepared.openMs)
        const controlRunId = yield* Effect.fromResult(canonicalHashV1Result({ runId, policy }))
        const binding =
          management.mode === ControlManagementMode.Jev && policy !== ControlPolicy.RetainedBreakout
            ? {
                runId: controlRunId,
                costs: prepared.input.inference.costs,
                binding: {
                  provider: management.provider,
                  providerClock: management.providerClock,
                  journal: yield* makeControlJevJournal(`${management.evidenceDirectory}/${policy}`, controlRunId),
                },
              }
            : null
        const source = yield* openBacktestSource(arrivalsPath, prepared.input.source, runId, receipt)
        const market: ControlMarket = {
          advanceTo: (atMs) =>
            source.advanceTo(atMs).pipe(
              Effect.andThen(TestClock.setTime(atMs)),
              Effect.mapError((cause) => new ControlStudyFailure({ message: 'Cannot advance control source', cause })),
            ),
          quoteAt: (symbol, atMs) =>
            source.cursor.pipe(Effect.map((cursor) => observedQuoteAt(cursor.projection, symbol, atMs))),
          snapshot: (query) =>
            source.cursor.pipe(
              Effect.map((cursor) => {
                const result = constructSimulatedSnapshot(cursor, source.source, query)
                return Result.isSuccess(result)
                  ? { status: 'AVAILABLE' as const, snapshot: result.success }
                  : { status: 'UNAVAILABLE' as const, cause: result.failure }
              }),
            ),
        }
        const results = []
        let capital: ControlCapital = {
          cashMicros: prepared.input.openingCashMicros,
          peakBrokerEquityMicros: prepared.input.openingCashMicros,
          peakNetEquityMicros: prepared.input.openingCashMicros,
          accruedExternalCostMicros: '0',
        }
        for (const session of prepared.sessions) {
          const result = yield* runControlSession({
            policy,
            protocol: prepared.protocol,
            risk,
            session,
            calendar,
            openingCapital: capital,
            dataCostMicros: prepared.input.allocatedDataCostPerSessionMicros,
            targetWeight: policy === ControlPolicy.RetainedBreakout ? 0.1 : input.repeatedTargetWeightPpm / 1_000_000,
            decisionLatencyMs: input.decisionLatencyMs,
            pollIntervalMs: prepared.input.cadence.pollIntervalMs,
            assumptions: prepared.input.assumptions,
            eligibleSymbols: new Set(
              prepared.assets
                .filter((asset) => asset.tradable && asset.status === AssetStatus.Active)
                .map((asset) => asset.symbol),
            ),
            market,
            management: binding,
          })
          results.push(result)
          if (result.ledger.positions.length !== 0 && session !== prepared.sessions.at(-1))
            return yield* new ControlStudyFailure({
              message: 'Cannot reset an unresolved control position between sessions',
            })
          capital = result.closingCapital
        }
        yield* source.finish
        return results
      }).pipe(Effect.scoped)
      sessions.push(...results)
    }
    const report = {
      schemaVersion: 'bayn.control-study-report.v3',
      classification: 'DEVELOPMENT_CONTROL_PORTFOLIOS',
      runId,
      definition: controlStudyDefinition,
      input,
      sourceReceiptHash: receipt.contentHash,
      risk,
      sessions,
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  })
