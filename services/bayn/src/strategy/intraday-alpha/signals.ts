import { Result } from 'effect'

import { equityShortIsEligible, type EquityShortEligibility } from '../../execution/equity-short'
import { JevContractError } from '../../jev/contract'
import { isContinuousMarket, regularEquitySessions, type MarketHours } from '../../market-hours'
import type { IntradayBar } from '../../market-data/intraday/model'
import type { IntradayAlphaTrailingBaseline } from '../../market-data/intraday/trailing-baseline'
import type { StrategyMarketSnapshot } from '../../market-data/streaming/snapshot'
import { IntradayAlphaPhase, IntradayAlphaSetup, type IntradayAlphaPolicyMaterial } from './policy'

// Signal selection deliberately depends only on fields shared by both execution policies.
type AlphaSignalPolicy = Omit<IntradayAlphaPolicyMaterial, 'schemaVersion' | 'entryLimitSlippageBps'>

const unavailable = (message: string) => Result.fail(new JevContractError({ message }))

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value))

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

export interface RegularAlphaSessionBounds {
  readonly openAt: string
  readonly closeAt: string
  readonly openMs: number
  readonly closeMs: number
}

/**
 * Resolve regular US equity trading hours (including early closes) from broker
 * providerSessions rather than the extended 08:00–17:00 IEX data-session envelope.
 */
export const resolveAlphaRegularSession = (
  calendar: MarketHours,
  sessionDate: string,
): Result.Result<RegularAlphaSessionBounds, JevContractError> => {
  if (isContinuousMarket(calendar)) return unavailable('Intraday alpha requires an exchange-session equity calendar')
  const session = regularEquitySessions(calendar).find((entry) => entry.date === sessionDate)
  if (session === undefined) return unavailable('Intraday alpha snapshot has no matching regular session')
  const { openAt, closeAt } = session
  const openMs = Date.parse(openAt)
  const closeMs = Date.parse(closeAt)
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || openMs >= closeMs) {
    return unavailable('Intraday alpha regular session bounds are invalid')
  }
  return Result.succeed({ openAt, closeAt, openMs, closeMs })
}

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
  readonly open: number
  readonly close: number
  readonly high: number
  readonly low: number
  readonly barCount: number
}

export type ActiveAlphaPhase =
  | IntradayAlphaPhase.MorningOrb
  | IntradayAlphaPhase.MiddayReversion
  | IntradayAlphaPhase.NoiseAreaTrend

export interface AlphaRankedCandidate {
  readonly symbol: string
  readonly setup: IntradayAlphaSetup
  readonly direction: 'LONG' | 'SHORT'
  readonly phase: ActiveAlphaPhase
  readonly scoreBps: number
  readonly relVwapDevBps: number
  readonly sessionOpenPrice: number
  readonly sessionVwap: number
  readonly latestClose: number
  readonly atr14Ratio?: number
  readonly targetWeightOverride?: number
  readonly protectiveStopBpsOverride?: number
  readonly profitTargetBpsOverride?: number
  readonly bars: readonly IntradayBar[]
}

export interface SelectedAlphaLeg {
  readonly symbol: string
  readonly setup: IntradayAlphaSetup
  readonly direction: 'LONG' | 'SHORT'
  readonly phase: ActiveAlphaPhase
  readonly targetWeight: number
  readonly protectiveStopBps: number
  readonly profitTargetBps: number
  readonly maximumHoldingMinutes: number
  readonly scoreBps: number
  readonly relVwapDevBps: number
}

export interface AlphaSessionContext {
  readonly completedMinuteFromOpen: number
  readonly elapsedMinutesFromOpen: number
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
  let open = Number.NaN
  let close = Number.NaN
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = Number.NEGATIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  let low = Number.POSITIVE_INFINITY
  let barCount = 0
  for (const bar of bars) {
    const at = Date.parse(bar.eventAt)
    if (at < sessionOpenMs || at >= cutoffMs) continue
    if (at < firstAt) {
      firstAt = at
      open = bar.open
    }
    if (at >= lastAt) {
      lastAt = at
      close = bar.close
    }
    if (bar.high > high) high = bar.high
    if (bar.low < low) low = bar.low
    barCount++
  }
  if (
    barCount < minimumBars ||
    !Number.isFinite(open) ||
    !Number.isFinite(close) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    open <= 0 ||
    close <= 0 ||
    high <= low
  )
    return null
  return { open, close, high, low, barCount }
}

const isNoiseAreaCheckpoint = (elapsedMinutesFromOpen: number, policy: AlphaSignalPolicy): boolean =>
  policy.noiseArea.checkpointMinutesFromOpen.includes(elapsedMinutesFromOpen)

export const resolveAlphaSessionContext = (input: {
  readonly snapshot: Pick<StrategyMarketSnapshot, 'manifest'>
  readonly policy: AlphaSignalPolicy
  readonly middayReversionCompleted?: boolean
  readonly noiseAreaAllTaken?: boolean
}): Result.Result<AlphaSessionContext, JevContractError> => {
  const { manifest } = input.snapshot
  const regular = resolveAlphaRegularSession(manifest.calendar, manifest.sessionDate)
  if (Result.isFailure(regular)) return Result.fail(regular.failure)
  const sessionOpenMs = regular.success.openMs
  const sessionCloseMs = regular.success.closeMs
  const rangeEndMs = Date.parse(manifest.rangeEndAt)
  // The latest completed 1m bar starts at rangeEndMs - 60_000; elapsedMinutesFromOpen = completed + 1.
  const elapsedMinutesFromOpen = Math.floor((rangeEndMs - sessionOpenMs) / 60_000)
  const completedMinuteFromOpen = elapsedMinutesFromOpen - 1
  const { morningOrb, middayReversion } = input.policy
  let phase = IntradayAlphaPhase.OutsideWindow
  if (input.noiseAreaAllTaken !== true && isNoiseAreaCheckpoint(elapsedMinutesFromOpen, input.policy)) {
    phase = IntradayAlphaPhase.NoiseAreaTrend
  } else if (
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
    elapsedMinutesFromOpen,
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

const computeNoiseAreaWeights = (
  policy: AlphaSignalPolicy,
  trailingBaseline: IntradayAlphaTrailingBaseline,
): ReadonlyMap<string, number> => {
  const invAtrs: { readonly symbol: string; readonly invAtr: number }[] = []
  for (const symbol of policy.noiseAreaSymbols) {
    const base = trailingBaseline.symbols[symbol]
    if (base !== undefined && base.priorSessions >= policy.trailingBaseline.minimumSessions && base.atr14Ratio > 0) {
      invAtrs.push({ symbol, invAtr: 1 / base.atr14Ratio })
    }
  }
  const totalInv = invAtrs.reduce((sum, entry) => sum + entry.invAtr, 0)
  const weights = new Map<string, number>()
  if (totalInv <= 0) return weights
  for (const { symbol, invAtr } of invAtrs) {
    const raw = (policy.noiseArea.sleeveGrossWeight * invAtr) / totalInv
    weights.set(symbol, round4(clamp(raw, policy.noiseArea.minimumWeightPerLeg, policy.noiseArea.maximumWeightPerLeg)))
  }
  return weights
}

export const extractIntradayAlphaCandidates = (input: {
  readonly snapshot: StrategyMarketSnapshot
  readonly policy: AlphaSignalPolicy
  readonly trailingBaseline: IntradayAlphaTrailingBaseline
  readonly accountId: string
  readonly equityShortEligibility?: Readonly<Record<string, EquityShortEligibility>>
  readonly occupiedSymbols?: readonly string[]
  readonly morningOrbTakenSymbols?: readonly string[]
  readonly middayReversionCompleted?: boolean
  readonly noiseAreaTakenSymbols?: readonly string[]
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
    const occupied = new Set(input.occupiedSymbols ?? [])
    const takenOrb = new Set(input.morningOrbTakenSymbols ?? [])
    const takenNoise = new Set(input.noiseAreaTakenSymbols ?? [])
    const noiseAllTaken = input.policy.noiseAreaSymbols.every(
      (symbol) => takenNoise.has(symbol) || occupied.has(symbol),
    )

    const initialContext = yield* resolveAlphaSessionContext({
      snapshot: input.snapshot,
      policy: input.policy,
      ...(input.middayReversionCompleted === undefined
        ? {}
        : { middayReversionCompleted: input.middayReversionCompleted }),
      noiseAreaAllTaken: noiseAllTaken,
    })
    if (initialContext.phase === IntradayAlphaPhase.OutsideWindow) {
      return { context: initialContext, spyVwapDevBps: null, longPool: [], shortPool: [] }
    }

    const expectedLatestEventMs = initialContext.rangeEndMs - 60_000
    const spy = symbolSessionStats(
      input.snapshot.bars,
      input.policy.benchmarkSymbol,
      initialContext.sessionOpenMs,
      initialContext.rangeEndMs,
      expectedLatestEventMs,
    )
    if (spy === null) {
      return { context: initialContext, spyVwapDevBps: null, longPool: [], shortPool: [] }
    }

    const excluded = new Set(input.snapshot.manifest.candidateExclusions?.map((entry) => entry.symbol) ?? [])
    const canShort = (symbol: string) =>
      equityShortIsEligible(
        input.equityShortEligibility?.[symbol],
        input.accountId,
        symbol,
        input.snapshot.manifest.observedAt,
      )

    // Engine 3 — Zarattini-Aziz-Barbon Noise Area Momentum on disjoint ETFs (QQQ, SMH) at 30m checkpoints.
    if (initialContext.phase === IntradayAlphaPhase.NoiseAreaTrend) {
      const longPool: AlphaRankedCandidate[] = []
      const shortPool: AlphaRankedCandidate[] = []
      const noiseWeights = computeNoiseAreaWeights(input.policy, input.trailingBaseline)
      const checkpointKey = String(initialContext.elapsedMinutesFromOpen)

      for (const symbol of input.policy.noiseAreaSymbols) {
        if (excluded.has(symbol) || takenNoise.has(symbol) || occupied.has(symbol)) continue
        const quote = input.snapshot.latestQuotes[symbol]
        if (quote === undefined) continue
        const baseline = input.trailingBaseline.symbols[symbol]
        const avgSwing = baseline?.avgSwingByCheckpoint?.[checkpointKey]
        const weight = noiseWeights.get(symbol)
        if (
          baseline === undefined ||
          baseline.priorSessions < input.policy.trailingBaseline.minimumSessions ||
          avgSwing === undefined ||
          weight === undefined
        )
          continue
        const stats = symbolSessionStats(
          input.snapshot.bars,
          symbol,
          initialContext.sessionOpenMs,
          initialContext.rangeEndMs,
          expectedLatestEventMs,
        )
        if (
          stats === null ||
          countRecentBars(stats.bars, initialContext.rangeEndMs, 15) < input.policy.noiseArea.minimumRecent15MinBars
        )
          continue

        const upperBand = Math.max(stats.sessionOpenPrice, baseline.prevClose) * (1 + avgSwing)
        const lowerBand = Math.min(stats.sessionOpenPrice, baseline.prevClose) * (1 - avgSwing)
        const close = stats.latestBar.close
        const stopBps = clamp(
          Math.round(baseline.atr14Ratio * 10_000 * input.policy.noiseArea.stopAtrMultiple),
          input.policy.noiseArea.minimumStopBps,
          input.policy.noiseArea.maximumStopBps,
        )
        const relVwapDevBps = stats.vwapDevBps - spy.vwapDevBps

        if (close > upperBand && close > stats.sessionVwap) {
          longPool.push({
            symbol,
            setup: IntradayAlphaSetup.NoiseAreaLong,
            direction: 'LONG',
            phase: IntradayAlphaPhase.NoiseAreaTrend,
            scoreBps: (close / upperBand - 1) * 10_000,
            relVwapDevBps,
            sessionOpenPrice: stats.sessionOpenPrice,
            sessionVwap: stats.sessionVwap,
            latestClose: close,
            atr14Ratio: baseline.atr14Ratio,
            targetWeightOverride: weight,
            protectiveStopBpsOverride: stopBps,
            profitTargetBpsOverride: input.policy.noiseArea.profitTargetBps,
            bars: stats.bars,
          })
        } else if (canShort(symbol) && close < lowerBand && close < stats.sessionVwap) {
          shortPool.push({
            symbol,
            setup: IntradayAlphaSetup.NoiseAreaShort,
            direction: 'SHORT',
            phase: IntradayAlphaPhase.NoiseAreaTrend,
            scoreBps: (1 - close / lowerBand) * 10_000,
            relVwapDevBps,
            sessionOpenPrice: stats.sessionOpenPrice,
            sessionVwap: stats.sessionVwap,
            latestClose: close,
            atr14Ratio: baseline.atr14Ratio,
            targetWeightOverride: weight,
            protectiveStopBpsOverride: stopBps,
            profitTargetBpsOverride: input.policy.noiseArea.profitTargetBps,
            bars: stats.bars,
          })
        }
      }

      if (longPool.length > 0 || shortPool.length > 0) {
        longPool.sort((a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol))
        shortPool.sort((a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol))
        return { context: initialContext, spyVwapDevBps: spy.vwapDevBps, longPool, shortPool }
      }

      // If no Noise Area ETF broke out on a 30m checkpoint that overlaps Morning ORB or Midday Reversion,
      // fall through cleanly to the single-name equity engine on this same minute.
      const fallbackContext = yield* resolveAlphaSessionContext({
        snapshot: input.snapshot,
        policy: input.policy,
        ...(input.middayReversionCompleted === undefined
          ? {}
          : { middayReversionCompleted: input.middayReversionCompleted }),
        noiseAreaAllTaken: true,
      })
      if (fallbackContext.phase === IntradayAlphaPhase.OutsideWindow) {
        return { context: initialContext, spyVwapDevBps: spy.vwapDevBps, longPool: [], shortPool: [] }
      }
      return yield* extractEquityAlphaCandidates({
        snapshot: input.snapshot,
        policy: input.policy,
        trailingBaseline: input.trailingBaseline,
        context: fallbackContext,
        spy,
        excluded,
        occupied,
        takenOrb,
        canShort,
      })
    }

    return yield* extractEquityAlphaCandidates({
      snapshot: input.snapshot,
      policy: input.policy,
      trailingBaseline: input.trailingBaseline,
      context: initialContext,
      spy,
      excluded,
      occupied,
      takenOrb,
      canShort,
    })
  })

const extractEquityAlphaCandidates = (input: {
  readonly snapshot: StrategyMarketSnapshot
  readonly policy: AlphaSignalPolicy
  readonly trailingBaseline: IntradayAlphaTrailingBaseline
  readonly context: AlphaSessionContext
  readonly spy: SessionBarStats
  readonly excluded: ReadonlySet<string>
  readonly occupied: ReadonlySet<string>
  readonly takenOrb: ReadonlySet<string>
  readonly canShort: (symbol: string) => boolean
}): Result.Result<
  {
    readonly context: AlphaSessionContext
    readonly spyVwapDevBps: number | null
    readonly longPool: readonly AlphaRankedCandidate[]
    readonly shortPool: readonly AlphaRankedCandidate[]
  },
  JevContractError
> => {
  const { context, policy, spy, excluded, occupied, takenOrb, canShort } = input
  const expectedLatestEventMs = context.rangeEndMs - 60_000
  const longPool: AlphaRankedCandidate[] = []
  const shortPool: AlphaRankedCandidate[] = []

  // Engine 1 & Engine 2 share the 18 single-name equity sleeve (never overlapping QQQ/SMH).
  // Allow at most 1 active single-name equity cycle at a time (ORB30 exits by 11:28 before Midday at 11:30).
  const equitySleeveOccupied = policy.equitySymbols.some((symbol) => occupied.has(symbol))
  if (equitySleeveOccupied) {
    return Result.succeed({ context, spyVwapDevBps: spy.vwapDevBps, longPool, shortPool })
  }

  // Engine 1 — Morning ATR-Scaled ORB30 (10:00–10:50 ET, 18 single-name equities)
  if (context.phase === IntradayAlphaPhase.MorningOrb) {
    if (takenOrb.size >= policy.morningOrb.maxTradesPerSession) {
      return Result.succeed({ context, spyVwapDevBps: spy.vwapDevBps, longPool, shortPool })
    }
    const spyAboveVwap = spy.latestBar.close > spy.sessionVwap
    const requireOrDirection = policy.morningOrb.requireOpeningCandleDirection
    for (const symbol of policy.equitySymbols) {
      if (excluded.has(symbol) || takenOrb.has(symbol) || occupied.has(symbol)) continue
      const quote = input.snapshot.latestQuotes[symbol]
      if (quote === undefined) continue
      const baseline = input.trailingBaseline.symbols[symbol]
      if (baseline === undefined || baseline.priorSessions < policy.trailingBaseline.minimumSessions) continue
      const stats = symbolSessionStats(
        input.snapshot.bars,
        symbol,
        context.sessionOpenMs,
        context.rangeEndMs,
        expectedLatestEventMs,
      )
      if (stats === null) continue
      if (countRecentBars(stats.bars, context.rangeEndMs, 15) < policy.morningOrb.minimumRecent15MinBars) continue
      const openingRange = computeOpeningRange(
        stats.bars,
        context.sessionOpenMs,
        policy.morningOrb.openingRangeMinutes,
        policy.morningOrb.minimumOpeningRangeBars,
      )
      if (openingRange === null) continue
      const close = stats.latestBar.close
      const previousClose = stats.previousBar?.close ?? stats.latestBar.open
      // If NoiseAreaTrend claimed minute 30 (10:00 ET top-of-hour checkpoint), allow minute 31 to
      // still catch an opening-range breakout whose bar-29 close was inside the opening range.
      const prevPriorClose =
        context.completedMinuteFromOpen === policy.morningOrb.entryStartMinuteFromOpen + 1
          ? stats.bars.at(-3)?.close
          : undefined
      const crossedAboveOr =
        close > openingRange.high &&
        (previousClose <= openingRange.high || (prevPriorClose !== undefined && prevPriorClose <= openingRange.high))
      const crossedBelowOr =
        close < openingRange.low &&
        (previousClose >= openingRange.low || (prevPriorClose !== undefined && prevPriorClose >= openingRange.low))
      const relVwapDevBps = stats.vwapDevBps - spy.vwapDevBps
      const stopBps = clamp(
        Math.round(baseline.atr14Ratio * 10_000 * policy.morningOrb.stopAtrMultiple),
        policy.morningOrb.minimumStopBps,
        policy.morningOrb.maximumStopBps,
      )
      const targetBps = stopBps * policy.morningOrb.rewardRiskMultiple
      const weight = round4(Math.min(policy.morningOrb.maximumWeightPerLeg, policy.morningOrb.riskBudgetBps / stopBps))
      if (
        spyAboveVwap &&
        (!requireOrDirection || openingRange.close > openingRange.open) &&
        crossedAboveOr &&
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
          atr14Ratio: baseline.atr14Ratio,
          targetWeightOverride: weight,
          protectiveStopBpsOverride: stopBps,
          profitTargetBpsOverride: targetBps,
          bars: stats.bars,
        })
      } else if (
        !spyAboveVwap &&
        canShort(symbol) &&
        (!requireOrDirection || openingRange.close < openingRange.open) &&
        crossedBelowOr &&
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
          atr14Ratio: baseline.atr14Ratio,
          targetWeightOverride: weight,
          protectiveStopBpsOverride: stopBps,
          profitTargetBpsOverride: targetBps,
          bars: stats.bars,
        })
      }
    }
    longPool.sort((a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol))
    shortPool.sort((a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol))
    return Result.succeed({ context, spyVwapDevBps: spy.vwapDevBps, longPool, shortPool })
  }

  // Engine 2 — Midday Relative-VWAP Overreaction Reversion (11:30–12:00 ET -> 15:55 ET, 18 single-name equities)
  const ranked: {
    readonly stats: SessionBarStats
    readonly relVwapDevBps: number
    readonly shortable: boolean
  }[] = []
  for (const symbol of policy.equitySymbols) {
    if (excluded.has(symbol) || occupied.has(symbol)) continue
    const quote = input.snapshot.latestQuotes[symbol]
    if (quote === undefined) continue
    const stats = symbolSessionStats(
      input.snapshot.bars,
      symbol,
      context.sessionOpenMs,
      context.rangeEndMs,
      expectedLatestEventMs,
    )
    if (
      stats === null ||
      stats.bars.length < policy.middayReversion.minimumSessionBars ||
      countRecentBars(stats.bars, context.rangeEndMs, 15) < policy.middayReversion.minimumRecent15MinBars
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
  return Result.succeed({ context, spyVwapDevBps: spy.vwapDevBps, longPool, shortPool })
}

export const selectIntradayAlphaLegs = (input: {
  readonly context: AlphaSessionContext
  readonly policy: AlphaSignalPolicy
  readonly longPool: readonly AlphaRankedCandidate[]
  readonly shortPool: readonly AlphaRankedCandidate[]
  readonly vetoedSymbols: ReadonlySet<string>
}): readonly SelectedAlphaLeg[] => {
  const { context, policy, vetoedSymbols } = input
  if (context.phase === IntradayAlphaPhase.OutsideWindow) return []

  const longs = input.longPool.filter((candidate) => !vetoedSymbols.has(candidate.symbol))
  const shorts = input.shortPool.filter((candidate) => !vetoedSymbols.has(candidate.symbol))

  if (context.phase === IntradayAlphaPhase.NoiseAreaTrend) {
    const combined = [...longs, ...shorts].toSorted((a, b) => a.symbol.localeCompare(b.symbol))
    const holdMinutes = clamp(
      policy.noiseArea.flattenMinuteFromOpen - context.elapsedMinutesFromOpen,
      10,
      policy.maximumHoldingMinutes,
    )
    return combined.map((candidate) => ({
      symbol: candidate.symbol,
      setup: candidate.setup,
      direction: candidate.direction,
      phase: IntradayAlphaPhase.NoiseAreaTrend as const,
      targetWeight: candidate.targetWeightOverride ?? policy.noiseArea.minimumWeightPerLeg,
      protectiveStopBps: candidate.protectiveStopBpsOverride ?? policy.noiseArea.minimumStopBps,
      profitTargetBps: candidate.profitTargetBpsOverride ?? policy.noiseArea.profitTargetBps,
      maximumHoldingMinutes: holdMinutes,
      scoreBps: candidate.scoreBps,
      relVwapDevBps: candidate.relVwapDevBps,
    }))
  }

  if (context.phase === IntradayAlphaPhase.MorningOrb) {
    const combined = [...longs, ...shorts].toSorted(
      (a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol),
    )
    const entryMinute = context.completedMinuteFromOpen + 1
    const remainingBeforeHardExit = Math.max(1, policy.morningOrb.hardExitMinuteFromOpen - entryMinute)
    const holdMinutes = Math.min(policy.morningOrb.maximumHoldingMinutes, remainingBeforeHardExit)
    return combined.slice(0, policy.morningOrb.maximumPositions).map((candidate) => {
      const stopBps = candidate.protectiveStopBpsOverride ?? policy.morningOrb.minimumStopBps
      return {
        symbol: candidate.symbol,
        setup: candidate.setup,
        direction: candidate.direction,
        phase: IntradayAlphaPhase.MorningOrb as const,
        targetWeight:
          candidate.targetWeightOverride ??
          round4(Math.min(policy.morningOrb.maximumWeightPerLeg, policy.morningOrb.riskBudgetBps / stopBps)),
        protectiveStopBps: stopBps,
        profitTargetBps: candidate.profitTargetBpsOverride ?? stopBps * policy.morningOrb.rewardRiskMultiple,
        maximumHoldingMinutes: holdMinutes,
        scoreBps: candidate.scoreBps,
        relVwapDevBps: candidate.relVwapDevBps,
      }
    })
  }

  // Engine 2 — Sign-gated dollar-neutral paired reversion (up to 2L + 2S)
  const entryMinute = context.completedMinuteFromOpen + 1
  const holdMinutes = clamp(
    policy.middayReversion.flattenMinuteFromOpen - entryMinute,
    15,
    policy.maximumHoldingMinutes,
  )
  const requireOppositeSigns = policy.middayReversion.requireOppositeSigns
  const eligibleLongs = requireOppositeSigns ? longs.filter((candidate) => candidate.relVwapDevBps < 0) : longs
  const eligibleShorts = requireOppositeSigns ? shorts.filter((candidate) => candidate.relVwapDevBps > 0) : shorts
  const used = new Set<string>()
  const paired: AlphaRankedCandidate[] = []
  for (let pair = 0; pair < policy.middayReversion.targetPairs; pair++) {
    const longPick = eligibleLongs.find((candidate) => !used.has(candidate.symbol))
    if (longPick === undefined) break
    const shortPick = eligibleShorts.find(
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

  // Anti-starvation fallback if one side has no sign-gated or borrow-eligible candidates.
  const fallback = eligibleLongs[0] ?? eligibleShorts[0] ?? longs.find((candidate) => candidate.relVwapDevBps < 0)
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
