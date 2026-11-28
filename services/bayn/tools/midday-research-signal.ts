import { Result, Schema } from 'effect'

import { buildTrailingBaseline } from '../src/market-data/intraday/trailing-baseline'
import { IsoDateSchema } from '../src/schemas'
import { intradayAlphaBenchmarkSymbol, intradayAlphaEquitySymbols } from '../src/strategy/intraday-alpha/constants'
import { intradayAlphaDefinition } from '../src/strategy/intraday-alpha/policy'
import { type Bar, checkpoints, type Quote, type Session, symbols } from './midday-research-data'
import { mean, quantile, sum } from './midday-research-statistics'

const semis = new Set(['WDC', 'MU', 'COHR', 'LITE', 'AMD', 'NVDA'])
const bps = 10_000

export interface SignalRow {
  readonly symbol: string
  readonly close: number
  readonly vwapDevBps: number
  readonly beta14: number | undefined
  readonly beta20: number | undefined
  readonly atrBps: number | undefined
  readonly completedQuote: Quote | undefined
}

interface Checkpoint {
  readonly minute: number
  readonly benchmarkDevBps: number | undefined
  readonly rows: readonly SignalRow[]
}

export interface SignalSession {
  readonly session: Session
  readonly checkpoints: readonly Checkpoint[]
  readonly baselineAvailable: boolean
}

export type SignalName = 'v2' | 'beta14' | 'beta20' | 'beta-z' | 'median' | 'semi' | 'dispersion'

export interface RankedLeg {
  readonly row: SignalRow
  readonly direction: 1 | -1
}

export interface Selection {
  readonly groups: readonly (readonly RankedLeg[])[]
  readonly grossScale: number
}

export const estimateBeta = (samples: readonly (readonly [market: number, equity: number])[]) => {
  if (samples.length < 14) return undefined
  const marketMean = mean(samples.map(([market]) => market))
  const equityMean = mean(samples.map(([, equity]) => equity))
  const variance = sum(samples.map(([market]) => (market - marketMean) ** 2))
  if (variance === 0) return undefined
  const covariance = sum(samples.map(([market, equity]) => (market - marketMean) * (equity - equityMean)))
  return Math.min(3, Math.max(0.5, covariance / variance))
}

const dailyReturns = (session: Session) =>
  new Map(session.daily.map(({ symbol, open, close }) => [symbol, close / open - 1]))

export const prepareSignalHistory = (sessions: readonly Session[]): readonly SignalSession[] => {
  const returns = sessions.map(dailyReturns)
  const { lookbackSessions, minimumSessions } = intradayAlphaDefinition.trailingBaseline
  return sessions.map((session, index) => {
    const cutoff = new Date(Date.parse(session.date) - Math.max(35, lookbackSessions * 3) * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const baseline = buildTrailingBaseline({
      sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(session.date),
      symbols: intradayAlphaEquitySymbols,
      noiseAreaSymbols: [],
      lookbackSessions,
      minimumSessions,
      dailyRows: sessions
        .slice(0, index)
        .filter(({ date }) => date >= cutoff)
        .flatMap(({ daily }) => daily),
      checkpointRows: [],
    })

    const signalRows = new Map<number, SignalRow[]>()
    const marketDevs = new Map<number, number>()
    for (const symbol of symbols) {
      const tape = session.tapes.get(symbol)
      if (tape === undefined) continue
      const trailingBeta = (lookback: number) =>
        estimateBeta(
          returns.slice(Math.max(0, index - lookback), index).flatMap((row) => {
            const market = row.get(intradayAlphaBenchmarkSymbol)
            const equity = row.get(symbol)
            return market === undefined || equity === undefined ? [] : [[market, equity] as const]
          }),
        )
      const beta14 = trailingBeta(14)
      const beta20 = trailingBeta(20)
      const atrRatio = Result.isSuccess(baseline) ? baseline.success.symbols[symbol]?.atr14Ratio : undefined
      const atrBps = atrRatio === undefined ? undefined : atrRatio * bps
      let volume = 0
      let priceVolume = 0
      let observations = 0
      const recent: number[] = []
      for (let minute = 0; minute <= checkpoints.entryEndMinuteFromOpen; minute++) {
        const bar = tape.bars.get(minute)
        if (bar === undefined) continue
        volume += bar.volume
        priceVolume += bar.vwap * bar.volume
        observations++
        recent.push(minute)
        while ((recent[0] ?? minute) <= minute - 15) recent.shift()
        if (minute < checkpoints.entryStartMinuteFromOpen) continue
        const vwapDevBps = (bar.close / (priceVolume / volume) - 1) * bps
        if (symbol === intradayAlphaBenchmarkSymbol) {
          marketDevs.set(minute, vwapDevBps)
          continue
        }
        if (observations < checkpoints.minimumSessionBars || recent.length < checkpoints.minimumRecent15MinBars)
          continue
        const rows = signalRows.get(minute) ?? []
        rows.push({
          symbol,
          close: bar.close,
          vwapDevBps,
          beta14,
          beta20,
          atrBps,
          completedQuote: tape.quotes.get(minute),
        })
        signalRows.set(minute, rows)
      }
    }
    return {
      session,
      baselineAvailable: Result.isSuccess(baseline),
      checkpoints: Array.from(
        { length: checkpoints.entryEndMinuteFromOpen - checkpoints.entryStartMinuteFromOpen + 1 },
        (_, offset) => {
          const minute = checkpoints.entryStartMinuteFromOpen + offset
          return { minute, benchmarkDevBps: marketDevs.get(minute), rows: signalRows.get(minute) ?? [] }
        },
      ),
    }
  })
}

const residual = (row: SignalRow, market: number, beta: number) => row.vwapDevBps - beta * market

export const residualDispersion = (point: Checkpoint, omitted: string | undefined) => {
  const market = point.benchmarkDevBps
  if (market === undefined) return null
  const residuals = point.rows.flatMap((row) =>
    row.symbol === omitted || row.beta20 === undefined ? [] : [residual(row, market, row.beta20)],
  )
  if (residuals.length < 4) return null
  const upper = quantile(residuals, 0.75)
  const lower = quantile(residuals, 0.25)
  return upper === null || lower === null ? null : upper - lower
}

export const selectMiddayBasket = (input: {
  readonly point: Checkpoint
  readonly signal: SignalName
  readonly omitted: string | undefined
  readonly requireBeta: boolean
  readonly allowSingle: boolean
  readonly gateBps: number | null
  readonly priorDispersion: number | null
}): Selection => {
  const { point, signal } = input
  const noBasket: Selection = { groups: [], grossScale: 0 }
  const market = point.benchmarkDevBps
  if (market === undefined) return noBasket
  let grossScale = 1
  if (input.gateBps !== null) {
    const dispersion = residualDispersion(point, input.omitted)
    const prior = input.priorDispersion
    if (dispersion === null || dispersion < input.gateBps || prior === null || prior <= 0) return noBasket
    grossScale = Math.min(1, dispersion / (2 * prior))
  }

  const candidates = point.rows.flatMap((row) => {
    const beta = signal === 'v2' ? 1 : signal === 'beta14' ? row.beta14 : row.beta20
    if (row.symbol === input.omitted || beta === undefined || (input.requireBeta && row.beta20 === undefined)) return []
    const dev = residual(row, market, beta)
    if (signal === 'v2' || signal === 'beta14' || signal === 'beta20') return [{ row, score: dev }]
    return row.atrBps === undefined ? [] : [{ row, score: dev / row.atrBps }]
  })
  const groups =
    signal === 'semi'
      ? [candidates.filter(({ row }) => semis.has(row.symbol)), candidates.filter(({ row }) => !semis.has(row.symbol))]
      : [candidates]
  const center = signal === 'median' || signal === 'semi' || signal === 'dispersion'
  const pairs: { legs: readonly RankedLeg[]; spread: number }[] = []
  const fallbacks: { leg: RankedLeg; score: number }[] = []
  for (const group of groups) {
    const median = center
      ? quantile(
          group.map(({ score }) => score),
          0.5,
        )
      : 0
    if (median === null) continue
    const longs = group
      .filter(({ score }) => score < median)
      .toSorted((a, b) => a.score - b.score || a.row.symbol.localeCompare(b.row.symbol))
    const shorts = group
      .filter(({ score }) => score > median)
      .toSorted((a, b) => b.score - a.score || a.row.symbol.localeCompare(b.row.symbol))
    for (let pair = 0; pair < checkpoints.targetPairs; pair++) {
      const long = longs[pair]
      const short = shorts[pair]
      if (long === undefined || short === undefined) break
      pairs.push({
        legs: [
          { row: long.row, direction: 1 },
          { row: short.row, direction: -1 },
        ],
        spread: short.score - long.score,
      })
    }
    const fallbackLong = longs[0]
    const fallbackShort = shorts[0]
    if (fallbackLong !== undefined)
      fallbacks.push({ leg: { row: fallbackLong.row, direction: 1 }, score: fallbackLong.score - median })
    else if (fallbackShort !== undefined)
      fallbacks.push({ leg: { row: fallbackShort.row, direction: -1 }, score: fallbackShort.score - median })
  }
  if (pairs.length > 0)
    return {
      groups: pairs
        .toSorted(
          (a, b) => b.spread - a.spread || (a.legs[0]?.row.symbol ?? '').localeCompare(b.legs[0]?.row.symbol ?? ''),
        )
        .slice(0, checkpoints.targetPairs)
        .map(({ legs }) => legs),
      grossScale,
    }
  const fallback = fallbacks.toSorted(
    (a, b) => b.leg.direction - a.leg.direction || Math.abs(b.score) - Math.abs(a.score),
  )[0]
  return input.allowSingle && fallback !== undefined ? { groups: [[fallback.leg]], grossScale } : noBasket
}

export const adjacentJumpBps = (bar: Bar, next: Bar) => (next.open / bar.close - 1) * bps
