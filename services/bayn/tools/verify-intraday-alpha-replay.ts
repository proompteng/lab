import { readFileSync } from 'node:fs'
import { Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
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
import { IsoDateSchema, type IsoDate } from '../src/schemas'
import { reconciledStateHash } from '../src/simulation-reconciliation/broker-model'
import { priceNumberToMicros } from '../src/strategy/execution-model/fixed-point'
import { isBalancedMiddayBasket } from '../src/strategy/intraday-alpha/decision'
import { makeIntradayAlphaFundedExitPlan } from '../src/strategy/intraday-alpha/exit-plan'
import {
  IntradayAlphaPhase,
  intradayAlphaBenchmarkSymbol,
  intradayAlphaCandidateSymbols,
  intradayAlphaEquityMarketProfile,
  makeIntradayAlphaPolicy,
} from '../src/strategy/intraday-alpha/policy'
import {
  extractIntradayAlphaCandidates,
  selectIntradayAlphaLegs,
  type ActiveAlphaPhase,
} from '../src/strategy/intraday-alpha/signals'
import { TargetPlanStatus, planTargets, quoteBoundTargetPlannerInputSchemaVersion } from '../src/target-planner/index'
import { utcInstantFromEpochMillis } from '../src/time'

interface RawBar {
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
  readonly exitReason: 'STOP' | 'TARGET' | 'MAX_HOLD' | 'EOD'
  readonly grossPnlUsd: number
  readonly netPnlUsd: number
  readonly spyExcessUsd: number
}

interface ActiveSimulatedPosition {
  readonly phase: ActiveAlphaPhase
  readonly symbol: string
  readonly direction: 'LONG' | 'SHORT'
  readonly shares: number
  readonly entryPrice: number
  readonly entryMinute: number
  readonly exitMinute: number
  readonly stopPriceMicros: string
  readonly stopLimitPriceMicros: string
  readonly profitLimitPriceMicros: string
}

const allowedSymbols = new Set<string>([...intradayAlphaCandidateSymbols, intradayAlphaBenchmarkSymbol])
const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
const policy = makeIntradayAlphaPolicy(protocol)
const accountId = 'alpha-replay-verifier'
const cycleId = 'a'.repeat(64)
const policyHash = Result.getOrThrow(canonicalHashV1Result(policy))
const observationHash = 'b'.repeat(64)
const snapshotId = 'c'.repeat(64)
const snapshotContentHash = 'd'.repeat(64)

// Observed live Alpaca equity fee rate (~0.21 bps on sell legs)
const LIVE_SELL_FEE_BPS = 0.21

const parseBarsFiles = (paths: readonly string[]): Map<string, Map<string, RawBar[]>> => {
  const dedup = new Map<string, RawBar>()
  for (const filePath of paths) {
    const content = readFileSync(filePath, 'utf8')
    for (const line of content.split('\n')) {
      if (line.length === 0) continue
      const cols = line.split('\t')
      if (cols.length < 8) continue
      const symbol = cols[0] ?? ''
      if (!allowedSymbols.has(symbol)) continue
      const rawAt = cols[1] ?? ''
      const eventMs = Date.parse(rawAt)
      if (!Number.isFinite(eventMs)) continue
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
        volume <= 0 ||
        close <= 0
      )
        continue
      const eventAt = utcInstantFromEpochMillis(eventMs)
      dedup.set(`${symbol}|${eventMs}`, {
        symbol,
        eventAt,
        eventMs,
        open,
        high,
        low,
        close,
        volume,
        vwap: Number.isFinite(vwap) && vwap > 0 ? vwap : (high + low + close) / 3,
      })
    }
  }

  const byDate = new Map<string, Map<string, RawBar[]>>()
  const calendarBounds = new Map<string, { readonly openMs: number; readonly closeMs: number }>()
  for (const bar of dedup.values()) {
    const dateKey = bar.eventAt.slice(0, 10)
    let bounds = calendarBounds.get(dateKey)
    if (bounds === undefined) {
      const isoDate = Schema.decodeUnknownSync(IsoDateSchema)(dateKey)
      const cal = Result.getOrThrow(
        normalizeMarketCalendarResult(
          [{ session_open: '0930', session_close: '1600', date: isoDate, open: '09:30', close: '16:00' }],
          { start: isoDate, end: isoDate },
        ),
      )
      const session = cal.sessions[0]
      if (session === undefined) continue
      bounds = { openMs: Date.parse(session.openAt), closeMs: Date.parse(session.closeAt) }
      calendarBounds.set(dateKey, bounds)
    }
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
  return byDate
}

const makeShortEligibility = (observedAt: string): Readonly<Record<string, EquityShortEligibility>> =>
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

const makeEntryPortfolio = (
  observedAt: string,
  equityUsd: number,
  activePositions: readonly ActiveSimulatedPosition[],
  barByMinute: Map<string, Map<number, RawBar>>,
  completedMinute: number,
) => {
  const equityMicros = BigInt(Math.round(equityUsd * 1_000_000))
  // Alpaca PAPER margin account provides 4x intraday buying power on equity.
  let usedMarginMicros = 0n
  const positions = activePositions
    .toSorted((a, b) => a.symbol.localeCompare(b.symbol))
    .map((pos) => {
      const sign = pos.direction === 'LONG' ? 1n : -1n
      const qtyAtoms = sign * BigInt(pos.shares) * 1_000_000_000n
      const avgMicros = BigInt(Math.round(pos.entryPrice * 1_000_000))
      const markPrice = barByMinute.get(pos.symbol)?.get(completedMinute)?.close ?? pos.entryPrice
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
  const buyingPowerMicros = equityMicros * 4n - usedMarginMicros
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

const buildReplaySnapshot = (input: {
  readonly sessionDate: string
  readonly calendar: ReturnType<typeof normalizeMarketCalendarResult> extends Result.Result<infer C, unknown>
    ? C
    : never
  readonly sessionOpenMs: number
  readonly rangeEndMs: number
  readonly symMap: Map<string, RawBar[]>
  readonly quoteHalfSpreadBps: number
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
        ingestedAt: utcInstantFromEpochMillis(bar.eventMs + 59_000),
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
      const half = (lastBar.close * input.quoteHalfSpreadBps) / 10_000
      const bidPrice = Number(Math.max(0.01, lastBar.close - half).toFixed(2))
      const askPrice = Number(Math.max(bidPrice + 0.01, lastBar.close + half).toFixed(2))
      const quote: IntradayQuote = {
        provider: 'alpaca',
        universeId: market.universeId,
        universeSymbolHash: market.universeSymbolHash,
        marketSession: 'regular',
        schemaVersion: 1,
        symbol,
        eventAt: utcInstantFromEpochMillis(observedAtMs - 1_000),
        ingestedAt: utcInstantFromEpochMillis(observedAtMs - 1_000),
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

const buildSessionSummaries = (
  byDate: Map<string, Map<string, RawBar[]>>,
  sessions: readonly string[],
): {
  readonly dailyByDate: Map<string, PriorSessionDailySummary[]>
  readonly checkpointsByDate: Map<string, PriorSessionCheckpointSummary[]>
} => {
  const dailyByDate = new Map<string, PriorSessionDailySummary[]>()
  const checkpointsByDate = new Map<string, PriorSessionCheckpointSummary[]>()
  const noiseSet = new Set<string>(policy.noiseAreaSymbols)

  for (const date of sessions) {
    const isoDate = Schema.decodeUnknownSync(IsoDateSchema)(date)
    const cal = Result.getOrThrow(
      normalizeMarketCalendarResult(
        [{ session_open: '0930', session_close: '1600', date: isoDate, open: '09:30', close: '16:00' }],
        { start: isoDate, end: isoDate },
      ),
    )
    const session = cal.sessions[0]
    if (session === undefined) continue
    const openMs = Date.parse(session.openAt)
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

const simulateSession = (input: {
  readonly sessionDate: IsoDate
  readonly symMap: Map<string, RawBar[]>
  readonly trailingBaseline: IntradayAlphaTrailingBaseline
  readonly slippageRtBps: number
  readonly startingCapitalUsd: number
}): {
  readonly trades: readonly TradeOutcome[]
  readonly plannerBlocks: number
  readonly concurrentOverlaps: number
} => {
  const isoDate = input.sessionDate
  const cal = Result.getOrThrow(
    normalizeMarketCalendarResult(
      [{ session_open: '0930', session_close: '1600', date: isoDate, open: '09:30', close: '16:00' }],
      { start: isoDate, end: isoDate },
    ),
  )
  const session = cal.sessions[0]
  if (session === undefined) return { trades: [], plannerBlocks: 0, concurrentOverlaps: 0 }
  const sessionOpenMs = Date.parse(session.openAt)
  const spyBars = input.symMap.get(intradayAlphaBenchmarkSymbol) ?? []
  if (spyBars.length < 300) return { trades: [], plannerBlocks: 0, concurrentOverlaps: 0 }

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
  let plannerBlocks = 0
  let concurrentOverlaps = 0
  const morningOrbTakenSymbols: string[] = []
  const noiseAreaTakenSymbols: string[] = []
  let middayCompleted = false
  let activePositions: ActiveSimulatedPosition[] = []

  // Scan every minute from 10:00 bar (completed=30, elapsed=31) through 15:00 bar (completed=330, elapsed=331)
  for (let completedMinute = 30; completedMinute <= 330; completedMinute++) {
    // Expire positions that exited on or before this completed minute
    activePositions = activePositions.filter((pos) => pos.exitMinute > completedMinute)

    const elapsedMinutes = completedMinute + 1
    const isNoiseCheck = policy.noiseArea.checkpointMinutesFromOpen.includes(elapsedMinutes)
    const isOrbCheck =
      completedMinute >= policy.morningOrb.entryStartMinuteFromOpen &&
      completedMinute <= policy.morningOrb.entryEndMinuteFromOpen &&
      morningOrbTakenSymbols.length < policy.morningOrb.maxTradesPerSession
    const isMiddayCheck =
      !middayCompleted &&
      completedMinute >= policy.middayReversion.entryStartMinuteFromOpen &&
      completedMinute <= policy.middayReversion.entryEndMinuteFromOpen

    if (!isNoiseCheck && !isOrbCheck && !isMiddayCheck) continue

    const rangeEndMs = sessionOpenMs + elapsedMinutes * 60_000
    const snapshot = buildReplaySnapshot({
      sessionDate: input.sessionDate,
      calendar: cal,
      sessionOpenMs,
      rangeEndMs,
      symMap: input.symMap,
      quoteHalfSpreadBps: Math.max(1, input.slippageRtBps / 2),
    })
    const observedAt = snapshot.manifest.observedAt
    const orderExpiresAtMs = Date.parse(observedAt) + 60_000
    const eligibility = makeShortEligibility(observedAt)
    const occupiedSymbols = activePositions.map((pos) => pos.symbol).toSorted()

    const extracted = Result.getOrThrow(
      extractIntradayAlphaCandidates({
        snapshot,
        policy,
        trailingBaseline: input.trailingBaseline,
        accountId,
        equityShortEligibility: eligibility,
        occupiedSymbols,
        morningOrbTakenSymbols,
        middayReversionCompleted: middayCompleted,
        noiseAreaTakenSymbols,
      }),
    )
    const legs = selectIntradayAlphaLegs({
      context: extracted.context,
      policy,
      longPool: extracted.longPool,
      shortPool: extracted.shortPool,
      vetoedSymbols: new Set(),
    })
    if (legs.length === 0) continue

    const portfolio = makeEntryPortfolio(
      observedAt,
      input.startingCapitalUsd,
      activePositions,
      barByMinute,
      completedMinute,
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
          observation: { snapshot, portfolio, observedAt, contentHash: observationHash },
          leg,
        }),
      )
      if (funded === null) continue
      fundedPlans[leg.symbol] = funded
      targetWeights[leg.symbol] = funded.signedWeight
      maxBuy[leg.symbol] = leg.direction === 'LONG' ? funded.plan.maximumQuantityAtoms : '0'
      maxSell[leg.symbol] = leg.direction === 'SHORT' ? funded.plan.maximumQuantityAtoms : '0'
    }
    const selectedSymbols = Object.keys(fundedPlans).sort()
    if (selectedSymbols.length === 0) continue

    const priceMicros: Record<string, string> = {}
    const bidPriceMicros: Record<string, string> = {}
    const askPriceMicros: Record<string, string> = {}
    for (const symbol of selectedSymbols) {
      const completedBar = barByMinute.get(symbol)?.get(completedMinute)
      const fallbackClose = completedBar?.close ?? input.symMap.get(symbol)?.[0]?.close ?? 100
      bidPriceMicros[symbol] = Result.getOrThrow(priceNumberToMicros(fallbackClose, 'b', 'DOWN')).toString()
      askPriceMicros[symbol] = Result.getOrThrow(priceNumberToMicros(fallbackClose, 'a', 'UP')).toString()
      priceMicros[symbol] = askPriceMicros[symbol]
    }
    const refMaterial = {
      schemaVersion: 'bayn.intraday-snapshot-reference-prices.v1' as const,
      snapshotId,
      snapshotContentHash,
      priceReference: 'verified-adverse-quote-boundary' as const,
      signalDate: isoDate,
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
    const hasCoHeld = activePositions.length > 0
    const planned = Result.getOrThrow(
      planTargets({
        schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
        strategyName: 'jev',
        cycleId,
        decisionHash: 'e'.repeat(64),
        policyHash,
        accountId,
        signalDate: isoDate,
        targetWeights,
        referencePrices: { ...refMaterial, contentHash: refHash },
        brokerState: portfolio.brokerState,
        precision: protocol.executionModel.precision,
        allocationCapitalMicros: portfolio.brokerState.account.equityMicros,
        maximumInputAgeMs: 60_000,
        submissionCutoffAt: utcInstantFromEpochMillis(orderExpiresAtMs),
        observedAt,
        executionTerms: {
          ...(hasCoHeld ? { executionPurpose: 'disjoint-entry' as const } : {}),
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
    if (
      planned.status !== TargetPlanStatus.Planned ||
      (extracted.context.phase === IntradayAlphaPhase.MiddayReversion &&
        !isBalancedMiddayBasket(planned, selectedSymbols))
    ) {
      plannerBlocks++
      continue
    }

    if (hasCoHeld) concurrentOverlaps++

    const entryMinute = Math.ceil((Date.parse(observedAt) - sessionOpenMs) / 60_000)
    const spyByMin = barByMinute.get(intradayAlphaBenchmarkSymbol)
    const perSideSlipMult = input.slippageRtBps / 2 / 10_000
    const phase = extracted.context.phase as ActiveAlphaPhase
    const flattenMinute =
      phase === IntradayAlphaPhase.NoiseAreaTrend
        ? policy.noiseArea.flattenMinuteFromOpen
        : phase === IntradayAlphaPhase.MorningOrb
          ? policy.morningOrb.hardExitMinuteFromOpen
          : policy.middayReversion.flattenMinuteFromOpen
    const flattenMs = sessionOpenMs + flattenMinute * 60_000

    for (const intent of planned.intentTargets) {
      const funded = fundedPlans[intent.symbol]
      if (funded === undefined) continue
      const symBars = barByMinute.get(intent.symbol)
      const isLong = intent.side === OrderSide.Buy
      const levels = funded.plan.levels
      const limitPrice =
        Number('maximumEntryPriceMicros' in levels ? levels.maximumEntryPriceMicros : levels.minimumEntryPriceMicros) /
        1_000_000

      let fill: { readonly minute: number; readonly bar: RawBar; readonly price: number } | undefined
      for (let minute = entryMinute; sessionOpenMs + minute * 60_000 < orderExpiresAtMs; minute++) {
        const bar = symBars?.get(minute)
        if (bar === undefined) continue
        const price = bar.open * (isLong ? 1 + perSideSlipMult : 1 - perSideSlipMult)
        if (isLong ? price <= limitPrice : price >= limitPrice) {
          fill = { minute, bar, price }
          break
        }
      }
      if (fill === undefined) continue
      const { minute: fillMinute, bar: entryBar, price: entryPrice } = fill
      const shares = Number(BigInt(intent.quantityAtoms) / 1_000_000_000n)
      if (shares <= 0) continue

      const stopPrice = Number(BigInt(levels.stopPriceMicros)) / 1_000_000
      const stopLimitPrice = Number(BigInt(levels.stopLimitPriceMicros)) / 1_000_000
      const targetPrice = Number(BigInt(levels.profitLimitPriceMicros)) / 1_000_000
      const maxHoldMinute = Math.min(flattenMinute, fillMinute + levels.maximumHoldingMinutes)

      let exitPrice = entryBar.close
      let exitMinute = maxHoldMinute
      let exitReason: TradeOutcome['exitReason'] = maxHoldMinute >= flattenMinute ? 'EOD' : 'MAX_HOLD'

      let stopTriggered = false
      const clearsStopLimit = (price: number) => (isLong ? price >= stopLimitPrice : price <= stopLimitPrice)
      for (let m = fillMinute; m <= maxHoldMinute; m++) {
        const bar = symBars?.get(m)
        if (bar === undefined) continue
        exitPrice = bar.close
        exitMinute = m
        const openedThroughStop = isLong ? bar.open <= stopPrice : bar.open >= stopPrice
        const touchedStop = isLong ? bar.low <= stopPrice : bar.high >= stopPrice
        if (stopTriggered || touchedStop) {
          const activeAtOpen = stopTriggered || openedThroughStop
          stopTriggered = true
          if (activeAtOpen && clearsStopLimit(bar.open)) {
            exitPrice = bar.open
          } else if (
            clearsStopLimit(activeAtOpen ? (isLong ? bar.high : bar.low) : bar.close) ||
            clearsStopLimit(isLong ? bar.low : bar.high)
          ) {
            exitPrice = stopLimitPrice
          } else {
            continue
          }
          exitReason = 'STOP'
          break
        }
        if (isLong ? bar.high >= targetPrice : bar.low <= targetPrice) {
          exitPrice = isLong ? Math.max(bar.open, targetPrice) : Math.min(bar.open, targetPrice)
          exitReason = 'TARGET'
          break
        }
        if (bar.eventMs >= flattenMs) {
          exitReason = 'EOD'
          break
        }
      }
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
      const feeUsd = (sellNotional * LIVE_SELL_FEE_BPS) / 10_000
      const netPnlUsd = grossPnlUsd - feeUsd
      const spyEntry = spyByMin?.get(fillMinute)?.open ?? spyByMin?.get(completedMinute)?.close
      const spyExit = spyByMin?.get(exitMinute)?.close ?? spyEntry
      const spyRet =
        spyEntry !== undefined && spyExit !== undefined && spyEntry > 0 ? (spyExit - spyEntry) / spyEntry : 0
      const spyLegPnl = (isLong ? 1 : -1) * (entryPrice * shares) * spyRet

      trades.push({
        sessionDate: input.sessionDate,
        phase,
        symbol: intent.symbol,
        direction: isLong ? 'LONG' : 'SHORT',
        shares,
        entryPrice,
        exitPrice: realizedExit,
        exitReason,
        grossPnlUsd,
        netPnlUsd,
        spyExcessUsd: netPnlUsd - spyLegPnl,
      })
      activePositions.push({
        phase,
        symbol: intent.symbol,
        direction: isLong ? 'LONG' : 'SHORT',
        shares,
        entryPrice,
        entryMinute: fillMinute,
        exitMinute,
        stopPriceMicros: levels.stopPriceMicros,
        stopLimitPriceMicros: levels.stopLimitPriceMicros,
        profitLimitPriceMicros: levels.profitLimitPriceMicros,
      })
      if (phase === IntradayAlphaPhase.MorningOrb) morningOrbTakenSymbols.push(intent.symbol)
      if (phase === IntradayAlphaPhase.NoiseAreaTrend) noiseAreaTakenSymbols.push(intent.symbol)
    }

    if (phase === IntradayAlphaPhase.MiddayReversion) middayCompleted = true
  }

  return { trades, plannerBlocks, concurrentOverlaps }
}

export const runIntradayAlphaReplayVerification = (paths: readonly string[]) => {
  const byDate = parseBarsFiles(paths)
  const allHistoryDates = [...byDate.keys()].sort()
  const { dailyByDate, checkpointsByDate } = buildSessionSummaries(byDate, allHistoryDates)

  // Evaluate every session with full SPY coverage AND at least lookbackSessions prior history sessions.
  const warmup = policy.trailingBaseline.lookbackSessions
  const evalSessions = allHistoryDates.filter((date, idx) => {
    if (idx < warmup) return false
    const spy = byDate.get(date)?.get(intradayAlphaBenchmarkSymbol)
    return spy !== undefined && spy.length >= 300
  })
  const startingCapitalUsd = 100_000
  const results = []

  for (const slippageBps of [2, 5, 10]) {
    const allTrades: TradeOutcome[] = []
    const dailyPnl: { readonly date: string; readonly pnl: number; readonly trades: number }[] = []
    let totalPlannerBlocks = 0
    let totalConcurrentOverlaps = 0

    for (const date of evalSessions) {
      const idx = allHistoryDates.indexOf(date)
      const isoDate = Schema.decodeUnknownSync(IsoDateSchema)(date)
      const symMap = byDate.get(date)
      if (symMap === undefined || idx < warmup) continue

      // Pass strictly prior dates (< date) with enough lookback for symbols that started slightly earlier/later.
      const priorDates = allHistoryDates.slice(Math.max(0, idx - 30), idx)
      const dailyRows = priorDates.flatMap((d) => dailyByDate.get(d) ?? [])
      const checkpointRows = priorDates.flatMap((d) => checkpointsByDate.get(d) ?? [])
      const baseline = Result.getOrThrow(
        buildTrailingBaseline({
          sessionDate: isoDate,
          symbols: policy.candidateSymbols,
          noiseAreaSymbols: policy.noiseAreaSymbols,
          lookbackSessions: policy.trailingBaseline.lookbackSessions,
          minimumSessions: policy.trailingBaseline.minimumSessions,
          dailyRows,
          checkpointRows,
        }),
      )

      const { trades, plannerBlocks, concurrentOverlaps } = simulateSession({
        sessionDate: isoDate,
        symMap,
        trailingBaseline: baseline,
        slippageRtBps: slippageBps,
        startingCapitalUsd,
      })
      totalPlannerBlocks += plannerBlocks
      totalConcurrentOverlaps += concurrentOverlaps
      allTrades.push(...trades)
      dailyPnl.push({
        date,
        pnl: trades.reduce((sum, t) => sum + t.netPnlUsd, 0),
        trades: trades.length,
      })
    }

    const activeSessions = dailyPnl.filter((d) => d.trades > 0).length
    const totalNet = dailyPnl.reduce((sum, d) => sum + d.pnl, 0)
    const meanDaily = totalNet / Math.max(1, dailyPnl.length)
    const variance = dailyPnl.reduce((sum, d) => sum + (d.pnl - meanDaily) ** 2, 0) / Math.max(1, dailyPnl.length - 1)
    const sharpe = variance > 0 ? (meanDaily / Math.sqrt(variance)) * Math.sqrt(252) : 0
    let equity = 0
    let peak = 0
    let maxDd = 0
    for (const d of dailyPnl) {
      equity += d.pnl
      if (equity > peak) peak = equity
      if (peak - equity > maxDd) maxDd = peak - equity
    }

    const foldSize = Math.ceil(dailyPnl.length / 3)
    const folds = [0, 1, 2].map((i) =>
      dailyPnl.slice(i * foldSize, (i + 1) * foldSize).reduce((sum, d) => sum + d.pnl, 0),
    )
    const longNet = allTrades.filter((t) => t.direction === 'LONG').reduce((s, t) => s + t.netPnlUsd, 0)
    const shortNet = allTrades.filter((t) => t.direction === 'SHORT').reduce((s, t) => s + t.netPnlUsd, 0)
    const longExcess = allTrades.filter((t) => t.direction === 'LONG').reduce((s, t) => s + t.spyExcessUsd, 0)
    const shortExcess = allTrades.filter((t) => t.direction === 'SHORT').reduce((s, t) => s + t.spyExcessUsd, 0)
    const orbTrades = allTrades.filter((t) => t.phase === IntradayAlphaPhase.MorningOrb)
    const mrTrades = allTrades.filter((t) => t.phase === IntradayAlphaPhase.MiddayReversion)
    const zabTrades = allTrades.filter((t) => t.phase === IntradayAlphaPhase.NoiseAreaTrend)

    results.push({
      slippageBps,
      totalSessions: evalSessions.length,
      activeSessions,
      activeRate: activeSessions / Math.max(1, evalSessions.length),
      totalTrades: allTrades.length,
      orbTrades: orbTrades.length,
      orbNet: orbTrades.reduce((s, t) => s + t.netPnlUsd, 0),
      mrTrades: mrTrades.length,
      mrNet: mrTrades.reduce((s, t) => s + t.netPnlUsd, 0),
      zabTrades: zabTrades.length,
      zabNet: zabTrades.reduce((s, t) => s + t.netPnlUsd, 0),
      longNet,
      shortNet,
      longExcess,
      shortExcess,
      totalNet,
      folds,
      maxDd,
      sharpe,
      totalPlannerBlocks,
      totalConcurrentOverlaps,
      recentDays: dailyPnl.slice(-5),
    })
  }
  return { sessions: evalSessions, results }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Usage: bun run tools/verify-intraday-alpha-replay.ts <bars_tsv_1> [bars_tsv_2 ...]')
    process.exit(1)
  }
  const { sessions, results } = runIntradayAlphaReplayVerification(args)
  console.log(
    `\n=== Production TypeScript 3-Engine Concurrent Intraday Alpha v2 Replay (${sessions.length} OOS sessions: ${sessions[0]} .. ${sessions.at(-1)}) ===\n`,
  )
  let allGatesPassed = true
  for (const r of results) {
    console.log(
      `[Slip ${r.slippageBps.toFixed(1)} bp RT] Active=${r.activeSessions}/${r.totalSessions} (${(r.activeRate * 100).toFixed(1)}%) | ` +
        `Trades=${r.totalTrades} (ORB30=${r.orbTrades} $${r.orbNet.toFixed(0)}, MR=${r.mrTrades} $${r.mrNet.toFixed(0)}, ZAB=${r.zabTrades} $${r.zabNet.toFixed(0)}) | ` +
        `ConcurrentOverlaps=${r.totalConcurrentOverlaps} | ` +
        `Net=$${r.totalNet.toFixed(0)} (L/S=$${r.longNet.toFixed(0)}/$${r.shortNet.toFixed(0)}, SPY-Excess L/S=$${r.longExcess.toFixed(0)}/$${r.shortExcess.toFixed(0)}) | ` +
        `Folds=[${r.folds.map((f) => `$${f.toFixed(0)}`).join(', ')}] | MaxDD=$${r.maxDd.toFixed(0)} | Sharpe=${r.sharpe.toFixed(2)} | ` +
        `PlannerBlocks=${r.totalPlannerBlocks}`,
    )
    if (r.slippageBps === 2) {
      console.log('  Recent 5 sessions @ 2bp RT:')
      for (const d of r.recentDays) {
        console.log(`    ${d.date}: trades=${d.trades}, net=$${d.pnl.toFixed(2)}`)
      }
    }
    const passed =
      r.activeRate >= 0.95 &&
      r.totalPlannerBlocks === 0 &&
      r.totalConcurrentOverlaps > 0 &&
      r.totalNet > 0 &&
      (r.slippageBps > 5 || (r.orbNet > 0 && r.mrNet > 0 && r.zabNet > 0 && r.folds.every((f) => f > 0)))
    if (!passed) allGatesPassed = false
  }
  console.log(`\nMulti-Engine Concurrent Alpha Gate: ${allGatesPassed ? 'PASSED' : 'FAILED'}`)
  if (!allGatesPassed) process.exit(1)
}
