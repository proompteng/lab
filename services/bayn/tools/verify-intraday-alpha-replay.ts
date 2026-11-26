import { readFileSync } from 'node:fs'
import { Result, Schema } from 'effect'

import { MarketCalendarQueryBase, MarketCalendarResponseSchema } from '../src/broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import { AccountStatus, OrderSide, OrderType, ReconciliationStatus, TimeInForce } from '../src/execution/contracts'
import type { EquityShortEligibility } from '../src/execution/equity-short'
import { canonicalHashV1Result, sha256 } from '../src/hash'
import { decodeJevPortfolio, JevPurpose } from '../src/jev/portfolio'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../src/jev/protocol'
import {
  IntradayBenchmarkEvidencePolicy,
  IntradayCandidateEvidencePolicy,
  type IntradayBar,
  type IntradayQuote,
} from '../src/market-data/intraday/model'
import type { StrategyMarketSnapshot } from '../src/market-data/streaming/snapshot'
import { IsoDateSchema, strictParseOptions } from '../src/schemas'
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
  resolveAlphaRegularSession,
  selectIntradayAlphaLegs,
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
  readonly phase: IntradayAlphaPhase.MorningOrb | IntradayAlphaPhase.MiddayReversion
  readonly symbol: string
  readonly direction: 'LONG' | 'SHORT'
  readonly shares: number
  readonly entryPrice: number
  readonly exitPrice: number
  readonly entryAt: string
  readonly exitAt: string
  readonly exitReason: 'STOP' | 'TARGET' | 'MAX_HOLD' | 'EOD'
  readonly grossPnlUsd: number
  readonly netPnlUsd: number
  readonly spyExcessUsd: number
}

const ReplayCalendarSchema = Schema.Struct({
  query: MarketCalendarQueryBase,
  response: MarketCalendarResponseSchema,
})
type ReplayCalendar = Result.Result.Success<ReturnType<typeof normalizeMarketCalendarResult>>

interface EntryAttempt {
  readonly phase: IntradayAlphaPhase.MorningOrb | IntradayAlphaPhase.MiddayReversion
  readonly observedAt: string
  readonly selectedSymbols: readonly string[]
  readonly filledSymbols: string[]
  longEntryNotionalUsd: number
  shortEntryNotionalUsd: number
}

interface UnresolvedExit {
  readonly symbol: string
  readonly entryAt: string
  readonly exitDueAt: string
  readonly reason: 'POST_DEADLINE_PRICE_UNAVAILABLE'
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

// Hypothetical sell-side cost scenario; this is not an actual fee reconciliation.
const MODELED_SELL_FEE_BPS = 0.21

const parseBarsFiles = (paths: readonly string[], calendar: ReplayCalendar) => {
  const dedup = new Map<string, RawBar>()
  const sources: { readonly path: string; readonly sha256: string; readonly bytes: number }[] = []
  let identicalDuplicates = 0
  let ignoredSymbols = 0
  for (const filePath of paths) {
    const content = readFileSync(filePath, 'utf8')
    sources.push({ path: filePath, sha256: sha256(content), bytes: Buffer.byteLength(content) })
    for (const [index, line] of content.split('\n').entries()) {
      if (line.length === 0) continue
      const cols = line.split('\t')
      const symbol = cols[0] ?? ''
      if (!allowedSymbols.has(symbol)) {
        ignoredSymbols++
        continue
      }
      if (cols.length < 8) throw new Error(`Incomplete bar in ${filePath}:${index + 1}`)
      const rawAt = cols[1] ?? ''
      const eventMs = Date.parse(rawAt)
      if (!Number.isFinite(eventMs) || eventMs % 60_000 !== 0)
        throw new Error(`Invalid minute timestamp in ${filePath}:${index + 1}`)
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
        throw new Error(`Invalid OHLCV bar in ${filePath}:${index + 1}`)
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

const makeFlatPortfolio = (observedAt: string, equityUsd: number) => {
  const equityMicros = BigInt(Math.round(equityUsd * 1_000_000)).toString()
  const material = {
    account: {
      schemaVersion: 'bayn.paper-account-snapshot.v2' as const,
      accountId,
      status: AccountStatus.Active,
      currency: 'USD' as const,
      cashMicros: equityMicros,
      buyingPowerMicros: equityMicros, // strict 1x cash-only stress test!
      equityMicros,
      cryptoFeeTier: null,
      observedAt,
    },
    positions: [] as const,
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

const simulateSession = (input: {
  readonly sessionDate: string
  readonly calendar: ReplayCalendar
  readonly symMap: Map<string, RawBar[]>
  readonly slippageRtBps: number
  readonly startingCapitalUsd: number
}): {
  readonly trades: readonly TradeOutcome[]
  readonly plannerBlocks: number
  readonly attempts: readonly EntryAttempt[]
  readonly unresolvedExits: readonly UnresolvedExit[]
  readonly expectedRegularMinutes: number
  readonly benchmarkMinutes: number
  readonly ambiguousExitBars: number
  readonly stopLimitGapBars: number
} => {
  const regular = Result.getOrThrow(resolveAlphaRegularSession(input.calendar, input.sessionDate))
  const sessionOpenMs = regular.openMs
  const expectedRegularMinutes = (regular.closeMs - sessionOpenMs) / 60_000
  // Match closeWindowForCycle: alpha's fixed flatten time is also capped by the actual regular close.
  const flattenMs = Math.min(
    sessionOpenMs + policy.middayReversion.flattenMinuteFromOpen * 60_000,
    regular.closeMs - protocol.flattenBeforeCloseMinutes * 60_000,
  )
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
  let ambiguousExitBars = 0
  let stopLimitGapBars = 0
  let plannerBlocks = 0
  const morningOrbTakenSymbols: string[] = []
  let middayCompleted = false
  let busyUntilMinute = -1

  const runEntryAtMinute = (completedMinute: number) => {
    const rangeEndMs = sessionOpenMs + (completedMinute + 1) * 60_000
    const snapshot = buildReplaySnapshot({
      sessionDate: input.sessionDate,
      calendar: input.calendar,
      sessionOpenMs,
      rangeEndMs,
      symMap: input.symMap,
      quoteHalfSpreadBps: Math.max(1, input.slippageRtBps / 2),
    })
    const observedAt = snapshot.manifest.observedAt
    const orderExpiresAtMs = Date.parse(observedAt) + 60_000
    const eligibility = makeShortEligibility(observedAt)
    const extracted = Result.getOrThrow(
      extractIntradayAlphaCandidates({
        snapshot,
        policy,
        accountId,
        equityShortEligibility: eligibility,
        morningOrbTakenSymbols,
        middayReversionCompleted: middayCompleted,
      }),
    )
    const legs = selectIntradayAlphaLegs({
      context: extracted.context,
      policy,
      longPool: extracted.longPool,
      shortPool: extracted.shortPool,
      vetoedSymbols: new Set(),
    })
    if (legs.length === 0) return

    const portfolio = makeFlatPortfolio(observedAt, input.startingCapitalUsd)
    const fundedPlans: Record<
      string,
      NonNullable<Result.Result.Success<ReturnType<typeof makeIntradayAlphaFundedExitPlan>>>
    > = {}
    const targetWeights: Record<string, number> = Object.fromEntries(intradayAlphaCandidateSymbols.map((s) => [s, 0]))
    const maxBuy: Record<string, string> = Object.fromEntries(intradayAlphaCandidateSymbols.map((s) => [s, '0']))
    const maxSell: Record<string, string> = Object.fromEntries(intradayAlphaCandidateSymbols.map((s) => [s, '0']))

    for (const leg of legs) {
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
      if (leg.direction === 'LONG') maxBuy[leg.symbol] = funded.plan.maximumQuantityAtoms
      else maxSell[leg.symbol] = funded.plan.maximumQuantityAtoms
    }
    const selectedSymbols = Object.keys(fundedPlans).sort()
    if (selectedSymbols.length === 0) return

    // Exercise actual production target-planner (planTargets) with bar-close reference prices (matching compileJevEntry)
    const priceMicros: Record<string, string> = {}
    const bidPriceMicros: Record<string, string> = {}
    const askPriceMicros: Record<string, string> = {}
    for (const symbol of intradayAlphaCandidateSymbols) {
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
    const planned = Result.getOrThrow(
      planTargets({
        schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
        strategyName: 'jev',
        cycleId,
        decisionHash: 'e'.repeat(64),
        policyHash,
        accountId,
        signalDate: Schema.decodeUnknownSync(IsoDateSchema)(input.sessionDate),
        targetWeights,
        referencePrices: { ...refMaterial, contentHash: refHash },
        brokerState: portfolio.brokerState,
        precision: protocol.executionModel.precision,
        allocationCapitalMicros: portfolio.brokerState.account.equityMicros,
        maximumInputAgeMs: 60_000,
        submissionCutoffAt: utcInstantFromEpochMillis(orderExpiresAtMs),
        observedAt,
        executionTerms: {
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
      return
    }

    const phase =
      extracted.context.phase === IntradayAlphaPhase.MorningOrb
        ? IntradayAlphaPhase.MorningOrb
        : IntradayAlphaPhase.MiddayReversion
    const attempt: EntryAttempt = {
      phase,
      observedAt,
      selectedSymbols,
      filledSymbols: [],
      longEntryNotionalUsd: 0,
      shortEntryNotionalUsd: 0,
    }
    attempts.push(attempt)
    // Production session history counts committed decisions with intents, including unfilled/expired orders.
    if (phase === IntradayAlphaPhase.MorningOrb) morningOrbTakenSymbols.push(...selectedSymbols)
    else middayCompleted = true

    const entryMinute = Math.ceil((Date.parse(observedAt) - sessionOpenMs) / 60_000)
    let latestExitMinute = Math.ceil((orderExpiresAtMs - sessionOpenMs) / 60_000) - 1
    const spyByMin = barByMinute.get(intradayAlphaBenchmarkSymbol)
    const perSideSlipMult = input.slippageRtBps / 2 / 10_000
    for (const intent of planned.intentTargets) {
      const funded = fundedPlans[intent.symbol]
      if (funded === undefined) continue
      const symBars = barByMinute.get(intent.symbol)
      const isLong = intent.side === OrderSide.Buy
      const levels = funded.plan.levels
      const limitPrice =
        Number('maximumEntryPriceMicros' in levels ? levels.maximumEntryPriceMicros : levels.minimumEntryPriceMicros) /
        1_000_000
      // Minute bars cannot establish the time or queue priority of an intrabar touch.
      // A post-decision open within the working window is our conservative executable-price proxy.
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
      const { minute: fillMinute, price: entryPrice } = fill
      const shares = Number(BigInt(intent.quantityAtoms) / 1_000_000_000n)
      if (shares <= 0) continue
      attempt.filledSymbols.push(intent.symbol)
      if (isLong) attempt.longEntryNotionalUsd += entryPrice * shares
      else attempt.shortEntryNotionalUsd += entryPrice * shares

      const stopPrice = Number(BigInt(funded.plan.levels.stopPriceMicros)) / 1_000_000
      const stopLimitPrice = Number(BigInt(levels.stopLimitPriceMicros)) / 1_000_000
      const targetPrice = Number(BigInt(levels.profitLimitPriceMicros)) / 1_000_000
      // Production measures the entry-bound duration from the actual first fill. The plan does not
      // carry a second absolute morning deadline, so do not invent one in replay for a delayed fill.
      const phaseHoldMinute = fillMinute + funded.plan.levels.maximumHoldingMinutes
      const exitDueMs = Math.min(sessionOpenMs + phaseHoldMinute * 60_000, flattenMs)

      let exitPrice: number | undefined
      let exitMinute = expectedRegularMinutes
      let exitReason: TradeOutcome['exitReason'] = exitDueMs === flattenMs ? 'EOD' : 'MAX_HOLD'

      let stopTriggered = false
      const clearsStopLimit = (price: number) => (isLong ? price >= stopLimitPrice : price <= stopLimitPrice)
      for (let m = fillMinute; m < expectedRegularMinutes; m++) {
        const bar = symBars?.get(m)
        if (bar === undefined) continue
        // A bar close before the deadline cannot prove an exit. Use a subsequent open, strictly after
        // the close/hold decision, so the price proxy cannot precede the order it purports to fill.
        if (bar.eventMs > exitDueMs) {
          exitPrice = bar.open
          exitMinute = m
          break
        }
        const openedThroughStop = isLong ? bar.open <= stopPrice : bar.open >= stopPrice
        const touchedStop = isLong ? bar.low <= stopPrice : bar.high >= stopPrice
        const touchedTarget = isLong ? bar.high >= targetPrice : bar.low <= targetPrice
        if (!stopTriggered && touchedStop && touchedTarget) ambiguousExitBars++
        if (stopTriggered || touchedStop) {
          // After activation, a gap through the limit leaves a working order. Use the open only
          // when activation is already known, otherwise require an executable price after the trigger.
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
            stopLimitGapBars++
            continue
          }
          exitReason = 'STOP'
          exitMinute = m
          break
        }
        if (touchedTarget) {
          exitPrice = isLong ? Math.max(bar.open, targetPrice) : Math.min(bar.open, targetPrice)
          exitReason = 'TARGET'
          exitMinute = m
          break
        }
      }
      if (exitPrice === undefined) {
        unresolvedExits.push({
          symbol: intent.symbol,
          entryAt: utcInstantFromEpochMillis(sessionOpenMs + fillMinute * 60_000),
          exitDueAt: utcInstantFromEpochMillis(exitDueMs),
          reason: 'POST_DEADLINE_PRICE_UNAVAILABLE',
        })
        latestExitMinute = expectedRegularMinutes
        continue
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
      const feeUsd = (sellNotional * MODELED_SELL_FEE_BPS) / 10_000
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
        entryAt: utcInstantFromEpochMillis(sessionOpenMs + fillMinute * 60_000),
        exitAt: utcInstantFromEpochMillis(sessionOpenMs + exitMinute * 60_000),
        exitReason,
        grossPnlUsd,
        netPnlUsd,
        spyExcessUsd: netPnlUsd - spyLegPnl,
      })
      if (exitMinute > latestExitMinute) latestExitMinute = exitMinute
    }

    busyUntilMinute = latestExitMinute
  }

  // Scan the policy's morning completed-bar window; do not duplicate its thresholds here.
  for (let m = policy.morningOrb.entryStartMinuteFromOpen; m <= policy.morningOrb.entryEndMinuteFromOpen; m++) {
    if (m <= busyUntilMinute) continue
    if (morningOrbTakenSymbols.length >= policy.morningOrb.maxTradesPerSession) break
    runEntryAtMinute(m)
  }

  // Midday Reversion scan (completedMinute 120..150 = 11:30..12:00 ET)
  for (
    let m = policy.middayReversion.entryStartMinuteFromOpen;
    m <= policy.middayReversion.entryEndMinuteFromOpen;
    m++
  ) {
    if (middayCompleted) break
    if (m <= busyUntilMinute) continue
    runEntryAtMinute(m)
  }

  return {
    trades,
    plannerBlocks,
    attempts,
    unresolvedExits,
    expectedRegularMinutes,
    benchmarkMinutes: spyBars.length,
    ambiguousExitBars,
    stopLimitGapBars,
  }
}

export const runIntradayAlphaReplayVerification = (paths: readonly string[], calendarInput: unknown) => {
  if (paths.length === 0) throw new Error('At least one bar file is required')
  const calendarSource = Schema.decodeUnknownSync(ReplayCalendarSchema, strictParseOptions)(calendarInput)
  const calendar = Result.getOrThrow(normalizeMarketCalendarResult(calendarSource.response, calendarSource.query))
  if (calendar.sessions.length === 0) throw new Error('The supplied calendar contains no sessions')
  const { byDate, sources, identicalDuplicates, ignoredSymbols, uniqueBars } = parseBarsFiles(paths, calendar)
  const sessions = [...byDate.keys()].sort()

  const startingCapitalUsd = 100_000
  const results = []
  for (const slippageBps of [2, 5, 10]) {
    const allTrades: TradeOutcome[] = []
    const dailyPnl: {
      readonly date: string
      readonly modeledClosedNet: number
      readonly trades: number
      readonly modeledFilledLegs: number
      readonly unresolvedExits: number
    }[] = []
    const sessionDetails = []
    let totalPlannerBlocks = 0

    for (const date of sessions) {
      const symMap = byDate.get(date)
      if (symMap === undefined) continue
      const outcome = simulateSession({
        sessionDate: date,
        calendar,
        symMap,
        slippageRtBps: slippageBps,
        startingCapitalUsd,
      })
      const { trades, plannerBlocks } = outcome
      sessionDetails.push({ date, ...outcome })
      totalPlannerBlocks += plannerBlocks
      allTrades.push(...trades)
      dailyPnl.push({
        date,
        modeledClosedNet: trades.reduce((sum, t) => sum + t.netPnlUsd, 0),
        trades: trades.length,
        modeledFilledLegs: outcome.attempts.reduce((sum, attempt) => sum + attempt.filledSymbols.length, 0),
        unresolvedExits: outcome.unresolvedExits.length,
      })
    }

    const activeSessions = dailyPnl.filter((d) => d.modeledFilledLegs > 0).length
    const modeledClosedNet = dailyPnl.reduce((sum, d) => sum + d.modeledClosedNet, 0)
    const unresolvedExits = dailyPnl.reduce((sum, d) => sum + d.unresolvedExits, 0)
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
    const longExcess = allTrades.filter((t) => t.direction === 'LONG').reduce((s, t) => s + t.spyExcessUsd, 0)
    const shortExcess = allTrades.filter((t) => t.direction === 'SHORT').reduce((s, t) => s + t.spyExcessUsd, 0)
    const orbTrades = allTrades.filter((t) => t.phase === IntradayAlphaPhase.MorningOrb)
    const mrTrades = allTrades.filter((t) => t.phase === IntradayAlphaPhase.MiddayReversion)
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
            longSpyExcess: observedTrades
              .filter((trade) => trade.direction === 'LONG')
              .reduce((sum, trade) => sum + trade.spyExcessUsd, 0),
            shortSpyExcess: observedTrades
              .filter((trade) => trade.direction === 'SHORT')
              .reduce((sum, trade) => sum + trade.spyExcessUsd, 0),
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
        longSpyExcess: baskets.reduce((sum, basket) => sum + basket.longSpyExcess, 0),
        shortSpyExcess: baskets.reduce((sum, basket) => sum + basket.shortSpyExcess, 0),
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

    results.push({
      slippageBps,
      totalSessions: sessions.length,
      activeSessions,
      activeRate: activeSessions / Math.max(1, sessions.length),
      totalTrades: allTrades.length,
      orbTrades: orbTrades.length,
      orbNet: orbTrades.reduce((s, t) => s + t.netPnlUsd, 0),
      mrTrades: mrTrades.length,
      mrNet: mrTrades.reduce((s, t) => s + t.netPnlUsd, 0),
      longNet,
      shortNet,
      longExcess,
      shortExcess,
      modeledClosedNet,
      totalNet: unresolvedExits === 0 ? modeledClosedNet : null,
      chronologicalSlices: unresolvedExits === 0 ? folds : null,
      maxDd: unresolvedExits === 0 ? maxDd : null,
      sharpe: unresolvedExits === 0 ? sharpe : null,
      totalPlannerBlocks,
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
      recentDays: dailyPnl.slice(-5).map((day) => ({
        ...day,
        modeledNet: day.unresolvedExits === 0 ? day.modeledClosedNet : null,
      })),
      middayBasketAttribution: {
        complete: summarizeBaskets(middayBaskets.filter((basket) => basket.complete)),
        partial: summarizeBaskets(middayBaskets.filter((basket) => basket.filledLegs > 0 && !basket.complete)),
        unfilled: summarizeBaskets(middayBaskets.filter((basket) => basket.filledLegs === 0)),
        bothSidesFilled: summarizeBaskets(middayBaskets.filter((basket) => basket.bothSidesFilled)),
        oneSideFilled: summarizeBaskets(
          middayBaskets.filter((basket) => basket.filledLegs > 0 && !basket.bothSidesFilled),
        ),
      },
      middayBaskets,
      sessionDetails,
    })
  }
  return {
    schemaVersion: 'bayn.intraday-alpha-bar-scenario.v1',
    qualification: 'UNQUALIFIED',
    evidenceClass: 'RETROSPECTIVE_EVENT_TIME_BAR_SCENARIO',
    policyHash,
    calendarHash: calendar.normalizedResponseHash,
    sources,
    inputRows: { uniqueBars, identicalDuplicates, ignoredSymbols },
    assumptions: {
      startingCapitalUsd,
      modeledSellFeeBps: MODELED_SELL_FEE_BPS,
      arrival: 'Completed bars assumed available at minute close; original arrival receipts are unavailable',
      source:
        'Eight-column bars do not independently prove feed, universe or revision selection; retain the export receipt',
      quotes: 'Synthetic quotes around completed closes; historical executable quotes are unavailable',
      borrow: 'Every candidate assumed borrow-eligible; historical eligibility is unavailable',
      entry: 'First full minute open after decision, within original limit and modeled one-minute working window',
      exit: 'OHLC stop/target proxies with stop-first both-touch convention and resting gapped stop limits; first full minute open after time deadline; missing exit prices remain unresolved',
      liquidity:
        'Whole intended quantity assumed filled at the price proxy; capacity and queue priority are unmeasured',
      basket: 'Legs fill independently; planned dollar neutrality does not prove realized neutrality',
      costs:
        'Sell fee and fixed slippage scenarios; operating expense, borrow, impact and real settlement are unmeasured',
      selection:
        'Current candidate universe applied retrospectively; chronological slices are descriptive, not holdout validation',
      runtime:
        'Exercises signal, funding and planner functions; omits ingestion, authority, final risk and broker recovery',
    },
    sessions,
    results,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] !== '--calendar' || args[1] === undefined || args.length < 3) {
    console.error(
      'Usage: bun run tools/verify-intraday-alpha-replay.ts --calendar <calendar_json> <bars_tsv_1> [bars_tsv_2 ...]',
    )
    process.exit(1)
  }
  const calendarInput: unknown = JSON.parse(readFileSync(args[1], 'utf8'))
  console.log(JSON.stringify(runIntradayAlphaReplayVerification(args.slice(2), calendarInput), null, 2))
}
