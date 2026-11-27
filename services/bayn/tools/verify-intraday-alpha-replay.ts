import { readFileSync } from 'node:fs'
import { Result, Schema } from 'effect'

import { MarketCalendarQueryBase, MarketCalendarResponseSchema } from '../src/broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import { quantizeInstrumentPriceMicros } from '../src/broker/alpaca-price'
import { AccountStatus, OrderSide, OrderType, ReconciliationStatus, TimeInForce } from '../src/execution/contracts'
import type { EquityShortEligibility } from '../src/execution/equity-short'
import { canonicalHashV1Result } from '../src/hash'
import { decodeJevPortfolio, JevPurpose } from '../src/jev/portfolio'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../src/jev/protocol'
import {
  IntradayBenchmarkEvidencePolicy,
  IntradayCandidateEvidencePolicy,
  type IntradayBar,
  type IntradayQuote,
} from '../src/market-data/intraday/model'
import {
  buildTrailingBaseline,
  noiseAreaCheckpointMinutes,
  type IntradayAlphaTrailingBaseline,
  type PriorSessionCheckpointSummary,
  type PriorSessionDailySummary,
} from '../src/market-data/intraday/trailing-baseline'
import type { StrategyMarketSnapshot } from '../src/market-data/streaming/snapshot'
import { quantityScale } from '../src/quantity'
import { IsoDateSchema, strictParseOptions } from '../src/schemas'
import { reconciledStateHash } from '../src/simulation-reconciliation/broker-model'
import { numberToMicros, priceNumberToMicros } from '../src/strategy/execution-model/fixed-point'
import { balancedFundedMiddaySymbols, isBalancedMiddayBasket } from '../src/strategy/intraday-alpha/decision'
import { evaluateMiddayResidualProtection } from '../src/strategy/intraday-alpha/midday-residual-protection'
import { makeIntradayAlphaFundedExitPlan } from '../src/strategy/intraday-alpha/exit-plan'
import {
  IntradayAlphaPhase,
  intradayAlphaBenchmarkSymbol,
  intradayAlphaCandidateSymbols,
  intradayAlphaEquityMarketProfile,
  makeIntradayAlphaPolicy,
  type IntradayAlphaPolicy,
} from '../src/strategy/intraday-alpha/policy'
import { makeIntradayAlphaPolicyV21, type IntradayAlphaPolicyV21 } from '../src/strategy/intraday-alpha/policy-v2-1'
import {
  extractIntradayAlphaCandidates,
  resolveAlphaRegularSession,
  selectIntradayAlphaLegs,
  type ActiveAlphaPhase,
} from '../src/strategy/intraday-alpha/signals'
import { TargetPlanStatus, planTargets, quoteBoundTargetPlannerInputSchemaVersion } from '../src/target-planner/index'
import { utcInstantFromEpochMillis } from '../src/time'
import {
  parseReplayQuotes,
  parseReplaySplits,
  priorPriceScale,
  readReplayFile,
  replayLines,
  type MinuteQuote,
} from './intraday-alpha-replay-inputs'
import { replayDiagnosticClass, replayScorecard } from './intraday-alpha-replay-scorecard'

export interface RawBar {
  readonly symbol: string
  readonly eventAt: string
  readonly eventMs: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly vwap: number
}

interface TradeOutcome {
  readonly sessionDate: string
  readonly phase: ActiveAlphaPhase
  readonly symbol: string
  readonly direction: 'LONG' | 'SHORT'
  readonly shares: number
  readonly entryPrice: number
  readonly exitPrice: number
  readonly entryAt: string
  readonly exitAt: string
  readonly exitReason: 'STOP' | 'TARGET' | 'MAX_HOLD' | 'EOD' | 'MIDDAY_RESIDUAL_TRIM'
  readonly grossPnlUsd: number
  readonly netPnlUsd: number
}

const ReplayCalendarSchema = Schema.Struct({
  query: MarketCalendarQueryBase,
  // Frozen calendar exports may retain only regular hours. Mirror them into the unused full-session fields.
  response: Schema.Array(
    MarketCalendarResponseSchema.value.mapFields((fields) => ({
      ...fields,
      session_open: Schema.optionalKey(fields.session_open),
      session_close: Schema.optionalKey(fields.session_close),
    })),
  ),
})
export type ReplayCalendar = Result.Result.Success<ReturnType<typeof normalizeMarketCalendarResult>>

interface EntryAttempt {
  readonly phase: ActiveAlphaPhase
  readonly observedAt: string
  readonly orderExpiresAt: string
  readonly occupiedSymbols: readonly string[]
  readonly selectedSymbols: readonly string[]
  readonly filledSymbols: string[]
  longEntryNotionalUsd: number
  shortEntryNotionalUsd: number
  residualProtection?:
    | { readonly observedAt: string; readonly status: 'EVIDENCE_UNAVAILABLE' }
    | {
        readonly observedAt: string
        readonly status: 'MODELED'
        readonly signedNotionalMicros: string
        readonly modeledSignedNotionalAfterTrimMicros: string
        readonly trims: readonly { readonly symbol: string; readonly shares: number }[]
      }
}

interface UnresolvedExit {
  readonly symbol: string
  readonly entryAt: string
  readonly exitDueAt: string
  readonly reason:
    | 'POST_DEADLINE_PRICE_UNAVAILABLE'
    | 'L1_EXIT_MINUTE_UNAVAILABLE'
    | 'MIDDAY_RESIDUAL_EVIDENCE_UNAVAILABLE'
}

interface CoHeldMarkGap {
  readonly symbol: string
  readonly phase: ActiveAlphaPhase
  readonly observedAt: string
  readonly expectedBarAt: string
  readonly lastPriorBarAt: string | null
  readonly ageMinutes: number | null
  readonly carried: boolean
}

interface L1ExecutionGap {
  readonly symbol: string
  readonly minuteAt: string
  readonly stage: 'ENTRY' | 'EXIT'
}

type QuoteModel =
  | { readonly slippageRtBps: number; readonly bySymbol?: never }
  | { readonly slippageRtBps: 0; readonly bySymbol: ReadonlyMap<string, ReadonlyMap<number, MinuteQuote>> }

const carryForwardMinutes = 2

interface UnavailableBenchmarkCheckpoint {
  readonly phase: ActiveAlphaPhase
  readonly observedAt: string
  readonly expectedBarAt: string
}

interface ActiveSimulatedPosition {
  readonly phase: ActiveAlphaPhase
  readonly symbol: string
  readonly direction: 'LONG' | 'SHORT'
  readonly shares: number
  readonly entryPrice: number
  readonly entryMinute: number
  readonly exitMinute: number
  readonly trim?: { readonly minute: number; readonly shares: number }
  readonly stopPriceMicros: string
  readonly stopLimitPriceMicros: string
  readonly profitLimitPriceMicros: string
}

const allowedSymbols = new Set<string>([...intradayAlphaCandidateSymbols, intradayAlphaBenchmarkSymbol])
const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
const v2Policy = makeIntradayAlphaPolicy(protocol)
type ReplayPolicy = IntradayAlphaPolicy | IntradayAlphaPolicyV21
const ReplayPolicyOption = Schema.Literals(['v2', 'v2_1'])
const accountId = 'alpha-replay-verifier'
export { accountId as replayAccountId }
const cycleId = 'a'.repeat(64)
const v2PolicyHash = Result.getOrThrow(canonicalHashV1Result(v2Policy))
const observationHash = 'b'.repeat(64)
const snapshotId = 'c'.repeat(64)
const snapshotContentHash = 'd'.repeat(64)

// Hypothetical sell-side cost scenario; this is not an actual fee reconciliation.
const MODELED_SELL_FEE_BPS = 0.21

const parseBarsFiles = (paths: readonly string[], calendar: ReplayCalendar) => {
  const dedup = new Map<string, RawBar>()
  const sources: { readonly path: string; readonly sha256: string; readonly bytes: number }[] = []
  let identicalDuplicates = 0
  let ignoredSymbols = 0
  for (const filePath of paths) {
    const { content, source } = readReplayFile(filePath)
    sources.push(source)
    let lineNumber = 0
    for (const line of replayLines(content)) {
      lineNumber++
      if (line.length === 0) continue
      const cols = line.split('\t')
      const symbol = cols[0] ?? ''
      if (!allowedSymbols.has(symbol)) {
        ignoredSymbols++
        continue
      }
      if (cols.length < 8) throw new Error(`Incomplete bar in ${filePath}:${lineNumber}`)
      const rawAt = cols[1] ?? ''
      const eventMs = Date.parse(rawAt)
      if (!Number.isFinite(eventMs) || eventMs % 60_000 !== 0)
        throw new Error(`Invalid minute timestamp in ${filePath}:${lineNumber}`)
      const open = Number(cols[2])
      const high = Number(cols[3])
      const low = Number(cols[4])
      const close = Number(cols[5])
      const volume = Number(cols[6])
      const vwap = Number(cols[7])
      if (
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close) ||
        !Number.isFinite(volume) ||
        !Number.isFinite(vwap) ||
        volume <= 0 ||
        Math.min(open, high, low, close, vwap) <= 0 ||
        low > Math.min(open, close) ||
        high < Math.max(open, close) ||
        high < low
      )
        throw new Error(`Invalid OHLCV bar in ${filePath}:${lineNumber}`)
      const eventAt = utcInstantFromEpochMillis(eventMs)
      const bar = {
        symbol,
        eventAt,
        eventMs,
        open,
        high,
        low,
        close,
        volume,
        vwap,
      }
      const key = `${symbol}|${eventMs}`
      const prior = dedup.get(key)
      if (prior !== undefined) {
        if (JSON.stringify(prior) !== JSON.stringify(bar))
          throw new Error(`Conflicting revisions for ${symbol} ${eventAt}; supply an explicit source selection`)
        identicalDuplicates++
      } else dedup.set(key, bar)
    }
  }

  // Use the supplied provider calendar, including early closes; never infer a full session from a bar date.
  const byDate = new Map<string, Map<string, RawBar[]>>()
  const calendarBounds = new Map<string, { readonly openMs: number; readonly closeMs: number }>()
  for (const session of calendar.providerSessions) {
    calendarBounds.set(session.date, {
      openMs: Date.parse(session.regularOpenAt),
      closeMs: Date.parse(session.regularCloseAt),
    })
    byDate.set(session.date, new Map())
  }
  for (const bar of dedup.values()) {
    const dateKey = bar.eventAt.slice(0, 10)
    const bounds = calendarBounds.get(dateKey)
    if (bounds === undefined) throw new Error(`Bar date ${dateKey} is absent from the supplied provider calendar`)
    if (bar.eventMs < bounds.openMs || bar.eventMs >= bounds.closeMs) continue
    let symMap = byDate.get(dateKey)
    if (symMap === undefined) {
      symMap = new Map()
      byDate.set(dateKey, symMap)
    }
    let arr = symMap.get(bar.symbol)
    if (arr === undefined) {
      arr = []
      symMap.set(bar.symbol, arr)
    }
    arr.push(bar)
  }
  for (const symMap of byDate.values()) {
    for (const arr of symMap.values()) {
      arr.sort((a, b) => a.eventMs - b.eventMs)
    }
  }
  return { byDate, sources, identicalDuplicates, ignoredSymbols, uniqueBars: dedup.size }
}

export const makeShortEligibility = (observedAt: string): Readonly<Record<string, EquityShortEligibility>> =>
  Object.fromEntries(
    intradayAlphaCandidateSymbols.map((symbol) => [
      symbol,
      {
        schemaVersion: 'bayn.equity-short-eligibility.v1' as const,
        accountId,
        symbol,
        accountHash: 'a'.repeat(64),
        configurationHash: 'b'.repeat(64),
        assetHash: 'c'.repeat(64),
        accountObservedAt: observedAt,
        configurationObservedAt: observedAt,
        assetObservedAt: observedAt,
        accountActive: true,
        shortingEnabled: true,
        noShorting: false,
        assetActive: true,
        tradable: true,
        marginable: true,
        shortable: true,
        easyToBorrow: true,
      },
    ]),
  )

export const makeEntryPortfolio = (
  observedAt: string,
  equityUsd: number,
  activePositions: readonly ActiveSimulatedPosition[],
  barByMinute: Map<string, Map<number, RawBar>>,
  completedMinute: number,
  carriedMarks: ReadonlyMap<string, number>,
  initialBuyingPowerUsd?: number,
) => {
  const equityMicros = BigInt(Math.round(equityUsd * 1_000_000))
  // Hypothetical 4x margin account, matching the prior v2 scenario; this is not broker account evidence.
  let usedMarginMicros = 0n
  const positions = activePositions
    .toSorted((a, b) => a.symbol.localeCompare(b.symbol))
    .map((pos) => {
      const sign = pos.direction === 'LONG' ? 1n : -1n
      const qtyAtoms = sign * BigInt(pos.shares) * 1_000_000_000n
      const avgMicros = BigInt(Math.round(pos.entryPrice * 1_000_000))
      const markPrice = barByMinute.get(pos.symbol)?.get(completedMinute)?.close ?? carriedMarks.get(pos.symbol)
      if (markPrice === undefined) throw new Error(`Missing current mark for co-held ${pos.symbol}`)
      const markMicros = BigInt(Math.round(markPrice * 1_000_000))
      const costBasisMicros = sign * BigInt(pos.shares) * avgMicros
      const marketValueMicros = sign * BigInt(pos.shares) * markMicros
      const unrealizedPnlMicros = marketValueMicros - costBasisMicros
      usedMarginMicros += BigInt(pos.shares) * avgMicros
      return {
        schemaVersion: 'bayn.position.v2' as const,
        accountId,
        symbol: pos.symbol,
        quantityAtoms: qtyAtoms.toString(),
        averageEntryPriceMicros: avgMicros.toString(),
        costBasisMicros: costBasisMicros.toString(),
        marketPriceMicros: markMicros.toString(),
        marketValueMicros: marketValueMicros.toString(),
        unrealizedPnlMicros: unrealizedPnlMicros.toString(),
        observedAt,
      }
    })
  const initialBuyingPowerMicros =
    initialBuyingPowerUsd === undefined ? equityMicros * 4n : BigInt(Math.round(initialBuyingPowerUsd * 1_000_000))
  const buyingPowerMicros = initialBuyingPowerMicros - usedMarginMicros
  const material = {
    account: {
      schemaVersion: 'bayn.paper-account-snapshot.v2' as const,
      accountId,
      status: AccountStatus.Active,
      currency: 'USD' as const,
      cashMicros: equityMicros.toString(),
      buyingPowerMicros: (buyingPowerMicros > 0n ? buyingPowerMicros : 0n).toString(),
      equityMicros: equityMicros.toString(),
      cryptoFeeTier: null,
      observedAt,
    },
    positions,
    positionsObservedAt: observedAt,
    orders: [] as const,
    ordersObservedAt: observedAt,
    accountingHash: 'd'.repeat(64),
  }
  const stateHash = Result.getOrThrow(reconciledStateHash(material))
  const recMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [] as const,
    reconciledAt: observedAt,
  }
  const reconciliationId = Result.getOrThrow(canonicalHashV1Result(recMaterial))
  const contentHash = Result.getOrThrow(canonicalHashV1Result({ ...recMaterial, reconciliationId }))
  return Result.getOrThrow(
    decodeJevPortfolio({
      purpose: JevPurpose.Entry,
      concurrentDisjointPositions: true,
      brokerState: {
        ...material,
        unknownOrderCount: 0,
        reconciliation: { ...recMaterial, reconciliationId, contentHash },
      },
    }),
  )
}

export const buildReplaySnapshot = (input: {
  readonly sessionDate: string
  readonly calendar: ReturnType<typeof normalizeMarketCalendarResult> extends Result.Result<infer C, unknown>
    ? C
    : never
  readonly sessionOpenMs: number
  readonly rangeEndMs: number
  readonly symMap: Map<string, RawBar[]>
  readonly quoteModel: QuoteModel
}): StrategyMarketSnapshot => {
  const observedAtMs = input.rangeEndMs + protocol.decisionDelaySeconds * 1000
  const observedAt = utcInstantFromEpochMillis(observedAtMs)
  const rangeStartAt = utcInstantFromEpochMillis(input.sessionOpenMs)
  const rangeEndAt = utcInstantFromEpochMillis(input.rangeEndMs)
  const market = intradayAlphaEquityMarketProfile
  const bars: IntradayBar[] = []
  const latestQuotes: Record<string, IntradayQuote> = {}
  const quotes: IntradayQuote[] = []

  let barOffset = 0
  let quoteOffset = 0
  for (const [symbol, rawBars] of input.symMap.entries()) {
    let lastBar: RawBar | undefined
    for (const bar of rawBars) {
      if (bar.eventMs >= input.rangeEndMs) break
      lastBar = bar
      bars.push({
        provider: 'alpaca',
        universeId: market.universeId,
        universeSymbolHash: market.universeSymbolHash,
        marketSession: 'regular',
        schemaVersion: 1,
        channel: 'bars',
        final: true,
        symbol,
        eventAt: bar.eventAt,
        ingestedAt: utcInstantFromEpochMillis(bar.eventMs + 60_000),
        feed: market.feed,
        delayClass: market.delayClass,
        sourceTopic: market.sourceTopics.bars,
        sourcePartition: 0,
        sourceOffset: String(barOffset++),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        vwap: bar.vwap,
        tradeCount: '100',
      })
    }
    if (
      symbol !== intradayAlphaBenchmarkSymbol &&
      lastBar !== undefined &&
      lastBar.eventMs === input.rangeEndMs - 60_000
    ) {
      const observed = input.quoteModel.bySymbol?.get(symbol)?.get(lastBar.eventMs)
      if (input.quoteModel.bySymbol !== undefined && observed === undefined) continue
      const half = (lastBar.close * Math.max(1, input.quoteModel.slippageRtBps / 2)) / 10_000
      const bidPrice = observed?.lastBid ?? Number(Math.max(0.01, lastBar.close - half).toFixed(2))
      const askPrice = observed?.lastAsk ?? Number(Math.max(bidPrice + 0.01, lastBar.close + half).toFixed(2))
      // Aggregate rows do not retain event times. Last BBO belongs to the completed minute, never a later bucket.
      const quoteAt = utcInstantFromEpochMillis(observed === undefined ? observedAtMs - 1_000 : input.rangeEndMs - 1)
      const quote: IntradayQuote = {
        provider: 'alpaca',
        universeId: market.universeId,
        universeSymbolHash: market.universeSymbolHash,
        marketSession: 'regular',
        schemaVersion: 1,
        symbol,
        eventAt: quoteAt,
        ingestedAt: quoteAt,
        feed: market.feed,
        delayClass: market.delayClass,
        sourceTopic: market.sourceTopics.quotes,
        sourcePartition: 0,
        sourceOffset: String(quoteOffset++),
        bidPrice,
        bidSize: 10_000,
        askPrice,
        askSize: 10_000,
      }
      latestQuotes[symbol] = quote
      quotes.push(quote)
    }
  }

  return {
    manifest: {
      schemaVersion: 'bayn.streaming-market-snapshot.v1',
      snapshotId,
      contentHash: snapshotContentHash,
      sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(input.sessionDate),
      calendar: input.calendar,
      observedAt,
      rangeStartAt,
      rangeEndAt,
      universeId: market.universeId,
      universeSymbolHash: market.universeSymbolHash,
      universe: market.universe,
      symbols: [...allowedSymbols].sort(),
      candidateSymbols: [...intradayAlphaCandidateSymbols],
      candidateEvidencePolicy: IntradayCandidateEvidencePolicy.MarketQuotesV2,
      benchmarkEvidencePolicy: IntradayBenchmarkEvidencePolicy.CompletedBars,
      benchmarkSymbols: [intradayAlphaBenchmarkSymbol],
      feed: market.feed,
      delayClass: market.delayClass,
      sourceTopics: market.sourceTopics,
      maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
      minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1000,
      barCount: bars.length,
      quoteCount: quotes.length,
      tradeCount: 0,
      streaming: {
        consumerEpoch: 'replay',
        consumerSequence: bars.length + quotes.length,
        sourceWatermarks: [],
        features: [],
      },
    },
    bars,
    quotes,
    trades: [],
    latestQuotes,
  } as unknown as StrategyMarketSnapshot
}

export const buildSessionSummaries = (
  byDate: Map<string, Map<string, RawBar[]>>,
  sessions: readonly string[],
  calendar: ReplayCalendar,
): {
  readonly dailyByDate: Map<string, PriorSessionDailySummary[]>
  readonly checkpointsByDate: Map<string, PriorSessionCheckpointSummary[]>
} => {
  const dailyByDate = new Map<string, PriorSessionDailySummary[]>()
  const checkpointsByDate = new Map<string, PriorSessionCheckpointSummary[]>()
  const noiseSet = new Set<string>(v2Policy.noiseAreaSymbols)

  for (const date of sessions) {
    const isoDate = Schema.decodeUnknownSync(IsoDateSchema)(date)
    const regular = Result.getOrThrow(resolveAlphaRegularSession(calendar, date))
    const openMs = regular.openMs
    const regularMinutes = Math.floor((regular.closeMs - regular.openMs) / 60_000)
    const symMap = byDate.get(date)
    if (symMap === undefined) continue

    const dailies: PriorSessionDailySummary[] = []
    const checkpoints: PriorSessionCheckpointSummary[] = []

    for (const [symbol, bars] of symMap.entries()) {
      if (symbol === intradayAlphaBenchmarkSymbol || bars.length < 200) continue
      const first = bars[0]
      const last = bars.at(-1)
      if (first === undefined || last === undefined) continue
      let high = Number.NEGATIVE_INFINITY
      let low = Number.POSITIVE_INFINITY
      for (const bar of bars) {
        if (bar.high > high) high = bar.high
        if (bar.low < low) low = bar.low
      }
      dailies.push({ symbol, sessionDate: isoDate, open: first.open, high, low, close: last.close })

      if (noiseSet.has(symbol)) {
        for (const cp of noiseAreaCheckpointMinutes) {
          if (cp > regularMinutes) continue
          let cpClose: number | undefined
          for (const bar of bars) {
            const m = Math.floor((bar.eventMs - openMs) / 60_000)
            if (m < cp) cpClose = bar.close
            else break
          }
          if (cpClose !== undefined) {
            checkpoints.push({ symbol, sessionDate: isoDate, minuteFromOpen: cp, close: cpClose })
          }
        }
      }
    }
    dailyByDate.set(date, dailies)
    checkpointsByDate.set(date, checkpoints)
  }
  return { dailyByDate, checkpointsByDate }
}

export const planReplayTargets = (input: {
  readonly sessionDate: string
  readonly selectedSymbols: readonly string[]
  readonly completedBar: (symbol: string) => Pick<RawBar, 'close'> | undefined
  readonly portfolio: ReturnType<typeof makeEntryPortfolio>
  readonly targetWeights: Record<string, number>
  readonly maxBuy: Record<string, string>
  readonly maxSell: Record<string, string>
  readonly eligibility: Readonly<Record<string, EquityShortEligibility>>
  readonly observedAt: string
  readonly orderExpiresAt: string
  readonly disjoint: boolean
  readonly policyHash?: string
}) => {
  const { selectedSymbols, portfolio, targetWeights, maxBuy, maxSell, eligibility, observedAt } = input
  // Exercise actual production target-planner (planTargets) with bar-close reference prices (matching compileJevEntry)
  const priceMicros: Record<string, string> = {}
  const bidPriceMicros: Record<string, string> = {}
  const askPriceMicros: Record<string, string> = {}
  // compileJevEntry plans only nonzero targets and requires their exact completed bar.
  // Missing-current-minute candidates are excluded by production signal/funding checks;
  // do not fabricate references from the first (possibly future) bar or a constant.
  for (const symbol of selectedSymbols) {
    const completedBar = input.completedBar(symbol)
    if (completedBar === undefined) throw new Error(`Selected alpha target ${symbol} lacks completed bar close`)
    bidPriceMicros[symbol] = quantizeInstrumentPriceMicros(
      symbol,
      Result.getOrThrow(priceNumberToMicros(completedBar.close, 'bar close', 'DOWN')),
      'DOWN',
    ).toString()
    askPriceMicros[symbol] = quantizeInstrumentPriceMicros(
      symbol,
      Result.getOrThrow(priceNumberToMicros(completedBar.close, 'bar close', 'UP')),
      'UP',
    ).toString()
    priceMicros[symbol] = askPriceMicros[symbol]
  }
  const refMaterial = {
    schemaVersion: 'bayn.intraday-snapshot-reference-prices.v1' as const,
    snapshotId,
    snapshotContentHash,
    priceReference: 'verified-adverse-quote-boundary' as const,
    signalDate: Schema.decodeUnknownSync(IsoDateSchema)(input.sessionDate),
    observedAt,
    priceMicros,
    bidPriceMicros,
    askPriceMicros,
  }
  const refHash = Result.getOrThrow(canonicalHashV1Result(refMaterial))
  const shortEntries = Object.fromEntries(
    selectedSymbols
      .filter((s) => (targetWeights[s] ?? 0) < 0)
      .map((s) => [s, eligibility[s]])
      .filter((entry): entry is [string, EquityShortEligibility] => entry[1] !== undefined),
  )
  return Result.getOrThrow(
    planTargets({
      schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
      strategyName: 'jev',
      cycleId,
      decisionHash: 'e'.repeat(64),
      policyHash: input.policyHash ?? v2PolicyHash,
      accountId,
      signalDate: Schema.decodeUnknownSync(IsoDateSchema)(input.sessionDate),
      targetWeights,
      referencePrices: { ...refMaterial, contentHash: refHash },
      brokerState: portfolio.brokerState,
      precision: protocol.executionModel.precision,
      allocationCapitalMicros: portfolio.brokerState.account.equityMicros,
      maximumInputAgeMs: 60_000,
      submissionCutoffAt: input.orderExpiresAt,
      observedAt,
      executionTerms: {
        ...(input.disjoint ? { executionPurpose: 'disjoint-entry' as const } : {}),
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        priceReference: 'verified-adverse-quote-boundary',
        snapshotId,
        snapshotContentHash,
        maximumBuyQuantityAtoms: maxBuy,
        maximumSellQuantityAtoms: maxSell,
        ...(Object.keys(shortEntries).length > 0 ? { equityShortEntries: shortEntries } : {}),
      },
    }),
  )
}

const simulateSession = (input: {
  readonly policy: ReplayPolicy
  readonly policyHash: string
  readonly sessionDate: string
  readonly calendar: ReplayCalendar
  readonly trailingBaseline: IntradayAlphaTrailingBaseline
  readonly symMap: Map<string, RawBar[]>
  readonly quoteModel: QuoteModel
  readonly carryCoHeldMarks?: boolean
  readonly startingCapitalUsd: number
}): {
  readonly trades: readonly TradeOutcome[]
  readonly plannerBlocks: number
  readonly attempts: readonly EntryAttempt[]
  readonly unresolvedExits: readonly UnresolvedExit[]
  readonly expectedRegularMinutes: number
  readonly benchmarkMinutes: number
  readonly requiredBenchmarkCheckpoints: number
  readonly unavailableBenchmarkCheckpoints: readonly UnavailableBenchmarkCheckpoint[]
  readonly ambiguousExitBars: number
  readonly stopLimitGapBars: number
  readonly concurrentOverlaps: number
  readonly missingConcurrentMarkWindows: number
  readonly coHeldMarkGaps: readonly CoHeldMarkGap[]
  readonly l1ExecutionGaps: readonly L1ExecutionGap[]
  readonly consideredSymbols: ReadonlySet<string>
  readonly decisionQuoteSymbols: ReadonlySet<string>
  readonly maximumConcurrentLegs: number
  readonly maximumConcurrentGrossEntryNotionalUsd: number
} => {
  const { policy } = input
  const regular = Result.getOrThrow(resolveAlphaRegularSession(input.calendar, input.sessionDate))
  const sessionOpenMs = regular.openMs
  const expectedRegularMinutes = (regular.closeMs - sessionOpenMs) / 60_000
  const spyBars = input.symMap.get(intradayAlphaBenchmarkSymbol) ?? []

  // Index bars per symbol by minuteFromOpen for O(1) execution fill simulation
  const barByMinute = new Map<string, Map<number, RawBar>>()
  for (const [symbol, bars] of input.symMap.entries()) {
    const m = new Map<number, RawBar>()
    for (const bar of bars) {
      const minute = Math.floor((bar.eventMs - sessionOpenMs) / 60_000)
      m.set(minute, bar)
    }
    barByMinute.set(symbol, m)
  }

  const trades: TradeOutcome[] = []
  const attempts: EntryAttempt[] = []
  const unresolvedExits: UnresolvedExit[] = []
  let requiredBenchmarkCheckpoints = 0
  const unavailableBenchmarkCheckpoints: UnavailableBenchmarkCheckpoint[] = []
  let ambiguousExitBars = 0
  let stopLimitGapBars = 0
  let plannerBlocks = 0
  const morningOrbTakenSymbols: string[] = []
  let middayCompleted = false
  const noiseAreaTakenSymbols: string[] = []
  let activePositions: ActiveSimulatedPosition[] = []
  let concurrentOverlaps = 0
  let missingConcurrentMarkWindows = 0
  const coHeldMarkGaps: CoHeldMarkGap[] = []
  const l1ExecutionGaps: L1ExecutionGap[] = []
  const consideredSymbols = new Set<string>()
  const decisionQuoteSymbols = new Set<string>()
  let maximumConcurrentLegs = 0
  let maximumConcurrentGrossEntryNotionalUsd = 0
  let pendingAttemptUntilMs = 0

  const runEntryAtMinute = (completedMinute: number) => {
    const decisionMs = sessionOpenMs + (completedMinute + 1) * 60_000 + protocol.decisionDelaySeconds * 1_000
    // Serialize decisions until the preceding entry working window resolves. Future fill outcomes
    // must not contribute inventory, occupancy or account headroom to an earlier decision.
    if (decisionMs < pendingAttemptUntilMs) return
    activePositions = activePositions
      .filter((position) => position.exitMinute > completedMinute)
      .map((position) => {
        if (position.trim === undefined || position.trim.minute > completedMinute) return position
        const { trim, ...rest } = position
        return { ...rest, shares: position.shares - trim.shares }
      })
    if (activePositions.some((position) => sessionOpenMs + position.entryMinute * 60_000 > decisionMs))
      throw new Error('Replay cannot plan against inventory whose modeled fill is still in the future')
    const occupiedSymbols = activePositions.map((position) => position.symbol).sort()
    const rangeEndMs = sessionOpenMs + (completedMinute + 1) * 60_000
    const snapshot = buildReplaySnapshot({
      sessionDate: input.sessionDate,
      calendar: input.calendar,
      sessionOpenMs,
      rangeEndMs,
      symMap: input.symMap,
      quoteModel: input.quoteModel,
    })
    const observedAt = snapshot.manifest.observedAt
    const orderExpiresAtMs = Date.parse(observedAt) + 60_000
    const eligibility = makeShortEligibility(observedAt)
    const extracted = Result.getOrThrow(
      extractIntradayAlphaCandidates({
        snapshot,
        policy,
        trailingBaseline: input.trailingBaseline,
        occupiedSymbols,
        noiseAreaTakenSymbols,
        accountId,
        equityShortEligibility: eligibility,
        morningOrbTakenSymbols,
        middayReversionCompleted: middayCompleted,
      }),
    )
    if (extracted.context.phase === IntradayAlphaPhase.OutsideWindow) return
    requiredBenchmarkCheckpoints++
    if (input.quoteModel.bySymbol !== undefined)
      for (const symbol of Object.keys(snapshot.latestQuotes)) decisionQuoteSymbols.add(symbol)
    // Use the production extractor's readiness result, not a daily bar-count threshold.
    // A finite zero deviation is valid; null means the exact completed benchmark/VWAP is unavailable.
    if (extracted.spyVwapDevBps === null) {
      unavailableBenchmarkCheckpoints.push({
        phase: extracted.context.phase,
        observedAt,
        expectedBarAt: utcInstantFromEpochMillis(rangeEndMs - 60_000),
      })
      return
    }
    for (const candidate of [...extracted.longPool, ...extracted.shortPool]) consideredSymbols.add(candidate.symbol)
    const legs = selectIntradayAlphaLegs({
      context: extracted.context,
      policy,
      longPool: extracted.longPool,
      shortPool: extracted.shortPool,
      vetoedSymbols: new Set(),
    })
    if (legs.length === 0) return

    // Report every missing exact co-held mark at this checkpoint without filling it in the strict path.
    const carriedMarks = new Map<string, number>()
    let blockedForMark = false
    for (const { symbol } of activePositions) {
      const marks = barByMinute.get(symbol)
      if (marks?.has(completedMinute) === true) continue
      const expectedMs = rangeEndMs - 60_000
      const prior = input.symMap.get(symbol)?.findLast((bar) => bar.eventMs < expectedMs)
      const ageMinutes = prior === undefined ? null : (expectedMs - prior.eventMs) / 60_000
      const carried =
        input.carryCoHeldMarks === true &&
        prior !== undefined &&
        ageMinutes !== null &&
        ageMinutes <= carryForwardMinutes
      coHeldMarkGaps.push({
        symbol,
        phase: extracted.context.phase,
        observedAt,
        expectedBarAt: utcInstantFromEpochMillis(expectedMs),
        lastPriorBarAt: prior?.eventAt ?? null,
        ageMinutes,
        carried,
      })
      if (carried) carriedMarks.set(symbol, prior.close)
      else blockedForMark = true
    }
    if (blockedForMark) {
      missingConcurrentMarkWindows++
      return
    }
    const portfolio = makeEntryPortfolio(
      observedAt,
      input.startingCapitalUsd,
      activePositions,
      barByMinute,
      completedMinute,
      carriedMarks,
    )
    const fundedPlans: Record<
      string,
      NonNullable<Result.Result.Success<ReturnType<typeof makeIntradayAlphaFundedExitPlan>>>
    > = {}
    const targetWeights: Record<string, number> = {}
    const maxBuy: Record<string, string> = {}
    const maxSell: Record<string, string> = {}

    for (const leg of legs) {
      if (occupiedSymbols.includes(leg.symbol)) continue
      const funded = Result.getOrThrow(
        makeIntradayAlphaFundedExitPlan({
          policy,
          observation: {
            snapshot,
            portfolio,
            observedAt,
            contentHash: observationHash,
            trailingBaseline: input.trailingBaseline,
          },
          leg,
        }),
      )
      if (funded === null) continue
      fundedPlans[leg.symbol] = funded
      targetWeights[leg.symbol] = funded.signedWeight
      maxBuy[leg.symbol] = '0'
      maxSell[leg.symbol] = '0'
      if (leg.direction === 'LONG') maxBuy[leg.symbol] = funded.plan.maximumQuantityAtoms
      else maxSell[leg.symbol] = funded.plan.maximumQuantityAtoms
    }
    const fundedSymbols = Object.keys(fundedPlans)
    const selectedSymbols = (
      policy.schemaVersion === 'bayn.intraday-alpha-policy.v2_1' &&
      extracted.context.phase === IntradayAlphaPhase.MiddayReversion
        ? balancedFundedMiddaySymbols(fundedSymbols, targetWeights)
        : fundedSymbols
    ).toSorted()
    for (const symbol of fundedSymbols) {
      if (selectedSymbols.includes(symbol)) continue
      delete targetWeights[symbol]
      delete maxBuy[symbol]
      delete maxSell[symbol]
    }
    if (selectedSymbols.length === 0) return

    const planned = planReplayTargets({
      sessionDate: input.sessionDate,
      selectedSymbols,
      completedBar: (symbol) => barByMinute.get(symbol)?.get(completedMinute),
      portfolio,
      targetWeights,
      maxBuy,
      maxSell,
      eligibility,
      observedAt,
      orderExpiresAt: utcInstantFromEpochMillis(orderExpiresAtMs),
      disjoint: activePositions.length > 0,
      policyHash: input.policyHash,
    })
    if (
      planned.status !== TargetPlanStatus.Planned ||
      (extracted.context.phase === IntradayAlphaPhase.MiddayReversion &&
        !isBalancedMiddayBasket(planned, selectedSymbols))
    ) {
      plannerBlocks++
      return
    }

    const phase = extracted.context.phase as ActiveAlphaPhase
    if (activePositions.length > 0) concurrentOverlaps++
    const flattenMinute =
      phase === IntradayAlphaPhase.NoiseAreaTrend
        ? policy.noiseArea.flattenMinuteFromOpen
        : phase === IntradayAlphaPhase.MorningOrb
          ? policy.morningOrb.hardExitMinuteFromOpen
          : policy.middayReversion.flattenMinuteFromOpen
    const minimumCloseLeadMinutes =
      phase === IntradayAlphaPhase.NoiseAreaTrend
        ? Math.max(1, 390 - policy.noiseArea.flattenMinuteFromOpen)
        : protocol.flattenBeforeCloseMinutes
    // Match v2 closeWindowForCycle: absolute phase deadline plus actual regular-close cap.
    const flattenMs = Math.min(
      sessionOpenMs + flattenMinute * 60_000,
      regular.closeMs - minimumCloseLeadMinutes * 60_000,
    )
    const attempt: EntryAttempt = {
      phase,
      observedAt,
      orderExpiresAt: utcInstantFromEpochMillis(orderExpiresAtMs),
      occupiedSymbols,
      selectedSymbols,
      filledSymbols: [],
      longEntryNotionalUsd: 0,
      shortEntryNotionalUsd: 0,
    }
    attempts.push(attempt)
    pendingAttemptUntilMs = orderExpiresAtMs
    // Production session history counts committed decisions with intents, including unfilled/expired orders.
    if (phase === IntradayAlphaPhase.MorningOrb) morningOrbTakenSymbols.push(...selectedSymbols)
    else if (phase === IntradayAlphaPhase.NoiseAreaTrend) noiseAreaTakenSymbols.push(...selectedSymbols)
    else middayCompleted = true

    const entryMinute = Math.ceil((Date.parse(observedAt) - sessionOpenMs) / 60_000)
    const perSideSlipMult = input.quoteModel.slippageRtBps / 2 / 10_000
    const l1 = input.quoteModel.bySymbol !== undefined
    const entries = planned.intentTargets.flatMap((intent) => {
      const funded = fundedPlans[intent.symbol]
      if (funded === undefined) return []
      const symBars = barByMinute.get(intent.symbol)
      const quotes = input.quoteModel.bySymbol?.get(intent.symbol)
      const isLong = intent.side === OrderSide.Buy
      const shares = BigInt(intent.quantityAtoms) / quantityScale
      if (shares <= 0n) return []
      const levels = funded.plan.levels
      const limitPrice =
        Number('maximumEntryPriceMicros' in levels ? levels.maximumEntryPriceMicros : levels.minimumEntryPriceMicros) /
        1_000_000
      // Minute bars cannot establish the time or queue priority of an intrabar touch.
      // A post-decision open within the working window is our conservative executable-price proxy.
      let fill: { readonly minute: number; readonly price: number } | undefined
      let entryGap: L1ExecutionGap | undefined
      for (let minute = entryMinute; sessionOpenMs + minute * 60_000 < orderExpiresAtMs; minute++) {
        const bar = symBars?.get(minute)
        if (bar === undefined) continue
        const quote = quotes?.get(bar.eventMs)
        if (l1 && quote === undefined) {
          entryGap = { symbol: intent.symbol, minuteAt: bar.eventAt, stage: 'ENTRY' }
          break
        }
        const price =
          quote === undefined
            ? bar.open * (isLong ? 1 + perSideSlipMult : 1 - perSideSlipMult)
            : isLong
              ? quote.firstAsk
              : quote.firstBid
        if (isLong ? price <= limitPrice : price >= limitPrice) {
          fill = { minute, price }
          break
        }
      }
      if (fill !== undefined) {
        attempt.filledSymbols.push(intent.symbol)
        if (isLong) attempt.longEntryNotionalUsd += fill.price * Number(shares)
        else attempt.shortEntryNotionalUsd += fill.price * Number(shares)
      }
      return [{ symbol: intent.symbol, shares, isLong, levels, symBars, quotes, fill, entryGap }]
    })

    const resolveExit = (
      entry: (typeof entries)[number],
      fill: NonNullable<(typeof entries)[number]['fill']>,
      window: { readonly start: number; readonly end: number; readonly triggered: boolean },
    ) => {
      const { levels, symbol, isLong, symBars, quotes } = entry
      const stopPrice = Number(levels.stopPriceMicros) / 1_000_000
      const stopLimitPrice = Number(levels.stopLimitPriceMicros) / 1_000_000
      const targetPrice = Number(levels.profitLimitPriceMicros) / 1_000_000
      // Holding duration starts at first fill; both policies enforce the absolute phase deadline.
      const phaseHoldMinute = fill.minute + levels.maximumHoldingMinutes
      const exitDueMs = Math.min(sessionOpenMs + phaseHoldMinute * 60_000, flattenMs)

      let exitPrice: number | undefined
      let exitMinute = expectedRegularMinutes
      let exitReason: TradeOutcome['exitReason'] = exitDueMs === flattenMs ? 'EOD' : 'MAX_HOLD'

      let missingExitQuote = false
      let stopTriggered = window.triggered
      const clearsStopLimit = (price: number) => (isLong ? price >= stopLimitPrice : price <= stopLimitPrice)
      for (let m = window.start; m < window.end; m++) {
        const bar = symBars?.get(m)
        if (bar === undefined) continue
        const quote = quotes?.get(bar.eventMs)
        if (l1 && quote === undefined) {
          l1ExecutionGaps.push({ symbol, minuteAt: bar.eventAt, stage: 'EXIT' })
          missingExitQuote = true
          break
        }
        const exitOpen = quote === undefined ? bar.open : isLong ? quote.firstBid : quote.firstAsk
        // For intraminute touches, apply the first observed half-spread ratio to the trade-bar proxy.
        // No quote extrema or relative ordering are available; the underlying trade-bar stop trigger is unchanged.
        const executable = (price: number) =>
          quote === undefined ? price : price * (exitOpen / ((quote.firstBid + quote.firstAsk) / 2))
        // A bar close before the deadline cannot prove an exit. Use a subsequent open, strictly after
        // the close/hold decision, so the price proxy cannot precede the order it purports to fill.
        if (bar.eventMs > exitDueMs) {
          exitPrice = exitOpen
          exitMinute = m
          break
        }
        const openedThroughStop = isLong ? bar.open <= stopPrice : bar.open >= stopPrice
        const touchedStop = isLong ? bar.low <= stopPrice : bar.high >= stopPrice
        const touchedTarget = isLong ? executable(bar.high) >= targetPrice : executable(bar.low) <= targetPrice
        if (!stopTriggered && touchedStop && touchedTarget) ambiguousExitBars++
        if (stopTriggered || touchedStop) {
          // After activation, a gap through the limit leaves a working order. Use the open only
          // when activation is already known, otherwise require an executable price after the trigger.
          const activeAtOpen = stopTriggered || openedThroughStop
          stopTriggered = true
          if (activeAtOpen && clearsStopLimit(exitOpen)) {
            exitPrice = exitOpen
          } else if (
            clearsStopLimit(executable(activeAtOpen ? (isLong ? bar.high : bar.low) : bar.close)) ||
            clearsStopLimit(executable(isLong ? bar.low : bar.high))
          ) {
            exitPrice = stopLimitPrice
          } else {
            stopLimitGapBars++
            continue
          }
          exitReason = 'STOP'
          exitMinute = m
          break
        }
        if (touchedTarget) {
          exitPrice = isLong ? Math.max(exitOpen, targetPrice) : Math.min(exitOpen, targetPrice)
          exitReason = 'TARGET'
          exitMinute = m
          break
        }
      }
      return { exitPrice, exitMinute, exitReason, exitDueMs, missingExitQuote, stopTriggered }
    }

    const recordExit = (
      entry: (typeof entries)[number],
      fill: NonNullable<(typeof entries)[number]['fill']>,
      shares: number,
      exitPrice: number,
      exitMinute: number,
      exitReason: TradeOutcome['exitReason'],
    ) => {
      const { isLong, symbol } = entry
      const entryPrice = fill.price
      const stopLimitPrice = Number(entry.levels.stopLimitPriceMicros) / 1_000_000
      const exitSlipMult = exitReason === 'TARGET' ? 0 : perSideSlipMult
      const slippedExit = isLong ? exitPrice * (1 - exitSlipMult) : exitPrice * (1 + exitSlipMult)
      const realizedExit =
        exitReason === 'STOP'
          ? isLong
            ? Math.max(stopLimitPrice, slippedExit)
            : Math.min(stopLimitPrice, slippedExit)
          : slippedExit
      const grossPnlUsd = isLong ? (realizedExit - entryPrice) * shares : (entryPrice - realizedExit) * shares
      const sellNotional = isLong ? realizedExit * shares : entryPrice * shares
      const feeUsd = (sellNotional * MODELED_SELL_FEE_BPS) / 10_000
      const netPnlUsd = grossPnlUsd - feeUsd
      trades.push({
        sessionDate: input.sessionDate,
        phase,
        symbol,
        direction: isLong ? 'LONG' : 'SHORT',
        shares,
        entryPrice,
        exitPrice: realizedExit,
        entryAt: utcInstantFromEpochMillis(sessionOpenMs + fill.minute * 60_000),
        exitAt: utcInstantFromEpochMillis(sessionOpenMs + exitMinute * 60_000),
        exitReason,
        grossPnlUsd,
        netPnlUsd,
      })
    }

    const protectPartialBasket =
      policy.schemaVersion === 'bayn.intraday-alpha-policy.v2_1' &&
      phase === IntradayAlphaPhase.MiddayReversion &&
      entries.length === policy.middayReversion.targetPairs * 2 &&
      attempt.filledSymbols.length > 0 &&
      attempt.filledSymbols.length < entries.length
    // The working window must resolve before any trim. Use the first open strictly after expiry,
    // with protection already exercised on earlier bars. Never use the fill bar's open for a trim.
    const guardMinute = Math.floor((orderExpiresAtMs - sessionOpenMs) / 60_000) + 1
    const earlyExits = new Map<string, ReturnType<typeof resolveExit>>()
    const trims = new Map<string, { readonly shares: number; readonly executable: number }>()
    let missingResidualEvidence = false
    if (protectPartialBasket) {
      const marks = new Map<string, number>()
      missingResidualEvidence = entries.some((entry) => entry.entryGap !== undefined)
      const legs = entries.map((entry) => {
        const { fill, symbol, isLong } = entry
        const early =
          fill === undefined
            ? undefined
            : resolveExit(entry, fill, { start: fill.minute, end: guardMinute, triggered: false })
        if (early !== undefined) earlyExits.set(symbol, early)
        const openShares = fill !== undefined && early?.exitPrice === undefined ? entry.shares : 0n
        const bar = entry.symBars?.get(guardMinute)
        const quote = bar === undefined ? undefined : entry.quotes?.get(bar.eventMs)
        const mark = quote === undefined ? bar?.open : (quote.firstBid + quote.firstAsk) / 2
        if (openShares > 0n) {
          if (mark === undefined || (l1 && quote === undefined) || early?.missingExitQuote === true)
            missingResidualEvidence = true
          else marks.set(symbol, quote === undefined ? mark : isLong ? quote.firstBid : quote.firstAsk)
        }
        return {
          symbol,
          direction: isLong ? ('LONG' as const) : ('SHORT' as const),
          intendedShares: entry.shares,
          filledShares: fill === undefined ? 0n : entry.shares,
          openShares,
          workingEntry: false,
          markPriceMicros: mark === undefined ? null : Result.getOrThrow(numberToMicros(mark, 'residual mark')),
        }
      })
      const guardAt = utcInstantFromEpochMillis(sessionOpenMs + guardMinute * 60_000)
      if (missingResidualEvidence) attempt.residualProtection = { observedAt: guardAt, status: 'EVIDENCE_UNAVAILABLE' }
      else {
        const plan = Result.getOrThrow(evaluateMiddayResidualProtection(legs))
        if (plan.action !== 'NO_TRIM' && plan.action !== 'TRIM_REDUCE_ONLY')
          throw new Error('Partial replay basket is not terminal at the residual checkpoint')
        for (const trim of plan.trims) {
          const executable = marks.get(trim.symbol)
          if (executable === undefined) throw new Error(`Residual trim for ${trim.symbol} lacks an executable price`)
          trims.set(trim.symbol, { shares: Number(trim.shares), executable })
        }
        attempt.residualProtection = {
          observedAt: guardAt,
          status: 'MODELED',
          signedNotionalMicros: plan.exposure.signedNotionalMicros.toString(),
          modeledSignedNotionalAfterTrimMicros: plan.modeledSignedNotionalAfterTrimMicros.toString(),
          trims: plan.trims.map(({ symbol, shares }) => ({ symbol, shares: Number(shares) })),
        }
      }
    }

    for (const entry of entries) {
      const { fill, isLong, symbol, levels } = entry
      if (entry.entryGap !== undefined) l1ExecutionGaps.push(entry.entryGap)
      if (fill === undefined) continue
      const early = earlyExits.get(symbol)
      let shares = Number(entry.shares)
      const trim = trims.get(symbol)
      if (trim !== undefined) {
        recordExit(entry, fill, trim.shares, trim.executable, guardMinute, 'MIDDAY_RESIDUAL_TRIM')
        shares -= trim.shares
      }
      const exit =
        early !== undefined && (early.exitPrice !== undefined || early.missingExitQuote || missingResidualEvidence)
          ? early
          : shares === 0
            ? undefined
            : resolveExit(entry, fill, {
                start: early === undefined ? fill.minute : guardMinute,
                end: expectedRegularMinutes,
                triggered: early?.stopTriggered ?? false,
              })
      if (shares > 0 && exit?.exitPrice === undefined) {
        unresolvedExits.push({
          symbol,
          entryAt: utcInstantFromEpochMillis(sessionOpenMs + fill.minute * 60_000),
          exitDueAt: utcInstantFromEpochMillis(
            missingResidualEvidence ? sessionOpenMs + guardMinute * 60_000 : (exit?.exitDueMs ?? flattenMs),
          ),
          reason: missingResidualEvidence
            ? 'MIDDAY_RESIDUAL_EVIDENCE_UNAVAILABLE'
            : exit?.missingExitQuote === true
              ? 'L1_EXIT_MINUTE_UNAVAILABLE'
              : 'POST_DEADLINE_PRICE_UNAVAILABLE',
        })
        continue
      }
      if (exit?.exitPrice !== undefined)
        recordExit(entry, fill, shares, exit.exitPrice, exit.exitMinute, exit.exitReason)
      activePositions.push({
        phase,
        symbol,
        direction: isLong ? 'LONG' : 'SHORT',
        shares: Number(entry.shares),
        entryPrice: fill.price,
        entryMinute: fill.minute,
        exitMinute: exit?.exitMinute ?? guardMinute,
        ...(trim === undefined ? {} : { trim: { minute: guardMinute, shares: trim.shares } }),
        stopPriceMicros: levels.stopPriceMicros,
        stopLimitPriceMicros: levels.stopLimitPriceMicros,
        profitLimitPriceMicros: levels.profitLimitPriceMicros,
      })
      maximumConcurrentLegs = Math.max(maximumConcurrentLegs, activePositions.length)
      maximumConcurrentGrossEntryNotionalUsd = Math.max(
        maximumConcurrentGrossEntryNotionalUsd,
        activePositions.reduce((sum, position) => sum + position.shares * position.entryPrice, 0),
      )
    }
  }

  // Scan each policy checkpoint, allowing disjoint sleeves to coexist.
  const lastMinute = Math.min(
    expectedRegularMinutes - 1,
    Math.max(
      policy.middayReversion.entryEndMinuteFromOpen,
      ...policy.noiseArea.checkpointMinutesFromOpen.map((m) => m - 1),
    ),
  )
  for (let minute = policy.morningOrb.entryStartMinuteFromOpen; minute <= lastMinute; minute++) {
    // An unobserved eligible decision could change quotas, occupancy and headroom. Retain already
    // modeled positions/exits, but do not invent a later entry path after the first unavailable observation.
    if (
      unresolvedExits.length > 0 ||
      unavailableBenchmarkCheckpoints.length > 0 ||
      missingConcurrentMarkWindows > 0 ||
      l1ExecutionGaps.length > 0
    )
      break
    const noiseCheckpoint = policy.noiseArea.checkpointMinutesFromOpen.includes(minute + 1)
    const morningCheckpoint =
      minute <= policy.morningOrb.entryEndMinuteFromOpen &&
      morningOrbTakenSymbols.length < policy.morningOrb.maxTradesPerSession
    const middayCheckpoint =
      !middayCompleted &&
      minute >= policy.middayReversion.entryStartMinuteFromOpen &&
      minute <= policy.middayReversion.entryEndMinuteFromOpen
    if (noiseCheckpoint || morningCheckpoint || middayCheckpoint) runEntryAtMinute(minute)
  }

  return {
    trades,
    plannerBlocks,
    attempts,
    unresolvedExits,
    expectedRegularMinutes,
    benchmarkMinutes: spyBars.length,
    requiredBenchmarkCheckpoints,
    unavailableBenchmarkCheckpoints,
    ambiguousExitBars,
    stopLimitGapBars,
    concurrentOverlaps,
    missingConcurrentMarkWindows,
    coHeldMarkGaps,
    l1ExecutionGaps,
    consideredSymbols,
    decisionQuoteSymbols,
    maximumConcurrentLegs,
    maximumConcurrentGrossEntryNotionalUsd,
  }
}

interface ReplayOptions {
  readonly policy?: string
  readonly evaluationStart?: string
  readonly evaluationEnd?: string
  readonly quotes?: string
  readonly splits?: string
}

export const runIntradayAlphaReplayVerification = (
  paths: readonly string[],
  calendarInput: unknown,
  options: ReplayOptions = {},
) => {
  if (paths.length === 0) throw new Error('At least one bar file is required')
  const selection = Schema.decodeUnknownSync(ReplayPolicyOption)(options.policy ?? 'v2')
  const policy = selection === 'v2_1' ? Result.getOrThrow(makeIntradayAlphaPolicyV21(protocol)) : v2Policy
  const policyHash = selection === 'v2_1' ? Result.getOrThrow(canonicalHashV1Result(policy)) : v2PolicyHash
  const calendarSource = Schema.decodeUnknownSync(ReplayCalendarSchema, strictParseOptions)(calendarInput)
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      calendarSource.response.map((day) => ({
        ...day,
        session_open: day.session_open ?? day.open.replace(':', ''),
        session_close: day.session_close ?? day.close.replace(':', ''),
      })),
      calendarSource.query,
    ),
  )
  if (calendar.sessions.length === 0) throw new Error('The supplied calendar contains no sessions')
  const { byDate, sources, identicalDuplicates, ignoredSymbols, uniqueBars } = parseBarsFiles(paths, calendar)
  const historySessions = [...byDate.keys()].sort()
  const evaluationStart =
    options.evaluationStart === undefined
      ? historySessions[0]
      : Schema.decodeUnknownSync(IsoDateSchema)(options.evaluationStart)
  const evaluationEnd =
    options.evaluationEnd === undefined
      ? historySessions.at(-1)
      : Schema.decodeUnknownSync(IsoDateSchema)(options.evaluationEnd)
  const sessions = historySessions.filter(
    (date) =>
      evaluationStart !== undefined && evaluationEnd !== undefined && date >= evaluationStart && date <= evaluationEnd,
  )
  if (sessions.length === 0) throw new Error('The requested evaluation window contains no calendar sessions')
  const l1Quotes = options.quotes === undefined ? undefined : parseReplayQuotes(options.quotes, allowedSymbols)
  const splitInput =
    options.splits === undefined
      ? undefined
      : parseReplaySplits(options.splits, allowedSymbols, new Set(historySessions))
  const { dailyByDate, checkpointsByDate } = buildSessionSummaries(byDate, historySessions, calendar)
  const baselines = new Map(
    sessions.map((date) => {
      const priorCutoff = utcInstantFromEpochMillis(
        Date.parse(`${date}T00:00:00Z`) - Math.max(35, policy.trailingBaseline.lookbackSessions * 3) * 86_400_000,
      ).slice(0, 10)
      const priorDates = historySessions.filter((prior) => prior >= priorCutoff && prior < date)
      return [
        date,
        buildTrailingBaseline({
          sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(date),
          symbols: policy.candidateSymbols,
          noiseAreaSymbols: policy.noiseAreaSymbols,
          lookbackSessions: policy.trailingBaseline.lookbackSessions,
          minimumSessions: policy.trailingBaseline.minimumSessions,
          dailyRows: priorDates.flatMap((prior) =>
            (dailyByDate.get(prior) ?? []).map((row) => {
              const scale = priorPriceScale(splitInput?.splits ?? [], row.symbol, prior, date)
              return scale === 1
                ? row
                : {
                    ...row,
                    open: row.open * scale,
                    high: row.high * scale,
                    low: row.low * scale,
                    close: row.close * scale,
                  }
            }),
          ),
          checkpointRows: priorDates.flatMap((prior) =>
            (checkpointsByDate.get(prior) ?? []).map((row) => {
              const scale = priorPriceScale(splitInput?.splits ?? [], row.symbol, prior, date)
              return scale === 1 ? row : { ...row, close: row.close * scale }
            }),
          ),
        }),
      ] as const
    }),
  )

  const startingCapitalUsd = 100_000
  const missingBaselineSessionsBySymbol = Object.fromEntries(
    policy.candidateSymbols.map((symbol) => [
      symbol,
      [...baselines.values()].filter(
        (baseline) => Result.isFailure(baseline) || baseline.success.symbols[symbol] === undefined,
      ).length,
    ]),
  )
  const evaluationSessionsWithoutBaseline = [...baselines.values()].filter(Result.isFailure).length
  const evaluationSessionsWithPartialBaseline = [...baselines.values()].filter(
    (baseline) =>
      Result.isSuccess(baseline) &&
      policy.candidateSymbols.some((symbol) => baseline.success.symbols[symbol] === undefined),
  ).length
  const partialBaselineScenario = evaluationSessionsWithoutBaseline > 0 || evaluationSessionsWithPartialBaseline > 0
  const runScenario = (quoteModel: QuoteModel) => {
    const slippageBps = quoteModel.slippageRtBps
    const leaveOneOut = policy.candidateSymbols.map((symbol) => ({
      omittedSymbol: symbol,
      rerunSessions: 0,
      unavailableSessions: 0,
      unresolvedExits: 0,
      modeledClosedNetUsd: 0,
      trades: 0,
      engineModeledClosedNetUsd: {
        [IntradayAlphaPhase.MorningOrb]: 0,
        [IntradayAlphaPhase.MiddayReversion]: 0,
        [IntradayAlphaPhase.NoiseAreaTrend]: 0,
      },
    }))
    const carryForwardSessions = []
    const missingDecisionQuotes = (
      outcome: Pick<ReturnType<typeof simulateSession>, 'requiredBenchmarkCheckpoints' | 'decisionQuoteSymbols'>,
    ) =>
      quoteModel.bySymbol !== undefined &&
      outcome.requiredBenchmarkCheckpoints > 0 &&
      outcome.decisionQuoteSymbols.size === 0
    const unavailable = (outcome: Omit<ReturnType<typeof simulateSession>, 'consideredSymbols'>) =>
      outcome.benchmarkMinutes === 0 ||
      outcome.unavailableBenchmarkCheckpoints.length > 0 ||
      outcome.missingConcurrentMarkWindows > 0 ||
      outcome.l1ExecutionGaps.length > 0 ||
      missingDecisionQuotes(outcome)
    const allTrades: TradeOutcome[] = []
    const dailyPnl: {
      readonly date: string
      readonly modeledClosedNet: number
      readonly trades: number
      readonly modeledFilledLegs: number
      readonly unresolvedExits: number
      readonly baselineAvailable: boolean
      readonly benchmarkAvailable: boolean
      readonly unavailableBenchmarkCheckpoints: number
      readonly missingConcurrentMarkWindows: number
      readonly available: boolean
      readonly noDecisionQuotes: boolean
    }[] = []
    const sessionDetails: (Omit<ReturnType<typeof simulateSession>, 'consideredSymbols'> & {
      readonly date: string
      readonly baselineAvailable: boolean
      readonly benchmarkAvailable: boolean
      readonly baselineHash: string | null
      readonly baselineMissingSymbols: readonly string[]
    })[] = []
    let totalPlannerBlocks = 0

    for (const date of sessions) {
      const symMap = byDate.get(date)
      if (symMap === undefined) continue
      const baselineResult = baselines.get(date)
      const baseline =
        baselineResult !== undefined && Result.isSuccess(baselineResult) ? baselineResult.success : undefined
      const regular = Result.getOrThrow(resolveAlphaRegularSession(calendar, date))
      const emptyOutcome: ReturnType<typeof simulateSession> = {
        trades: [],
        plannerBlocks: 0,
        attempts: [],
        unresolvedExits: [],
        expectedRegularMinutes: (regular.closeMs - regular.openMs) / 60_000,
        benchmarkMinutes: symMap.get(intradayAlphaBenchmarkSymbol)?.length ?? 0,
        requiredBenchmarkCheckpoints: 0,
        unavailableBenchmarkCheckpoints: [],
        ambiguousExitBars: 0,
        stopLimitGapBars: 0,
        concurrentOverlaps: 0,
        missingConcurrentMarkWindows: 0,
        coHeldMarkGaps: [],
        l1ExecutionGaps: [],
        consideredSymbols: new Set(),
        decisionQuoteSymbols: new Set(),
        maximumConcurrentLegs: 0,
        maximumConcurrentGrossEntryNotionalUsd: 0,
      }
      const runDay = (
        trailingBaseline: IntradayAlphaTrailingBaseline,
        bars: Map<string, RawBar[]>,
        carryCoHeldMarks = false,
      ) =>
        simulateSession({
          policy,
          policyHash,
          sessionDate: date,
          calendar,
          symMap: bars,
          trailingBaseline,
          quoteModel,
          startingCapitalUsd,
          carryCoHeldMarks,
        })
      const { consideredSymbols, ...outcome } = baseline === undefined ? emptyOutcome : runDay(baseline, symMap)
      const { trades, plannerBlocks } = outcome
      const sumNet = (legs: readonly TradeOutcome[]) => legs.reduce((sum, trade) => sum + trade.netPnlUsd, 0)
      if (baseline !== undefined && outcome.coHeldMarkGaps.length > 0) {
        const carried = runDay(baseline, symMap, true)
        carryForwardSessions.push({
          date,
          gaps: carried.coHeldMarkGaps,
          completeWithCarry: !unavailable(carried) && carried.unresolvedExits.length === 0,
          strictModeledClosedNetUsd: sumNet(trades),
          carriedModeledClosedNetUsd: sumNet(carried.trades),
          deltaModeledClosedNetUsd: sumNet(carried.trades) - sumNet(trades),
          strictEntryAttempts: outcome.attempts.length,
          carriedEntryAttempts: carried.attempts.length,
        })
      }
      for (const omitted of leaveOneOut) {
        const omittedOnlyBaseline =
          baseline?.symbols[omitted.omittedSymbol] !== undefined && Object.keys(baseline.symbols).length === 1
        let scenario = outcome
        if (omittedOnlyBaseline) scenario = emptyOutcome
        // Ordinarily omission can only change a visited decision where the symbol reached a candidate pool.
        // Noise weights also depend on the baseline of its peer, even when the peer has no signal.
        const noiseWeightsChange =
          policy.noiseAreaSymbols.some((symbol) => symbol === omitted.omittedSymbol) &&
          baseline?.symbols[omitted.omittedSymbol] !== undefined &&
          policy.noiseAreaSymbols.some((symbol) => consideredSymbols.has(symbol))
        if (
          baseline !== undefined &&
          !omittedOnlyBaseline &&
          (consideredSymbols.has(omitted.omittedSymbol) ||
            noiseWeightsChange ||
            (outcome.decisionQuoteSymbols.size === 1 && outcome.decisionQuoteSymbols.has(omitted.omittedSymbol)))
        ) {
          const bars = new Map(symMap)
          bars.delete(omitted.omittedSymbol)
          const symbols = { ...baseline.symbols }
          delete symbols[omitted.omittedSymbol]
          scenario = runDay({ ...baseline, symbols }, bars)
          omitted.rerunSessions++
        }
        omitted.unavailableSessions += Number(baseline === undefined || omittedOnlyBaseline || unavailable(scenario))
        omitted.unresolvedExits += scenario.unresolvedExits.length
        omitted.modeledClosedNetUsd += sumNet(scenario.trades)
        omitted.trades += scenario.trades.length
        for (const trade of scenario.trades) omitted.engineModeledClosedNetUsd[trade.phase] += trade.netPnlUsd
      }
      sessionDetails.push({
        date,
        baselineAvailable: baseline !== undefined,
        benchmarkAvailable: outcome.benchmarkMinutes > 0 && outcome.unavailableBenchmarkCheckpoints.length === 0,
        baselineHash: baseline === undefined ? null : Result.getOrThrow(canonicalHashV1Result(baseline)),
        baselineMissingSymbols: policy.candidateSymbols.filter((symbol) => baseline?.symbols[symbol] === undefined),
        ...outcome,
      })
      totalPlannerBlocks += plannerBlocks
      allTrades.push(...trades)
      dailyPnl.push({
        date,
        modeledClosedNet: trades.reduce((sum, t) => sum + t.netPnlUsd, 0),
        trades: trades.length,
        modeledFilledLegs: outcome.attempts.reduce((sum, attempt) => sum + attempt.filledSymbols.length, 0),
        unresolvedExits: outcome.unresolvedExits.length,
        baselineAvailable: baseline !== undefined,
        benchmarkAvailable: outcome.benchmarkMinutes > 0 && outcome.unavailableBenchmarkCheckpoints.length === 0,
        unavailableBenchmarkCheckpoints: outcome.unavailableBenchmarkCheckpoints.length,
        missingConcurrentMarkWindows: outcome.missingConcurrentMarkWindows,
        available: baseline !== undefined && !unavailable(outcome),
        noDecisionQuotes: missingDecisionQuotes(outcome),
      })
    }

    const activeSessions = dailyPnl.filter((d) => d.modeledFilledLegs > 0).length
    const unavailableSessions = dailyPnl.filter((day) => !day.available).length
    const modeledClosedNet = dailyPnl.reduce((sum, d) => sum + d.modeledClosedNet, 0)
    const unresolvedExits = dailyPnl.reduce((sum, d) => sum + d.unresolvedExits, 0)
    const completeOutcomes = unresolvedExits === 0 && unavailableSessions === 0
    const meanDaily = modeledClosedNet / Math.max(1, dailyPnl.length)
    const variance =
      dailyPnl.reduce((sum, d) => sum + (d.modeledClosedNet - meanDaily) ** 2, 0) / Math.max(1, dailyPnl.length - 1)
    const sharpe = variance > 0 ? (meanDaily / Math.sqrt(variance)) * Math.sqrt(252) : 0
    let equity = 0
    let peak = 0
    let maxDd = 0
    for (const d of dailyPnl) {
      equity += d.modeledClosedNet
      if (equity > peak) peak = equity
      if (peak - equity > maxDd) maxDd = peak - equity
    }

    const foldSize = Math.ceil(dailyPnl.length / 3)
    const folds = [0, 1, 2].map((i) =>
      dailyPnl.slice(i * foldSize, (i + 1) * foldSize).reduce((sum, d) => sum + d.modeledClosedNet, 0),
    )
    const longNet = allTrades.filter((t) => t.direction === 'LONG').reduce((s, t) => s + t.netPnlUsd, 0)
    const shortNet = allTrades.filter((t) => t.direction === 'SHORT').reduce((s, t) => s + t.netPnlUsd, 0)
    const orbTrades = allTrades.filter((t) => t.phase === IntradayAlphaPhase.MorningOrb)
    const mrTrades = allTrades.filter((t) => t.phase === IntradayAlphaPhase.MiddayReversion)
    const noiseTrades = allTrades.filter((t) => t.phase === IntradayAlphaPhase.NoiseAreaTrend)
    const orbModeledClosedNet = orbTrades.reduce((sum, trade) => sum + trade.netPnlUsd, 0)
    const mrModeledClosedNet = mrTrades.reduce((sum, trade) => sum + trade.netPnlUsd, 0)
    const noiseModeledClosedNet = noiseTrades.reduce((sum, trade) => sum + trade.netPnlUsd, 0)
    const middayBaskets = sessionDetails.flatMap((day) =>
      day.attempts
        .filter((attempt) => attempt.phase === IntradayAlphaPhase.MiddayReversion)
        .map((attempt) => {
          const observedTrades = day.trades.filter((trade) => trade.phase === IntradayAlphaPhase.MiddayReversion)
          const unresolved = day.unresolvedExits.filter((exit) => attempt.filledSymbols.includes(exit.symbol)).length
          const closedNet = observedTrades.reduce((sum, trade) => sum + trade.netPnlUsd, 0)
          return {
            date: day.date,
            selectedLegs: attempt.selectedSymbols.length,
            filledLegs: attempt.filledSymbols.length,
            ...(attempt.residualProtection === undefined ? {} : { residualProtection: attempt.residualProtection }),
            complete: attempt.filledSymbols.length === attempt.selectedSymbols.length,
            bothSidesFilled: attempt.longEntryNotionalUsd > 0 && attempt.shortEntryNotionalUsd > 0,
            longEntryNotionalUsd: attempt.longEntryNotionalUsd,
            shortEntryNotionalUsd: attempt.shortEntryNotionalUsd,
            signedEntryNotionalUsd: attempt.longEntryNotionalUsd - attempt.shortEntryNotionalUsd,
            grossEntryNotionalUsd: attempt.longEntryNotionalUsd + attempt.shortEntryNotionalUsd,
            unresolvedExits: unresolved,
            modeledClosedNet: closedNet,
            modeledNet: unresolved === 0 ? closedNet : null,
            longNet: observedTrades
              .filter((trade) => trade.direction === 'LONG')
              .reduce((sum, trade) => sum + trade.netPnlUsd, 0),
            shortNet: observedTrades
              .filter((trade) => trade.direction === 'SHORT')
              .reduce((sum, trade) => sum + trade.netPnlUsd, 0),
          }
        }),
    )
    const summarizeBaskets = (baskets: typeof middayBaskets) => {
      const unresolved = baskets.reduce((sum, basket) => sum + basket.unresolvedExits, 0)
      const closedNet = baskets.reduce((sum, basket) => sum + basket.modeledClosedNet, 0)
      return {
        baskets: baskets.length,
        unresolvedExits: unresolved,
        modeledClosedNet: closedNet,
        modeledNet: unresolved === 0 ? closedNet : null,
        longNet: baskets.reduce((sum, basket) => sum + basket.longNet, 0),
        shortNet: baskets.reduce((sum, basket) => sum + basket.shortNet, 0),
        meanAbsoluteSignedEntryNotionalUsd:
          baskets.reduce((sum, basket) => sum + Math.abs(basket.signedEntryNotionalUsd), 0) /
          Math.max(1, baskets.length),
        maximumAbsoluteSignedEntryNotionalUsd: Math.max(
          0,
          ...baskets.map((basket) => Math.abs(basket.signedEntryNotionalUsd)),
        ),
        grossEntryNotionalUsd: baskets.reduce((sum, basket) => sum + basket.grossEntryNotionalUsd, 0),
      }
    }

    const fourLegBaskets = middayBaskets.filter((basket) => basket.selectedLegs === 4)
    const completeFourLegBaskets = fourLegBaskets.filter((basket) => basket.complete)
    const enginePhases = [
      IntradayAlphaPhase.MorningOrb,
      IntradayAlphaPhase.MiddayReversion,
      IntradayAlphaPhase.NoiseAreaTrend,
    ] as const
    const scorecard = (phase?: ActiveAlphaPhase) =>
      replayScorecard(
        sessionDetails.map(({ date, trades }) => ({
          date,
          trades: phase === undefined ? trades : trades.filter((trade) => trade.phase === phase),
        })),
        startingCapitalUsd,
      )

    return {
      slippageBps,
      completeOutcomes,
      totalSessions: sessions.length,
      activeSessions,
      evaluatedSessions: sessions.length - unavailableSessions,
      unavailableSessions,
      unavailableBenchmarkCheckpoints: sessionDetails.reduce(
        (sum, day) => sum + day.unavailableBenchmarkCheckpoints.length,
        0,
      ),
      activeRate: activeSessions / Math.max(1, sessions.length),
      totalTrades: allTrades.length,
      orbTrades: orbTrades.length,
      orbModeledClosedNet,
      orbNet: completeOutcomes ? orbModeledClosedNet : null,
      mrTrades: mrTrades.length,
      mrModeledClosedNet,
      mrNet: completeOutcomes ? mrModeledClosedNet : null,
      noiseTrades: noiseTrades.length,
      noiseModeledClosedNet,
      noiseNet: completeOutcomes ? noiseModeledClosedNet : null,
      longModeledClosedNet: longNet,
      shortModeledClosedNet: shortNet,
      longNet: completeOutcomes ? longNet : null,
      shortNet: completeOutcomes ? shortNet : null,
      modeledClosedNet,
      totalNet: completeOutcomes ? modeledClosedNet : null,
      chronologicalSlices: completeOutcomes ? folds : null,
      maxDd: completeOutcomes ? maxDd : null,
      sharpe: completeOutcomes ? sharpe : null,
      totalPlannerBlocks,
      concurrentOverlaps: sessionDetails.reduce((sum, day) => sum + day.concurrentOverlaps, 0),
      missingConcurrentMarkWindows: sessionDetails.reduce((sum, day) => sum + day.missingConcurrentMarkWindows, 0),
      maximumConcurrentLegs: Math.max(0, ...sessionDetails.map((day) => day.maximumConcurrentLegs)),
      maximumConcurrentGrossEntryNotionalUsd: Math.max(
        0,
        ...sessionDetails.map((day) => day.maximumConcurrentGrossEntryNotionalUsd),
      ),
      unresolvedExits,
      modeledFilledLegs: sessionDetails.reduce(
        (sum, day) => sum + day.attempts.reduce((count, attempt) => count + attempt.filledSymbols.length, 0),
        0,
      ),
      ambiguousExitBars: sessionDetails.reduce((sum, day) => sum + day.ambiguousExitBars, 0),
      stopLimitGapBars: sessionDetails.reduce((sum, day) => sum + day.stopLimitGapBars, 0),
      entryAttempts: sessionDetails.reduce((sum, day) => sum + day.attempts.length, 0),
      unfilledAttempts: sessionDetails.reduce(
        (sum, day) => sum + day.attempts.filter((attempt) => attempt.filledSymbols.length === 0).length,
        0,
      ),
      partiallyFilledBaskets: sessionDetails.reduce(
        (sum, day) =>
          sum +
          day.attempts.filter(
            (attempt) =>
              attempt.phase === IntradayAlphaPhase.MiddayReversion &&
              attempt.filledSymbols.length > 0 &&
              attempt.filledSymbols.length < attempt.selectedSymbols.length,
          ).length,
        0,
      ),
      recentDays: dailyPnl.slice(-5).map(({ available, noDecisionQuotes: _quotes, ...day }) => ({
        ...day,
        modeledNet: available && day.unresolvedExits === 0 ? day.modeledClosedNet : null,
      })),
      middayBasketAttribution: {
        complete: summarizeBaskets(middayBaskets.filter((basket) => basket.complete)),
        completeFourLeg: summarizeBaskets(
          middayBaskets.filter(
            (basket) => basket.complete && basket.selectedLegs === policy.middayReversion.targetPairs * 2,
          ),
        ),
        singleLegFallback: summarizeBaskets(middayBaskets.filter((basket) => basket.selectedLegs === 1)),
        partial: summarizeBaskets(middayBaskets.filter((basket) => basket.filledLegs > 0 && !basket.complete)),
        unfilled: summarizeBaskets(middayBaskets.filter((basket) => basket.filledLegs === 0)),
        bothSidesFilled: summarizeBaskets(middayBaskets.filter((basket) => basket.bothSidesFilled)),
        oneSideFilled: summarizeBaskets(
          middayBaskets.filter((basket) => basket.filledLegs > 0 && !basket.bothSidesFilled),
        ),
      },
      middayBaskets,
      sessionDetails: sessionDetails.map(
        ({ coHeldMarkGaps: _mark, l1ExecutionGaps: _l1, decisionQuoteSymbols: _quotes, ...day }) => day,
      ),
      diagnostics: {
        evidenceClass: replayDiagnosticClass,
        pnlBasis: 'MODELED_CLOSED_LEG_SUBTOTALS_ON_ALL_CALENDAR_DATES',
        completeOutcomes,
        portfolio: scorecard(),
        engines: Object.fromEntries(enginePhases.map((phase) => [phase, scorecard(phase)])),
        leaveOneSymbolOut: leaveOneOut.map((item) => ({
          ...item,
          completeOutcomes: item.unavailableSessions === 0 && item.unresolvedExits === 0,
          closedSubtotalDeltaUsd: item.modeledClosedNetUsd - modeledClosedNet,
        })),
        middayFillCompleteness: {
          intendedFourLegBaskets: fourLegBaskets.length,
          completeFourLegBaskets: completeFourLegBaskets.length,
          completeFourLegRate: fourLegBaskets.length > 0 ? completeFourLegBaskets.length / fourLegBaskets.length : null,
          allMiddayAttempts: summarizeBaskets(middayBaskets),
          incompleteFourLeg: summarizeBaskets(fourLegBaskets.filter((basket) => !basket.complete)),
        },
        coHeldMarkGaps: sessionDetails.flatMap((day) => day.coHeldMarkGaps.map((gap) => ({ date: day.date, ...gap }))),
        carryForwardSensitivity: {
          evidenceClass: replayDiagnosticClass,
          maximumAgeMinutes: carryForwardMinutes,
          sessions: carryForwardSessions,
        },
        l1ExecutionGaps: sessionDetails.flatMap((day) => day.l1ExecutionGaps),
        sessionsWithoutDecisionL1Quotes: dailyPnl.filter((day) => day.noDecisionQuotes).map((day) => day.date),
      },
    }
  }
  const results = [2, 5, 10].map((slippageRtBps) => runScenario({ slippageRtBps }))
  const l1Scenario = l1Quotes === undefined ? undefined : runScenario({ slippageRtBps: 0, bySymbol: l1Quotes.bySymbol })
  return {
    schemaVersion: 'bayn.intraday-alpha-bar-scenario.v2',
    qualification: 'UNQUALIFIED',
    evidenceClass: 'RETROSPECTIVE_EVENT_TIME_BAR_SCENARIO',
    policyHash,
    policySchemaVersion: policy.schemaVersion,
    partialBaselineScenario,
    baselineCoverage: {
      classification: partialBaselineScenario ? 'PARTIAL_SUPPLIED_BASELINE_SCENARIO' : 'SUPPLIED_BAR_BASELINE_SCENARIO',
      evaluationSessionsWithoutBaseline,
      evaluationSessionsWithPartialBaseline,
      missingBaselineSessionsBySymbol,
      adjustedDailySupplementSupplied: false,
    },
    evaluationStart,
    ...(options.evaluationEnd === undefined ? {} : { evaluationEnd }),
    ...(splitInput === undefined ? {} : { splitAdjustments: splitInput }),
    historySessions,
    calendarHash: calendar.normalizedResponseHash,
    sources,
    inputRows: { uniqueBars, identicalDuplicates, ignoredSymbols },
    assumptions: {
      startingCapitalUsd,
      modeledSellFeeBps: MODELED_SELL_FEE_BPS,
      account:
        'Fixed $100000 equity and hypothetical 4x buying power less occupied entry notional; no broker account, collateral, margin-interest or final account-risk proof',
      baseline:
        selection === 'v2'
          ? 'Strictly prior supplied IEX regular-session summaries; historical adjusted-daily supplements are not supplied; insufficient baselines remain unavailable outcomes'
          : 'Strictly prior supplied regular-session summaries; historical adjusted-daily supplements are not supplied; missing per-leg ATR cannot fund entry',
      completeness:
        'Every visited active decision requires the production extractor completed-SPY/VWAP result and any co-held current marks needed for planning; first missing observation stops later entries and suppresses whole-window metrics; closed-trade subtotals and basket attribution cover only the supported committed path',
      concurrency:
        'Disjoint symbol sleeves share synthetic account headroom; exact current co-held marks required for new decisions; no pending-order, reservation or broker-protection lifecycle simulation',
      arrival:
        'Completed bars assumed available at minute close; original arrival receipts are not supplied to this scenario',
      source:
        'Eight-column bars do not independently prove feed, universe or revision selection; retain the export receipt',
      quotes:
        'Synthetic quotes around completed closes; historical executable quotes are not supplied to this scenario',
      borrow: 'Every candidate assumed borrow-eligible; historical eligibility is not supplied to this scenario',
      entry: 'First full minute open after decision, within original limit and modeled one-minute working window',
      exit: 'OHLC stop/target proxies with stop-first both-touch convention and resting gapped stop limits; first full minute open after time deadline; missing exit prices remain unresolved',
      liquidity:
        'Whole intended quantity assumed filled at the price proxy; capacity and queue priority are unmeasured',
      ...(selection === 'v2_1'
        ? { tradeCount: 'Each modeled closed slice counts separately; a trimmed leg can have multiple exits' }
        : {}),
      basket:
        selection === 'v2'
          ? 'Legs fill independently; planned dollar neutrality does not prove realized neutrality'
          : 'For incomplete 2L+2S attempts, assumes terminal entries at expiry and reduce-only trims at the next whole-minute open; uses open or L1 midpoint exposure marks. Missing marks withhold outcomes. Not a broker cancel or fill receipt.',
      costs:
        'Sell fee and fixed slippage scenarios; operating expense, borrow, impact and real settlement are unmeasured',
      selection:
        'Current candidate universe applied retrospectively; chronological slices are descriptive, not holdout validation',
      runtime:
        'Exercises signal, funding and planner functions; omits ingestion, authority, final risk and broker recovery',
    },
    sessions,
    results,
    ...(l1Quotes === undefined || l1Scenario === undefined
      ? {}
      : {
          l1: {
            ...l1Scenario,
            model: 'IEX_L1_MINUTE_BBO',
            slippageBps: null,
            quoteSource: l1Quotes.source,
            inputQuoteMinutes: l1Quotes.rows,
            assumption:
              'Last BBO from completed minute for decisions; first BBO for entry and timed exit; first half-spread ratio applied to intraminute trade-bar exit proxies. True quote event times, sizes and queue priority are unknown.',
          },
        }),
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] !== '--calendar' || args[1] === undefined || args.length < 3) {
    console.error(
      'Usage: bun run tools/verify-intraday-alpha-replay.ts --calendar <calendar_json> [--policy v2|v2_1] [--evaluation-start YYYY-MM-DD] [--evaluation-end YYYY-MM-DD] [--quotes <quotes_tsv>] [--splits <splits_json>] <bars_tsv_1> [bars_tsv_2 ...]',
    )
    process.exit(1)
  }
  const calendarInput: unknown = JSON.parse(readFileSync(args[1], 'utf8'))
  const paths: string[] = []
  const flags = new Map<string, keyof ReplayOptions>([
    ['--policy', 'policy'],
    ['--evaluation-start', 'evaluationStart'],
    ['--evaluation-end', 'evaluationEnd'],
    ['--quotes', 'quotes'],
    ['--splits', 'splits'],
  ])
  const options: Partial<Record<keyof ReplayOptions, string>> = {}
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (!arg.startsWith('--')) paths.push(arg)
    else {
      const key = flags.get(arg)
      if (key === undefined || options[key] !== undefined) throw new Error(`Unknown or duplicate argument ${arg}`)
      const value = args[++i]
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      options[key] = value
    }
  }
  console.log(JSON.stringify(runIntradayAlphaReplayVerification(paths, calendarInput, options), null, 2))
}
