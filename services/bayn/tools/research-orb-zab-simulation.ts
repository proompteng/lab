import { Result } from 'effect'

import { decodeJevProtocol, defaultJevProtocolDocument } from '../src/jev/protocol'
import { IntradayAlphaPhase, IntradayAlphaSetup } from '../src/strategy/intraday-alpha/constants'
import { intradayAlphaDefinition as def, makeIntradayAlphaPolicy } from '../src/strategy/intraday-alpha/policy'
import { selectIntradayAlphaLegs, type AlphaRankedCandidate } from '../src/strategy/intraday-alpha/signals'
import { cappedBreakoutExtension, type TradeSide } from '../src/strategy/intraday-alpha/stock-in-play'
import {
  breakevenStopAfterOneR,
  noiseAreaExitLevel,
  tightenProtectiveStop,
} from '../src/strategy/intraday-alpha/trailing-exits'
import type { Bar, ResearchDay, SymbolDay } from './research-orb-zab-data'
import {
  capital,
  fee,
  noiseUniverse,
  type Cost,
  type NoiseTrial,
  type OrbTrial,
  type Trial,
} from './research-orb-zab-protocol'

const bp = 10_000
const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x))
const roundWeight = (weight: number) => Math.round(weight * bp) / bp
const policy = makeIntradayAlphaPolicy(Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument)))

interface Signal {
  readonly symbol: string
  readonly side: TradeSide
  readonly close: number
  readonly series: SymbolDay
  readonly weight: number
  readonly stopBps: number
  readonly targetBps: number
}

export const planEntry = (bar: Bar | undefined, side: TradeSide, close: number, collar: number, cost: Cost) => {
  if (bar === undefined) return { kind: 'missing-entry-minute' } as const
  const multiplier = 1 + (side * cost) / (2 * bp)
  const limit = close * (1 + (side * collar) / bp)
  const open = bar.open * multiplier
  if (side * (open - limit) <= 0) return { kind: 'filled', raw: bar.open, price: open, atOpen: true } as const
  const extreme = side === 1 ? bar.low : bar.high
  if (side * (extreme * multiplier - limit) > 0) return { kind: 'collar-miss' } as const
  return { kind: 'filled', raw: limit / multiplier, price: limit, atOpen: false } as const
}

type Entry = Extract<ReturnType<typeof planEntry>, { kind: 'filled' }>
type ExitReason = 'time' | 'stop' | 'target' | 'vwap' | 'breakout-band' | 'opposite-band' | 'vwap-boundary'
interface Trade {
  readonly symbol: string
  readonly side: TradeSide
  readonly minute: number
  readonly reason: ExitReason
  readonly gross: number
  readonly feeUsd: number
  readonly friction: number
  readonly notional: number
  readonly net: number
  readonly heldGaps: number
}

export interface Outcome {
  readonly date: string
  readonly trades: Trade[]
  attempts: number
  collarMisses: number
  missingEntryBars: number
  unavailableBenchmark: number
  unresolved: number
  heldGaps: number
}

const checkpoint = (trial: NoiseTrial, t: number) =>
  trial.clock === 'v2'
    ? def.noiseArea.checkpointMinutesFromOpen.some((minute) => minute === t + 1)
    : (t + 1) % trial.checkpoint === 0

const bands = (trial: NoiseTrial, series: SymbolDay, t: number) => {
  const open = series.bars[0]?.open
  const swing = series.averageSwing[t] * trial.band
  const prev = series.previousClose
  if (open === undefined || prev === null || !Number.isFinite(swing)) return null
  return { lower: Math.min(open, prev) * (1 - swing), upper: Math.max(open, prev) * (1 + swing) }
}

export const simulateExit = (
  signal: Signal,
  entry: Entry,
  minute: number,
  deadline: number,
  cost: Cost,
  trial: Trial | null,
): { trade: Trade | null; heldGaps: number } => {
  const { side, series } = signal
  const risk = (entry.price * signal.stopBps) / bp
  const target = entry.price * (1 + (side * signal.targetBps) / bp)
  let stop = entry.price - side * risk
  let best = entry.price
  let pending: ExitReason | null = null
  let heldGaps = 0
  const shares = Math.floor((capital * signal.weight) / entry.price)
  if (shares < 1) return { trade: null, heldGaps }
  for (let t = minute; t < series.bars.length; t++) {
    const bar = series.bars[t]
    if (bar === undefined) {
      heldGaps++
      continue
    }
    let raw = bar.open
    // An open beyond a stop gaps through it; never grant an intrabar target before an ambiguous stop.
    const stopped = side * ((side === 1 ? bar.low : bar.high) - stop) <= 0
    // A resting entry was approached from the wrong side. An adverse print beyond its stop
    // can occur after the fill, but a favorable print may have happened before it.
    const intrabarEntry = t === minute && !entry.atOpen
    const targetHit = !intrabarEntry && side * ((side === 1 ? bar.high : bar.low) - target) >= 0
    const reason: ExitReason | null =
      pending ?? (t >= deadline ? 'time' : stopped ? 'stop' : targetHit ? 'target' : null)
    if (reason !== null) {
      if (reason === 'stop') raw = side === 1 ? Math.min(stop, bar.open) : Math.max(stop, bar.open)
      else if (reason === 'target') raw = target
      const exit = raw * (1 - (side * cost) / (2 * bp))
      const gross = side * (raw - entry.raw) * shares
      const feeUsd = (side === 1 ? exit : entry.price) * shares * fee
      const friction = side * (raw - exit + (entry.price - entry.raw)) * shares
      return {
        trade: {
          symbol: signal.symbol,
          side,
          minute,
          reason,
          gross,
          feeUsd,
          friction,
          notional: shares * entry.raw,
          net: gross - feeUsd - friction,
          heldGaps,
        },
        heldGaps,
      }
    }
    // A completed bar can affect only the next minute, including after an intrabar entry.
    if (intrabarEntry) continue
    const favorable = side === 1 ? bar.high : bar.low
    if (trial?.engine === 'orb') {
      if (trial.exit === 'breakeven' || trial.exit === 'breakeven-vwap') {
        stop = breakevenStopAfterOneR(side, stop, entry.price, risk, favorable)
      }
      if ((trial.exit === 'vwap' || trial.exit === 'breakeven-vwap') && side * (bar.close - series.vwap[t]) <= 0) {
        pending = 'vwap'
      }
    } else if (trial?.engine === 'noise') {
      if (trial.exit === 'trailing-atr') {
        best = side === 1 ? Math.max(best, favorable) : Math.min(best, favorable)
        stop = tightenProtectiveStop(side, stop, best - side * risk)
      } else if (trial.exit !== 'static' && checkpoint(trial, t)) {
        const band = bands(trial, series, t)
        const vwap = series.vwap[t]
        const level =
          trial.exit === 'vwap'
            ? vwap
            : band === null
              ? null
              : noiseAreaExitLevel(side, trial.exit, vwap, band.lower, band.upper)
        if (level !== null && side * (bar.close - level) <= 0) pending = trial.exit
      }
    }
  }
  return { trade: null, heldGaps }
}

const currentBar = (series: SymbolDay | undefined, t: number, recent = 1): Bar | undefined =>
  series !== undefined && series.count[t + 1] - series.count[Math.max(0, t - 14)] >= recent ? series.bars[t] : undefined

const attempt = (outcome: Outcome, signal: Signal, t: number, dayMinutes: number, trial: Trial | null, cost: Cost) => {
  outcome.attempts++
  const minute = t + 1
  const entry = planEntry(
    signal.series.bars[minute],
    signal.side,
    signal.close,
    trial?.collar ?? def.entryLimitSlippageBps,
    cost,
  )
  if (entry.kind === 'collar-miss') {
    outcome.collarMisses++
    return
  }
  if (entry.kind === 'missing-entry-minute') {
    outcome.missingEntryBars++
    return
  }
  let deadline = dayMinutes - (trial === null ? 5 : 2)
  if (trial?.engine === 'orb' && trial.hold !== 'eod') {
    deadline = Math.min(
      deadline,
      minute + def.morningOrb.maximumHoldingMinutes,
      trial.hold === 'v2' ? def.morningOrb.hardExitMinuteFromOpen : Infinity,
    )
  }
  const closed = simulateExit(signal, entry, minute, deadline, cost, trial)
  outcome.heldGaps += closed.heldGaps
  if (closed.trade === null) outcome.unresolved++
  else outcome.trades.push(closed.trade)
}

const orbSignals = (day: ResearchDay, outcome: Outcome, trial: OrbTrial, symbols: readonly string[], cost: Cost) => {
  const spec = def.morningOrb
  const rvolRank = (symbol: string) => day.symbols.get(symbol)?.relativeVolumes.get(trial.horizon) ?? -Infinity
  const pool =
    trial.rank === 'top3-rvol'
      ? symbols.toSorted((a, b) => rvolRank(b) - rvolRank(a) || a.localeCompare(b)).slice(0, 3)
      : symbols
  for (let t = trial.horizon; t <= spec.entryEndMinuteFromOpen; t++) {
    const spy = day.symbols.get('SPY')
    const benchmark = currentBar(spy, t)
    if (spy === undefined || benchmark === undefined) {
      outcome.unavailableBenchmark++
      continue
    }
    const side: TradeSide = benchmark.close > spy.vwap[t] ? 1 : -1
    let best: { signal: Signal; score: number } | undefined
    for (const symbol of pool) {
      const series = day.symbols.get(symbol)
      const bar = currentBar(series, t, Math.min(t + 1, spec.minimumRecent15MinBars))
      if (series === undefined || bar === undefined || series.atrRatio === null) continue
      const range = series.ranges.get(trial.horizon)
      const prior = series.bars[t - 1]?.close
      if (range === undefined || prior === undefined || side * (range.close - range.open) <= 0) continue
      const close = bar.close
      const boundary = side === 1 ? range.high : range.low
      if (side * (prior - boundary) > 0 || side * (close - series.vwap[t]) <= 0) continue
      const distance = cappedBreakoutExtension(side, close, boundary, series.atrRatio * close, trial.cap)
      const rvol = rvolRank(symbol)
      if (distance === null || (trial.rvol !== null && rvol < trial.rvol)) continue
      const score = trial.rank === 'chase' ? distance : rvol
      if (
        !Number.isFinite(score) ||
        (best !== undefined &&
          (best.score > score || (best.score === score && best.signal.symbol.localeCompare(symbol) <= 0)))
      )
        continue
      const stopBps = clamp(
        Math.round(series.atrRatio * bp * spec.stopAtrMultiple),
        spec.minimumStopBps,
        spec.maximumStopBps,
      )
      const weight = roundWeight(Math.min(spec.maximumWeightPerLeg, spec.riskBudgetBps / stopBps))
      best = {
        score,
        signal: { symbol, series, side, close, weight, stopBps, targetBps: stopBps * spec.rewardRiskMultiple },
      }
    }
    if (best !== undefined) {
      attempt(outcome, best.signal, t, day.minutes, trial, cost)
      break
    }
  }
}

const noiseSignals = (
  day: ResearchDay,
  outcome: Outcome,
  trial: NoiseTrial,
  symbols: readonly string[],
  cost: Cost,
) => {
  const spec = def.noiseArea
  const eligible = symbols.flatMap((symbol) => {
    const series = day.symbols.get(symbol)
    return series === undefined || series.atrRatio === null || series.atrRatio <= 0
      ? []
      : [{ symbol, series, atr: series.atrRatio }]
  })
  const totalInverse = eligible.reduce((sum, row) => sum + 1 / row.atr, 0)
  const committed = new Set<string>()
  for (let t = 0; t < day.minutes - 3 && committed.size < eligible.length; t++) {
    if (!checkpoint(trial, t)) continue
    if (currentBar(day.symbols.get('SPY'), t) === undefined) {
      outcome.unavailableBenchmark++
      continue
    }
    for (const { symbol, series, atr } of eligible) {
      const bar = currentBar(series, t, spec.minimumRecent15MinBars)
      if (committed.has(symbol) || bar === undefined) continue
      const band = bands(trial, series, t)
      if (band === null) continue
      const close = bar.close
      const side: TradeSide | null =
        close > Math.max(band.upper, series.vwap[t]) ? 1 : close < Math.min(band.lower, series.vwap[t]) ? -1 : null
      if (side === null) continue
      const weight = roundWeight(
        clamp(
          spec.sleeveGrossWeight / (atr * totalInverse),
          trial.universe === 'v2' ? spec.minimumWeightPerLeg : 0,
          spec.maximumWeightPerLeg,
        ),
      )
      const stopBps = clamp(Math.round(atr * bp * spec.stopAtrMultiple), spec.minimumStopBps, spec.maximumStopBps)
      attempt(
        outcome,
        { symbol, series, side, close, weight, stopBps, targetBps: spec.profitTargetBps },
        t,
        day.minutes,
        trial,
        cost,
      )
      committed.add(symbol)
    }
  }
}

const middaySignals = (day: ResearchDay, outcome: Outcome, symbols: readonly string[], cost: Cost) => {
  const spec = def.middayReversion
  const phase: IntradayAlphaPhase.MiddayReversion = IntradayAlphaPhase.MiddayReversion
  for (let t = spec.entryStartMinuteFromOpen; t <= spec.entryEndMinuteFromOpen; t++) {
    const spy = day.symbols.get('SPY')
    const benchmark = currentBar(spy, t)
    if (spy === undefined || benchmark === undefined) {
      outcome.unavailableBenchmark++
      continue
    }
    const deviation = benchmark.close / spy.vwap[t]
    const entries = symbols.flatMap((symbol) => {
      const series = day.symbols.get(symbol)
      const bar = currentBar(series, t, spec.minimumRecent15MinBars)
      if (series === undefined || bar === undefined || series.count[t + 1] < spec.minimumSessionBars) return []
      const latestClose = bar.close
      return [
        {
          symbol,
          phase: IntradayAlphaPhase.MiddayReversion as const,
          latestClose,
          sessionOpenPrice: series.bars[0]?.open ?? latestClose,
          sessionVwap: series.vwap[t],
          relVwapDevBps: (latestClose / series.vwap[t] - deviation) * bp,
          bars: [],
        },
      ]
    })
    const longs: AlphaRankedCandidate[] = entries.map((row) => ({
      ...row,
      direction: 'LONG',
      setup: IntradayAlphaSetup.MiddayVwapReversionLong,
      scoreBps: -row.relVwapDevBps,
    }))
    const shorts: AlphaRankedCandidate[] = entries.map((row) => ({
      ...row,
      direction: 'SHORT',
      setup: IntradayAlphaSetup.MiddayVwapReversionShort,
      scoreBps: row.relVwapDevBps,
    }))
    const legs = selectIntradayAlphaLegs({
      context: {
        phase,
        completedMinuteFromOpen: t,
        elapsedMinutesFromOpen: t + 1,
        sessionOpenMs: day.openMs,
        sessionCloseMs: day.openMs + day.minutes * 60_000,
        rangeEndMs: day.openMs + (t + 1) * 60_000,
      },
      policy,
      longPool: longs.sort((a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol)),
      shortPool: shorts.sort((a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol)),
      vetoedSymbols: new Set(),
    })
    if (legs.length === 0) continue
    for (const leg of legs) {
      const series = day.symbols.get(leg.symbol)
      const close = series?.bars[t]?.close
      if (series === undefined || close === undefined) throw new Error('Missing committed Midday signal')
      attempt(
        outcome,
        {
          symbol: leg.symbol,
          series,
          close,
          side: leg.direction === 'LONG' ? 1 : -1,
          weight: leg.targetWeight,
          stopBps: leg.protectiveStopBps,
          targetBps: leg.profitTargetBps,
        },
        t,
        day.minutes,
        null,
        cost,
      )
    }
    break
  }
}

export const replay = (
  days: readonly ResearchDay[],
  trial: Trial | null,
  universe: readonly string[],
  cost: Cost,
  removed?: string,
): Outcome[] => {
  const symbols = (trial?.engine === 'noise' ? noiseUniverse(trial) : universe).filter((symbol) => symbol !== removed)
  return days.map((day) => {
    const outcome: Outcome = {
      date: day.date,
      trades: [],
      attempts: 0,
      collarMisses: 0,
      missingEntryBars: 0,
      unavailableBenchmark: 0,
      unresolved: 0,
      heldGaps: 0,
    }
    if (symbols.length === 0) return outcome
    if (trial === null) middaySignals(day, outcome, symbols, cost)
    else if (trial.engine === 'orb') orbSignals(day, outcome, trial, symbols, cost)
    else noiseSignals(day, outcome, trial, symbols, cost)
    return outcome
  })
}
