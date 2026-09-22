import { Data, Result } from 'effect'

import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import {
  constrainExecutionTargetAllocationCapitalMicros,
  executionMandateAllocationCapitalMicros,
} from '../execution/mandate'
import { MICROS, numberToMicros } from '../execution-model'
import { jevProtectiveStopCrossed } from '../jev/exit'
import type { JevProtocol } from '../jev/protocol'
import type { IntradayQuote } from '../market-data/intraday/model'
import { intradayInstantNanos } from '../market-data/intraday/time'
import type { ObservedMarketValue } from '../market-data/streaming/projection'
import type { StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import type { Policy } from '../risk'
import { deriveIntradayMomentumSignalMetrics } from '../strategy/intraday-momentum/decision-core'
import { defaultIntradayMomentumProtocolDocument } from '../strategy/intraday-momentum/protocol'
import { replayQuoteRejection } from './broker-execution-evidence'
import { applyReplayFill, createReplayLedger, type EconomicReplayFill, type ReplayLedger } from './ledger'
import { studyIoc } from './signal-study'

export enum ControlPolicy {
  RetainedBreakout = 'RETAINED_BREAKOUT_CLOSE',
  RepeatedBreakout = 'REPEATED_BREAKOUT',
  RelativeMomentum = 'REPEATED_RELATIVE_MOMENTUM',
}

export enum ControlExit {
  SessionClose = 'SESSION_CLOSE',
  MaximumHold = 'MAXIMUM_HOLD',
  ProtectiveStop = 'PROTECTIVE_STOP',
}

export class ControlStudyFailure extends Data.TaggedError('ControlStudyFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type ControlQuote = ObservedMarketValue<IntradayQuote> | undefined
type EpisodeStart = { readonly enteredAtMs: number; readonly openingCashMicros: string }
type ControlInventory =
  | { readonly status: 'FLAT' }
  | ({ readonly status: 'HOLDING' } & EpisodeStart)
  | ({ readonly status: 'EXITING'; readonly reason: ControlExit } & EpisodeStart)

export interface ControlEpisode {
  readonly symbol: string
  readonly enteredAtMs: number
  readonly exitedAtMs: number
  readonly reason: ControlExit
  readonly netExecutionPnlMicros: string
}

export interface ControlPortfolio {
  readonly ledger: ReplayLedger<EconomicReplayFill>
  readonly inventory: ControlInventory
  readonly episodes: readonly ControlEpisode[]
  readonly tradedNotionalMicros: bigint
}

export const createControlPortfolio = (
  openingCashMicros: string,
): Result.Result<ControlPortfolio, ControlStudyFailure> =>
  createReplayLedger(openingCashMicros).pipe(
    Result.map((ledger) => ({
      ledger,
      inventory: { status: 'FLAT' as const },
      episodes: [],
      tradedNotionalMicros: 0n,
    })),
    Result.mapError((cause) => new ControlStudyFailure({ message: 'Invalid control opening cash', cause })),
  )

export const controlCandidates = (policy: ControlPolicy, protocol: JevProtocol) =>
  policy === ControlPolicy.RetainedBreakout
    ? defaultIntradayMomentumProtocolDocument.candidateSymbols
    : protocol.candidateSymbols

export const selectControlSymbol = (snapshot: StrategyMarketSnapshot, policy: ControlPolicy, protocol: JevProtocol) =>
  Result.gen(function* () {
    const prices = (symbol: string) =>
      Result.gen(function* () {
        const rolling = snapshot.manifest.streaming.features.find((entry) => entry.value.material.symbol === symbol)
        const quote = snapshot.latestQuotes[symbol]
        const trade = snapshot.trades
          .filter((entry) => entry.symbol === symbol)
          .toSorted((a, b) => (intradayInstantNanos(a.eventAt) < intradayInstantNanos(b.eventAt) ? 1 : -1))[0]
        if (rolling === undefined || quote === undefined || trade === undefined)
          return yield* Result.fail(new ControlStudyFailure({ message: `Missing control signal for ${symbol}` }))
        const now = intradayInstantNanos(snapshot.manifest.observedAt)
        const fresh = [quote.eventAt, trade.eventAt].every((at) => {
          const age = now - intradayInstantNanos(at)
          return age >= 0n && age <= BigInt(protocol.maximumQuoteAgeMs) * 1_000_000n
        })
        return {
          reference: BigInt(rolling.value.material.values.referencePriceMicros),
          high: BigInt(rolling.value.material.values.rangeHighPriceMicros),
          low: BigInt(rolling.value.material.values.rangeLowPriceMicros),
          bid: yield* numberToMicros(quote.bidPrice),
          ask: yield* numberToMicros(quote.askPrice),
          trade: yield* numberToMicros(trade.price),
          liquid: fresh && quote.bidSize > 0 && quote.askSize > 0,
        }
      })
    const benchmark = yield* prices(protocol.benchmarkSymbol)
    if (!benchmark.liquid)
      return yield* Result.fail(new ControlStudyFailure({ message: 'Control benchmark is stale or illiquid' }))
    const signals = []
    const t = defaultIntradayMomentumProtocolDocument
    for (const symbol of controlCandidates(policy, protocol)) {
      if (snapshot.manifest.candidateExclusions?.some((entry) => entry.symbol === symbol) === true) continue
      const p = yield* prices(symbol)
      const { metrics, excessReturn } = yield* deriveIntradayMomentumSignalMetrics(p, symbol, benchmark)
      if (!p.liquid || metrics.spreadBps > protocol.maximumSpreadBps) continue
      const eligible =
        policy === ControlPolicy.RelativeMomentum
          ? p.bid + p.ask > 2n * p.reference && excessReturn.numerator > 0n
          : metrics.lookbackReturnBps >= t.minimumLookbackReturnBps &&
            metrics.benchmarkReturnBps >= t.minimumBenchmarkReturnBps &&
            excessReturn.numerator * 10_000n >= BigInt(t.minimumExcessReturnBps) * excessReturn.denominator &&
            metrics.breakoutBps >= t.minimumBreakoutBps &&
            metrics.rangeLocationPpm >= t.minimumRangeLocationPpm
      if (eligible) signals.push({ symbol, excessReturn })
    }
    signals.sort((a, b) => {
      const delta =
        a.excessReturn.numerator * b.excessReturn.denominator - b.excessReturn.numerator * a.excessReturn.denominator
      return delta === 0n ? (a.symbol < b.symbol ? -1 : 1) : delta > 0n ? -1 : 1
    })
    return signals[0]?.symbol ?? null
  }).pipe(Result.mapError((cause) => new ControlStudyFailure({ message: 'Cannot select control signal', cause })))

export const controlEntryQuantity = (input: {
  readonly portfolio: ControlPortfolio
  readonly policy: Policy
  readonly protocol: JevProtocol
  readonly targetWeight: number
  readonly symbol: string
  readonly referencePriceMicros: bigint
  readonly atMs: number
  readonly feeMultiplierPpm: number
}) =>
  Result.gen(function* () {
    const { portfolio, policy, symbol, referencePriceMicros, protocol } = input
    if (portfolio.inventory.status !== 'FLAT' || portfolio.ledger.positions.length !== 0)
      return yield* Result.fail(new ControlStudyFailure({ message: 'Control entry requires flat inventory' }))
    const targetWeights = { [symbol]: input.targetWeight }
    const allocation = yield* executionMandateAllocationCapitalMicros({
      accountEquityMicros: BigInt(portfolio.ledger.cashMicros),
      dailyTradedNotionalMicros: portfolio.tradedNotionalMicros,
      maxGrossExposureMicros: BigInt(policy.maxGrossExposureMicros),
      maxNetExposureMicros: BigInt(policy.maxNetExposureMicros),
      maxDailyTradedNotionalMicros: BigInt(policy.maxDailyTradedNotionalMicros),
      maxAdverseSlippageBps: BigInt(policy.maxAdverseSlippageBps),
      targetWeights,
      positions: [],
      referencePriceMicros: { [symbol]: String(referencePriceMicros) },
    })
    const constrained = yield* constrainExecutionTargetAllocationCapitalMicros({
      allocationCapitalMicros: allocation,
      maxOrderNotionalMicros: BigInt(policy.maxOrderNotionalMicros),
      maxSymbolExposureMicros: BigInt(policy.maxSymbolExposureMicros),
      maxAdverseSlippageBps: BigInt(policy.maxAdverseSlippageBps),
      targetWeights,
    })
    const weight = BigInt(Math.round(input.targetWeight * 1_000_000))
    let high = (constrained * weight) / MICROS / referencePriceMicros
    let low = 0n
    const pricing = yield* deriveExecutionIntentPricing({
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      quantityMicros: MICROS,
      referencePriceMicros,
      executionModel: protocol.executionModel,
      limitSlippageBps: BigInt(policy.maxAdverseSlippageBps),
    })
    while (low < high) {
      const shares = (low + high + 1n) / 2n
      const notional = shares * pricing.expectedExecutionPriceMicros
      const tentative = applyReplayFill(
        portfolio.ledger,
        {
          symbol,
          side: 'buy',
          observedAt: new Date(input.atMs).toISOString(),
          quantityMicros: String(shares * MICROS),
          priceMicros: String(pricing.expectedExecutionPriceMicros),
          notionalMicros: String(notional),
        },
        String(shares * MICROS),
        protocol.executionModel,
        input.feeMultiplierPpm,
      )
      if (Result.isFailure(tentative) && tentative.failure._tag !== 'IntradayReplayLedgerInsufficientCash')
        return yield* Result.fail(tentative.failure)
      const allowed =
        Result.isSuccess(tentative) &&
        notional <= BigInt(policy.maxOrderNotionalMicros) &&
        portfolio.tradedNotionalMicros + notional <= BigInt(policy.maxDailyTradedNotionalMicros)
      if (allowed) low = shares
      else high = shares - 1n
    }
    return low * MICROS
  }).pipe(Result.mapError((cause) => new ControlStudyFailure({ message: 'Cannot size control entry', cause })))

export const triggerControlExit = (input: {
  readonly portfolio: ControlPortfolio
  readonly policy: ControlPolicy
  readonly protocol: JevProtocol
  readonly atMs: number
  readonly cutoffMs: number
  readonly quote: ControlQuote
}): Result.Result<ControlPortfolio, ControlStudyFailure> =>
  Result.gen(function* () {
    const { portfolio, protocol, atMs, quote } = input
    if (portfolio.inventory.status !== 'HOLDING') return portfolio
    const position = portfolio.ledger.positions[0]
    if (position === undefined)
      return yield* Result.fail(new ControlStudyFailure({ message: 'Holding control has no ledger position' }))
    let reason: ControlExit | undefined
    if (atMs >= input.cutoffMs) reason = ControlExit.SessionClose
    else if (input.policy !== ControlPolicy.RetainedBreakout) {
      if (atMs - portfolio.inventory.enteredAtMs >= protocol.maximumHoldingMinutes * 60_000)
        reason = ControlExit.MaximumHold
      else if (
        quote !== undefined &&
        replayQuoteRejection(quote, position.symbol, atMs, protocol) === null &&
        jevProtectiveStopCrossed(
          BigInt(position.costBasisMicros),
          BigInt(position.quantityMicros),
          yield* numberToMicros(quote.value.bidPrice),
          protocol.protectiveStopBps,
        )
      )
        reason = ControlExit.ProtectiveStop
    }
    return reason === undefined
      ? portfolio
      : { ...portfolio, inventory: { ...portfolio.inventory, status: 'EXITING' as const, reason } }
  }).pipe(Result.mapError((cause) => new ControlStudyFailure({ message: 'Cannot manage control position', cause })))

export const applyControlOrder = (portfolio: ControlPortfolio, input: Parameters<typeof studyIoc>[0]) =>
  Result.gen(function* () {
    const buying = input.side === OrderSide.Buy
    if ((buying && portfolio.inventory.status !== 'FLAT') || (!buying && portfolio.inventory.status !== 'EXITING'))
      return yield* Result.fail(new ControlStudyFailure({ message: 'Order violates control inventory phase' }))
    const outcome = yield* studyIoc(input)
    if (outcome.status !== 'FILLED') return { portfolio, outcome }
    const ledger = yield* applyReplayFill(
      portfolio.ledger,
      outcome.fill,
      String(input.quantityMicros),
      input.protocol.executionModel,
      input.assumptions.feeMultiplierPpm,
    )
    const updated = {
      ...portfolio,
      ledger,
      tradedNotionalMicros: portfolio.tradedNotionalMicros + BigInt(outcome.fill.notionalMicros),
    }
    if (buying)
      return {
        portfolio: {
          ...updated,
          inventory: {
            status: 'HOLDING' as const,
            enteredAtMs: input.arrivalAtMs,
            openingCashMicros: portfolio.ledger.cashMicros,
          },
        },
        outcome,
      }
    if (ledger.positions.length !== 0) return { portfolio: updated, outcome }
    const inventory = portfolio.inventory
    if (inventory.status !== 'EXITING')
      return yield* Result.fail(new ControlStudyFailure({ message: 'Closed control has no exit trigger' }))
    return {
      portfolio: {
        ...updated,
        inventory: { status: 'FLAT' as const },
        episodes: [
          ...portfolio.episodes,
          {
            symbol: input.symbol,
            enteredAtMs: inventory.enteredAtMs,
            exitedAtMs: input.arrivalAtMs,
            reason: inventory.reason,
            netExecutionPnlMicros: String(BigInt(ledger.cashMicros) - BigInt(inventory.openingCashMicros)),
          },
        ],
      },
      outcome,
    }
  }).pipe(Result.mapError((cause) => new ControlStudyFailure({ message: 'Cannot execute control order', cause })))
