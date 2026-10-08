import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  collectCrashVwapBounceCandidates,
  decodeHybridCrashVwapSessionBars,
  evaluateHybridCrashVwapShadow,
  hybridCrashVwapParams,
  hybridCrashVwapSessionBarsSchemaVersion,
  HybridCrashVwapMode,
  sessionVwapSeries,
  type HybridBar,
} from './hybrid-crash-vwap-gate'

const open = hybridCrashVwapParams.rthOpenMinutes

const bar = (minuteOfDay: number, close: number, opts: Partial<HybridBar> = {}): HybridBar => ({
  symbol: opts.symbol ?? 'CRDO',
  minuteOfDay,
  open: opts.open ?? close,
  high: opts.high ?? close,
  low: opts.low ?? close,
  close,
  volume: opts.volume ?? 1000,
})

/** Flat session, then a -100 bp one-minute crash below VWAP at open+35 and the supplied follow-through bars. */
const crashSession = (followThrough: readonly HybridBar[], symbol = 'CRDO'): HybridBar[] => {
  const bars: HybridBar[] = []
  for (let m = 0; m < 35; m++) bars.push(bar(open + m, 100, { symbol }))
  bars.push(bar(open + 35, 99, { symbol, volume: 5000 }))
  return [...bars, ...followThrough.map((entry) => ({ ...entry, symbol }))]
}

const sessionText = (barsBySymbol: Record<string, readonly HybridBar[]>, sessionDate = '2026-10-07') =>
  JSON.stringify({ schemaVersion: hybridCrashVwapSessionBarsSchemaVersion, sessionDate, barsBySymbol })

describe('hybrid-crash-vwap-gate', () => {
  test('session VWAP is cumulative typical/volume', () => {
    const bars = [
      bar(570, 100, { high: 100, low: 100, volume: 100 }),
      bar(571, 110, { high: 110, low: 110, volume: 100 }),
    ]
    expect(sessionVwapSeries(bars)).toEqual([100, 105])
  })

  test('fires only with crash∩VWAP and bounce confirm', () => {
    const hits = collectCrashVwapBounceCandidates(
      crashSession([bar(open + 36, 99 * 1.002), bar(open + 37, 99 * 1.003)]),
    )
    expect(hits).toHaveLength(1)
    expect(hits).toMatchObject([{ symbol: 'CRDO', signalMinuteOfDay: open + 35, entryMinuteOfDay: open + 36 }])
    expect(hits[0]?.crashBp).toBeLessThanOrEqual(-hybridCrashVwapParams.crashBp)
  })

  test('no fire without bounce', () => {
    expect(collectCrashVwapBounceCandidates(crashSession([bar(open + 36, 99 * 0.999)]))).toEqual([])
  })

  test('a gap before the crash bar is not a one-minute crash', () => {
    const bars = crashSession([bar(open + 36, 99 * 1.002)]).filter((entry) => entry.minuteOfDay !== open + 34)
    expect(collectCrashVwapBounceCandidates(bars)).toEqual([])
  })

  test('a gap after the crash bar is not a one-minute bounce confirm', () => {
    expect(collectCrashVwapBounceCandidates(crashSession([bar(open + 41, 99 * 1.002)]))).toEqual([])
  })

  test('sparse 10:00, 10:05, 10:20 bars never produce a candidate', () => {
    expect(collectCrashVwapBounceCandidates([bar(600, 100), bar(605, 98), bar(620, 99)])).toEqual([])
  })

  test('decodes session bars and rejects malformed, misfiled, unordered or duplicate bars', () => {
    const bars = crashSession([bar(open + 36, 99 * 1.002)])
    const decoded = decodeHybridCrashVwapSessionBars(sessionText({ CRDO: bars }))
    expect(Result.isSuccess(decoded)).toBe(true)

    const first = bars[0]
    const second = bars[1]
    if (first === undefined || second === undefined) throw new Error('fixture requires two bars')
    for (const invalid of [
      'not json',
      sessionText({ CRDO: bars }, '2026-02-30'),
      JSON.stringify({ schemaVersion: hybridCrashVwapSessionBarsSchemaVersion, sessionDate: '2026-10-07' }),
      JSON.stringify({
        schemaVersion: hybridCrashVwapSessionBarsSchemaVersion,
        sessionDate: '2026-10-07',
        barsBySymbol: {},
        extra: true,
      }),
      sessionText({ SNDK: bars }),
      sessionText({ CRDO: [second, first] }),
      sessionText({ CRDO: [first, first] }),
      sessionText({ CRDO: [{ ...first, close: 0 }] }),
      sessionText({ CRDO: [{ ...first, minuteOfDay: 1440 }] }),
      sessionText({ CRDO: [{ ...first, high: 90 }] }),
      sessionText({ CRDO: [{ ...first, open: 101 }] }),
    ])
      expect(decodeHybridCrashVwapSessionBars(invalid)).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'HybridCrashVwapFailure' },
      })
  })

  test('shadow record is deterministic for the same session and supplied instant', () => {
    const decoded = decodeHybridCrashVwapSessionBars(
      sessionText({
        SNDK: crashSession([bar(open + 36, 99 * 1.002)], 'SNDK'),
        CRDO: crashSession([bar(open + 36, 99 * 1.002)]),
      }),
    )
    if (Result.isFailure(decoded)) throw decoded.failure
    const input = { session: decoded.success, evaluatedAt: '2026-10-07T20:00:00.000Z' }
    const record = evaluateHybridCrashVwapShadow(input)
    expect(evaluateHybridCrashVwapShadow(input)).toEqual(record)
    expect(record).toMatchObject({
      schemaVersion: 'bayn.hybrid-crash-vwap.shadow.v1',
      mode: HybridCrashVwapMode.Shadow,
      sessionDate: '2026-10-07',
      evaluatedAt: '2026-10-07T20:00:00.000Z',
      note: 'RESEARCH_ONLY_no_live_fills',
    })
    expect(record.candidates.map(({ symbol }) => symbol)).toEqual(['CRDO', 'SNDK'])
  })
})
