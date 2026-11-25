import { Result } from 'effect'

import { equityShortIsEligible, type EquityShortEligibility } from '../../execution/equity-short'
import { JevContractError } from '../../jev/contract'
import { exchangeSessions, isContinuousMarket } from '../../market-hours'
import type { IntradayBar, IntradayQuote } from '../../market-data/intraday/model'
import type { StrategyMarketSnapshot } from '../../market-data/streaming/snapshot'
import { priceNumberToMicros } from '../execution-model/fixed-point'
import { IntradayAlphaPhase, IntradayAlphaSetup, type IntradayAlphaPolicyMaterial } from './policy'

const unavailable = (message: string) => Result.fail(new JevContractError({ message }))

export interface SessionBarStats {
  readonly symbol: string
  readonly bars: readonly IntradayBar[]
  readonly sessionOpenPrice: number
  readonly latestBar: IntradayBar
  readonly previousBar: IntradayBar | undefined
  readonly sessionVwap: number
  readonly vwapDevBps: number
}

export interface OpeningRange {
  readonly high: number
  readonly low: number
  readonly barCount: number
}

export interface AlphaRankedCandidate {
  readonly symbol: string
  readonly setup: IntradayAlphaSetup
  readonly direction: 'LONG' | 'SHORT'
  readonly phase: IntradayAlphaPhase.MorningOrb | IntradayAlphaPhase.MiddayReversion
  readonly scoreBps: number
  readonly relVwapDevBps: number
  readonly sessionOpenPrice: number
  readonly sessionVwap: number
  readonly latestClose: number
  readonly bars: readonly IntradayBar[]
}

export interface SelectedAlphaLeg {
  readonly symbol: string
  readonly setup: IntradayAlphaSetup
  readonly direction: 'LONG' | 'SHORT'
  readonly phase: IntradayAlphaPhase.MorningOrb | IntradayAlphaPhase.MiddayReversion
  readonly targetWeight: number
  readonly protectiveStopBps: number
  readonly profitTargetBps: number
  readonly maximumHoldingMinutes: number
  readonly scoreBps: number
  readonly relVwapDevBps: number
}

export interface AlphaSessionContext {
  readonly completedMinuteFromOpen: number
  readonly sessionOpenMs: number
  readonly sessionCloseMs: number
  readonly rangeEndMs: number
  readonly phase: IntradayAlphaPhase
}

/**
 * Volume-weighted observed session VWAP using bar.vwap (falling back to typical price
 * only if source vwap is null). Resilient to single silent IEX minutes.
 */
export const computeObservedSessionVwap = (
  bars: readonly IntradayBar[],
  sessionOpenMs: number,
  rangeEndMs: number,
): number | null => {
  let priceVolume = 0
  let totalVolume = 0
  for (const bar of bars) {
    const at = Date.parse(bar.eventAt)
    if (at < sessionOpenMs || at >= rangeEndMs || bar.volume <= 0) continue
    const price = bar.vwap ?? (bar.high + bar.low + bar.close) / 3
    if (!Number.isFinite(price) || price <= 0) continue
    priceVolume += price * bar.volume
    totalVolume += bar.volume
  }
  return totalVolume > 0 ? priceVolume / totalVolume : null
}

export const computeOpeningRange = (
  bars: readonly IntradayBar[],
  sessionOpenMs: number,
  openingRangeMinutes: number,
  minimumBars: number,
): OpeningRange | null => {
  const cutoffMs = sessionOpenMs + openingRangeMinutes * 60_000
  let high = Number.NEGATIVE_INFINITY
  let low = Number.POSITIVE_INFINITY
  let barCount = 0
  for (const bar of bars) {
    const at = Date.parse(bar.eventAt)
    if (at < sessionOpenMs || at >= cutoffMs) continue
    if (bar.high > high) high = bar.high
    if (bar.low < low) low = bar.low
    barCount++
  }
  if (barCount < minimumBars || !Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null
  return { high, low, barCount }
}

export const alphaQuoteSpreadAcceptable = (
  quote: Pick<IntradayQuote, 'bidPrice' | 'askPrice' | 'bidSize' | 'askSize'>,
  maximumEntrySpreadBps: number,
): Result.Result<boolean, JevContractError> =>
  Result.gen(function* () {
    if (quote.bidSize <= 0 || quote.askSize <= 0) return false
    const bid = yield* priceNumberToMicros(quote.bidPrice, 'alpha bid', 'DOWN').pipe(
      Result.mapError((cause) => new JevContractError({ message: 'Alpha quote bid is invalid', cause })),
    )
    const ask = yield* priceNumberToMicros(quote.askPrice, 'alpha ask', 'UP').pipe(
      Result.mapError((cause) => new JevContractError({ message: 'Alpha quote ask is invalid', cause })),
    )
    if (bid <= 0n || ask < bid) return false
    return (ask - bid) * 20_000n <= BigInt(maximumEntrySpreadBps) * (ask + bid)
  })

export const resolveAlphaSessionContext = (input: {
  readonly snapshot: Pick<StrategyMarketSnapshot, 'manifest'>
  readonly policy: IntradayAlphaPolicyMaterial
  readonly middayReversionCompleted?: boolean
}): Result.Result<AlphaSessionContext, JevContractError> => {
  const { manifest } = input.snapshot
  if (isContinuousMarket(manifest.calendar))
    return unavailable('Intraday alpha requires an exchange-session equity calendar')
  const session = exchangeSessions(manifest.calendar).find((entry) => entry.date === manifest.sessionDate)
  if (session === undefined) return unavailable('Intraday alpha snapshot has no matching regular session')
  const sessionOpenMs = Date.parse(session.openAt)
  const sessionCloseMs = Date.parse(session.closeAt)
  const rangeEndMs = Date.parse(manifest.rangeEndAt)
  // The latest completed 1m bar starts at rangeEndMs - 60_000.
  const completedMinuteFromOpen = Math.floor((rangeEndMs - sessionOpenMs) / 60_000) - 1
  const { morningOrb, middayReversion } = input.policy
  let phase = IntradayAlphaPhase.OutsideWindow
  if (
    completedMinuteFromOpen >= morningOrb.entryStartMinuteFromOpen &&
    completedMinuteFromOpen <= morningOrb.entryEndMinuteFromOpen
  ) {
    phase = IntradayAlphaPhase.MorningOrb
  } else if (
    input.middayReversionCompleted !== true &&
    completedMinuteFromOpen >= middayReversion.entryStartMinuteFromOpen &&
    completedMinuteFromOpen <= middayReversion.entryEndMinuteFromOpen
  ) {
    phase = IntradayAlphaPhase.MiddayReversion
  }
  return Result.succeed({
    completedMinuteFromOpen,
    sessionOpenMs,
    sessionCloseMs,
    rangeEndMs,
    phase,
  })
}

const countRecentBars = (bars: readonly IntradayBar[], rangeEndMs: number, windowMinutes: number): number => {
  const cutoffMs = rangeEndMs - windowMinutes * 60_000
  let count = 0
  for (const bar of bars) {
    const at = Date.parse(bar.eventAt)
    if (at >= cutoffMs && at < rangeEndMs) count++
  }
  return count
}

const symbolSessionStats = (
  bars: readonly IntradayBar[],
  symbol: string,
  sessionOpenMs: number,
  rangeEndMs: number,
  expectedLatestEventMs: number,
): SessionBarStats | null => {
  const ordered = bars
    .filter((bar) => {
      if (bar.symbol !== symbol) return false
      const at = Date.parse(bar.eventAt)
      return at >= sessionOpenMs && at < rangeEndMs
    })
    .toSorted((left, right) => left.eventAt.localeCompare(right.eventAt))
  const first = ordered[0]
  const latest = ordered.at(-1)
  if (first === undefined || latest === undefined || Date.parse(latest.eventAt) !== expectedLatestEventMs) return null
  const sessionVwap = computeObservedSessionVwap(ordered, sessionOpenMs, rangeEndMs)
  if (sessionVwap === null || sessionVwap <= 0) return null
  return {
    symbol,
    bars: ordered,
    sessionOpenPrice: first.open,
    latestBar: latest,
    previousBar: ordered.length >= 2 ? ordered.at(-2) : undefined,
    sessionVwap,
    vwapDevBps: (latest.close / sessionVwap - 1) * 10_000,
  }
}

export const extractIntradayAlphaCandidates = (input: {
  readonly snapshot: StrategyMarketSnapshot
  readonly policy: IntradayAlphaPolicyMaterial
  readonly accountId: string
  readonly equityShortEligibility?: Readonly<Record<string, EquityShortEligibility>>
  readonly morningOrbTakenSymbols?: readonly string[]
  readonly middayReversionCompleted?: boolean
}): Result.Result<
  {
    readonly context: AlphaSessionContext
    readonly spyVwapDevBps: number | null
    readonly longPool: readonly AlphaRankedCandidate[]
    readonly shortPool: readonly AlphaRankedCandidate[]
  },
  JevContractError
> =>
  Result.gen(function* () {
    const context = yield* resolveAlphaSessionContext({
      snapshot: input.snapshot,
      policy: input.policy,
      ...(input.middayReversionCompleted === undefined
        ? {}
        : { middayReversionCompleted: input.middayReversionCompleted }),
    })
    if (context.phase === IntradayAlphaPhase.OutsideWindow) {
      return { context, spyVwapDevBps: null, longPool: [], shortPool: [] }
    }
    const expectedLatestEventMs = context.rangeEndMs - 60_000
    const spy = symbolSessionStats(
      input.snapshot.bars,
      input.policy.benchmarkSymbol,
      context.sessionOpenMs,
      context.rangeEndMs,
      expectedLatestEventMs,
    )
    if (spy === null) {
      return { context, spyVwapDevBps: null, longPool: [], shortPool: [] }
    }
    const excluded = new Set(input.snapshot.manifest.candidateExclusions?.map((entry) => entry.symbol) ?? [])
    const takenOrb = new Set(input.morningOrbTakenSymbols ?? [])
    const canShort = (symbol: string) =>
      equityShortIsEligible(
        input.equityShortEligibility?.[symbol],
        input.accountId,
        symbol,
        input.snapshot.manifest.observedAt,
      )

    const longPool: AlphaRankedCandidate[] = []
    const shortPool: AlphaRankedCandidate[] = []

    if (context.phase === IntradayAlphaPhase.MorningOrb) {
      if (takenOrb.size >= input.policy.morningOrb.maxTradesPerSession) {
        return { context, spyVwapDevBps: spy.vwapDevBps, longPool, shortPool }
      }
      const spyAboveVwap = spy.latestBar.close > spy.sessionVwap
      for (const symbol of input.policy.candidateSymbols) {
        if (excluded.has(symbol) || takenOrb.has(symbol)) continue
        const quote = input.snapshot.latestQuotes[symbol]
        if (quote === undefined) continue
        if (!(yield* alphaQuoteSpreadAcceptable(quote, input.policy.maximumEntrySpreadBps))) continue
        const stats = symbolSessionStats(
          input.snapshot.bars,
          symbol,
          context.sessionOpenMs,
          context.rangeEndMs,
          expectedLatestEventMs,
        )
        if (stats === null) continue
        if (countRecentBars(stats.bars, context.rangeEndMs, 15) < input.policy.morningOrb.minimumRecent15MinBars)
          continue
        const openingRange = computeOpeningRange(
          stats.bars,
          context.sessionOpenMs,
          input.policy.morningOrb.openingRangeMinutes,
          input.policy.morningOrb.minimumOpeningRangeBars,
        )
        if (openingRange === null) continue
        const close = stats.latestBar.close
        const previousClose = stats.previousBar?.close ?? stats.latestBar.open
        const relVwapDevBps = stats.vwapDevBps - spy.vwapDevBps
        if (
          spyAboveVwap &&
          close > openingRange.high &&
          previousClose <= openingRange.high &&
          close > stats.sessionVwap
        ) {
          longPool.push({
            symbol,
            setup: IntradayAlphaSetup.Orb30Long,
            direction: 'LONG',
            phase: IntradayAlphaPhase.MorningOrb,
            scoreBps: (close / openingRange.high - 1) * 10_000,
            relVwapDevBps,
            sessionOpenPrice: stats.sessionOpenPrice,
            sessionVwap: stats.sessionVwap,
            latestClose: close,
            bars: stats.bars,
          })
        } else if (
          !spyAboveVwap &&
          canShort(symbol) &&
          close < openingRange.low &&
          previousClose >= openingRange.low &&
          close < stats.sessionVwap
        ) {
          shortPool.push({
            symbol,
            setup: IntradayAlphaSetup.Orb30Short,
            direction: 'SHORT',
            phase: IntradayAlphaPhase.MorningOrb,
            scoreBps: (1 - close / openingRange.low) * 10_000,
            relVwapDevBps,
            sessionOpenPrice: stats.sessionOpenPrice,
            sessionVwap: stats.sessionVwap,
            latestClose: close,
            bars: stats.bars,
          })
        }
      }
      longPool.sort((a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol))
      shortPool.sort((a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol))
      return { context, spyVwapDevBps: spy.vwapDevBps, longPool, shortPool }
    }

    // Phase 1: Midday Relative-VWAP Overreaction Reversion (11:30–12:00 ET -> 15:55 EOD)
    const ranked: {
      readonly stats: SessionBarStats
      readonly relVwapDevBps: number
      readonly shortable: boolean
    }[] = []
    for (const symbol of input.policy.candidateSymbols) {
      if (excluded.has(symbol)) continue
      const quote = input.snapshot.latestQuotes[symbol]
      if (quote === undefined) continue
      if (!(yield* alphaQuoteSpreadAcceptable(quote, input.policy.maximumEntrySpreadBps))) continue
      const stats = symbolSessionStats(
        input.snapshot.bars,
        symbol,
        context.sessionOpenMs,
        context.rangeEndMs,
        expectedLatestEventMs,
      )
      if (
        stats === null ||
        stats.bars.length < input.policy.middayReversion.minimumSessionBars ||
        countRecentBars(stats.bars, context.rangeEndMs, 15) < input.policy.middayReversion.minimumRecent15MinBars
      )
        continue
      ranked.push({
        stats,
        relVwapDevBps: stats.vwapDevBps - spy.vwapDevBps,
        shortable: canShort(symbol),
      })
    }
    // Cross-sectional laggards vs SPY -> Long (lowest relVwapDevBps first)
    for (const entry of ranked.toSorted(
      (a, b) => a.relVwapDevBps - b.relVwapDevBps || a.stats.symbol.localeCompare(b.stats.symbol),
    )) {
      longPool.push({
        symbol: entry.stats.symbol,
        setup: IntradayAlphaSetup.MiddayVwapReversionLong,
        direction: 'LONG',
        phase: IntradayAlphaPhase.MiddayReversion,
        scoreBps: -entry.relVwapDevBps,
        relVwapDevBps: entry.relVwapDevBps,
        sessionOpenPrice: entry.stats.sessionOpenPrice,
        sessionVwap: entry.stats.sessionVwap,
        latestClose: entry.stats.latestBar.close,
        bars: entry.stats.bars,
      })
    }
    // Cross-sectional leaders vs SPY -> Short (highest relVwapDevBps first, borrow-eligible)
    for (const entry of ranked
      .filter((item) => item.shortable)
      .toSorted((a, b) => b.relVwapDevBps - a.relVwapDevBps || a.stats.symbol.localeCompare(b.stats.symbol))) {
      shortPool.push({
        symbol: entry.stats.symbol,
        setup: IntradayAlphaSetup.MiddayVwapReversionShort,
        direction: 'SHORT',
        phase: IntradayAlphaPhase.MiddayReversion,
        scoreBps: entry.relVwapDevBps,
        relVwapDevBps: entry.relVwapDevBps,
        sessionOpenPrice: entry.stats.sessionOpenPrice,
        sessionVwap: entry.stats.sessionVwap,
        latestClose: entry.stats.latestBar.close,
        bars: entry.stats.bars,
      })
    }
    return { context, spyVwapDevBps: spy.vwapDevBps, longPool, shortPool }
  })

export const selectIntradayAlphaLegs = (input: {
  readonly context: AlphaSessionContext
  readonly policy: IntradayAlphaPolicyMaterial
  readonly longPool: readonly AlphaRankedCandidate[]
  readonly shortPool: readonly AlphaRankedCandidate[]
  readonly vetoedSymbols: ReadonlySet<string>
}): readonly SelectedAlphaLeg[] => {
  const { context, policy, vetoedSymbols } = input
  if (context.phase === IntradayAlphaPhase.OutsideWindow) return []

  const longs = input.longPool.filter((candidate) => !vetoedSymbols.has(candidate.symbol))
  const shorts = input.shortPool.filter((candidate) => !vetoedSymbols.has(candidate.symbol))

  if (context.phase === IntradayAlphaPhase.MorningOrb) {
    const combined = [...longs, ...shorts].toSorted(
      (a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol),
    )
    const entryMinute = context.completedMinuteFromOpen + 1
    const remainingBeforeHardExit = Math.max(1, policy.morningOrb.hardExitMinuteFromOpen - entryMinute)
    const holdMinutes = Math.min(policy.morningOrb.maximumHoldingMinutes, remainingBeforeHardExit)
    return combined.slice(0, policy.morningOrb.maximumPositions).map((candidate) => ({
      symbol: candidate.symbol,
      setup: candidate.setup,
      direction: candidate.direction,
      phase: IntradayAlphaPhase.MorningOrb as const,
      targetWeight: policy.morningOrb.targetWeightPerLeg,
      protectiveStopBps: policy.morningOrb.protectiveStopBps,
      profitTargetBps: policy.morningOrb.profitTargetBps,
      maximumHoldingMinutes: holdMinutes,
      scoreBps: candidate.scoreBps,
      relVwapDevBps: candidate.relVwapDevBps,
    }))
  }

  // Phase 1: Dollar-neutral paired reversion (up to 2L + 2S), ensuring disjoint symbols with positive
  // cross-sectional dispersion (short relVwapDevBps > long relVwapDevBps).
  const entryMinute = context.completedMinuteFromOpen + 1
  const holdMinutes = Math.max(
    15,
    Math.min(policy.maximumHoldingMinutes, policy.middayReversion.flattenMinuteFromOpen - entryMinute),
  )
  const used = new Set<string>()
  const paired: AlphaRankedCandidate[] = []
  for (let pair = 0; pair < policy.middayReversion.targetPairs; pair++) {
    const longPick = longs.find((candidate) => !used.has(candidate.symbol))
    if (longPick === undefined) break
    const shortPick = shorts.find(
      (candidate) =>
        !used.has(candidate.symbol) &&
        candidate.symbol !== longPick.symbol &&
        candidate.relVwapDevBps > longPick.relVwapDevBps,
    )
    if (shortPick === undefined) break
    used.add(longPick.symbol)
    used.add(shortPick.symbol)
    paired.push(longPick, shortPick)
  }
  if (paired.length > 0) {
    return paired
      .map((candidate) => ({
        symbol: candidate.symbol,
        setup: candidate.setup,
        direction: candidate.direction,
        phase: IntradayAlphaPhase.MiddayReversion as const,
        targetWeight: policy.middayReversion.targetWeightPerLeg,
        protectiveStopBps: policy.middayReversion.protectiveStopBps,
        profitTargetBps: policy.middayReversion.profitTargetBps,
        maximumHoldingMinutes: holdMinutes,
        scoreBps: candidate.scoreBps,
        relVwapDevBps: candidate.relVwapDevBps,
      }))
      .toSorted((a, b) => a.symbol.localeCompare(b.symbol))
  }

  // Anti-starvation fallback: if borrow eligibility blocks all shorts on a day, take the single most oversold long.
  const fallback = longs.find((candidate) => candidate.relVwapDevBps < 0) ?? longs[0] ?? shorts[0]
  if (fallback === undefined) return []
  return [
    {
      symbol: fallback.symbol,
      setup: fallback.setup,
      direction: fallback.direction,
      phase: IntradayAlphaPhase.MiddayReversion as const,
      targetWeight: policy.middayReversion.fallbackSingleLegWeight,
      protectiveStopBps: policy.middayReversion.protectiveStopBps,
      profitTargetBps: policy.middayReversion.profitTargetBps,
      maximumHoldingMinutes: holdMinutes,
      scoreBps: fallback.scoreBps,
      relVwapDevBps: fallback.relVwapDevBps,
    },
  ]
}
