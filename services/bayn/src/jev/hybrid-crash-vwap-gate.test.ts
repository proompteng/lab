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
const source = {
  provider: 'alpaca',
  feed: 'iex',
  datasetId: 'synthetic-test',
  calendarSource: 'synthetic-test',
  sessionCloseMinuteOfDay: 960,
}

const bar = (minuteOfDay: number, close: number, opts: Partial<HybridBar> = {}): HybridBar => ({
  symbol: opts.symbol ?? 'CRDO',
  timestamp: opts.timestamp ?? new Date(Date.UTC(2026, 9, 7, 4, minuteOfDay)).toISOString(),
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
  JSON.stringify({
    schemaVersion: hybridCrashVwapSessionBarsSchemaVersion,
    sessionDate,
    source: {
      ...source,
      universe: Object.keys(barsBySymbol),
      completedThroughMinuteOfDay: Math.max(
        open,
        ...Object.values(barsBySymbol)
          .flat()
          .map((bar) => bar.minuteOfDay),
      ),
    },
    barsBySymbol,
  })

describe('hybrid-crash-vwap-gate', () => {
  test('declared universe and watermark expose missing symbols and trailing coverage', () => {
    const input = JSON.parse(sessionText({ CRDO: crashSession([bar(open + 36, 99.2), bar(open + 37, 99.3)]) }))
    input.source.universe.push('SNDK')
    input.source.completedThroughMinuteOfDay++
    const decoded = decodeHybridCrashVwapSessionBars(JSON.stringify(input))
    if (Result.isFailure(decoded)) throw decoded.failure
    const record = evaluateHybridCrashVwapShadow({ session: decoded.success, evaluatedAt: '2026-10-07T20:00:00.000Z' })
    expect(record).toMatchObject({
      acceptanceEligible: false,
      historicalEvidence: 'UNVERIFIED_GENERATOR_AND_CORPUS_UNAVAILABLE_NO_RERUN',
      exclusions: [
        { symbol: 'CRDO', reason: 'INCOMPLETE_RTH_MINUTE_COVERAGE' },
        { symbol: 'SNDK', reason: 'INCOMPLETE_RTH_MINUTE_COVERAGE' },
      ],
    })
    expect(record.candidates).toHaveLength(1) // The earlier contiguous prefix remains diagnostic only.
    for (const sourceChange of [
      { universe: [] },
      { universe: ['CRDO', 'CRDO'] },
      { universe: ['SNDK'] },
      { completedThroughMinuteOfDay: open },
    ]) {
      expect(
        Result.isFailure(
          decodeHybridCrashVwapSessionBars(JSON.stringify({ ...input, source: { ...input.source, ...sourceChange } })),
        ),
      ).toBe(true)
    }
  })

  test('validates feed declarations and the winter New York timestamp offset', () => {
    const input = JSON.parse(sessionText({ CRDO: [bar(open, 100)] }))
    input.source.feed = 'sip'
    expect(Result.isFailure(decodeHybridCrashVwapSessionBars(JSON.stringify(input)))).toBe(true)
    delete input.source
    expect(Result.isFailure(decodeHybridCrashVwapSessionBars(JSON.stringify(input)))).toBe(true)
    const winter = sessionText({ CRDO: [bar(open, 100, { timestamp: '2026-01-05T14:30:00.000Z' })] }, '2026-01-05')
    expect(Result.isSuccess(decodeHybridCrashVwapSessionBars(winter))).toBe(true)
  })

  test('zero-volume history never fabricates session VWAP', () => {
    const bars = crashSession([bar(open + 36, 99.2), bar(open + 37, 99.3)]).map((entry) => ({ ...entry, volume: 0 }))
    expect(sessionVwapSeries(bars).every(Number.isNaN)).toBe(true)
    expect(collectCrashVwapBounceCandidates(bars)).toEqual([])
    const complete = crashSession([bar(open + 36, 99.2), bar(open + 37, 99.3)])
    for (const minute of [open + 34, open + 35, open + 36, open + 37])
      expect(
        collectCrashVwapBounceCandidates(
          complete.map((entry) => (entry.minuteOfDay === minute ? { ...entry, volume: 0 } : entry)),
        ),
      ).toEqual([])
  })

  test('rejects premarket, wrong-session and mismatched timestamps at the boundary', () => {
    for (const bars of [
      [bar(open - 1, 100), bar(open, 100)],
      [bar(open, 100, { timestamp: '2026-10-06T13:30:00.000Z' })],
      [bar(open, 100, { timestamp: '2026-10-07T13:31:00.000Z' })],
      [bar(open, 100, { timestamp: '2026-10-07T13:30:01.000Z' })],
      [bar(open, 100, { timestamp: '2026-10-07T13:30:00.000000001Z' })],
      [bar(960, 100)],
    ])
      expect(Result.isFailure(decodeHybridCrashVwapSessionBars(sessionText({ CRDO: bars })))).toBe(true)
    expect(sessionVwapSeries([bar(open - 1, 1000), bar(open, 100)])[1]).toBe(100)
  })

  test('late and gapped histories are explicitly unqualified, never session VWAP candidates', () => {
    const complete = crashSession([bar(open + 36, 99.2), bar(open + 37, 99.3)])
    for (const bars of [complete.slice(34), complete.filter((entry) => entry.minuteOfDay !== open + 10)]) {
      const decoded = decodeHybridCrashVwapSessionBars(sessionText({ CRDO: bars }))
      if (Result.isFailure(decoded)) throw decoded.failure
      expect(
        evaluateHybridCrashVwapShadow({ session: decoded.success, evaluatedAt: '2026-10-07T20:00:00.000Z' }),
      ).toMatchObject({
        candidates: [],
        exclusions: [{ symbol: 'CRDO', reason: 'INCOMPLETE_RTH_MINUTE_COVERAGE' }],
        qualification: 'UNQUALIFIED_SOURCE_DECLARATION_NOT_INDEPENDENTLY_VERIFIED',
      })
    }
  })

  test('confirmation cannot fill itself and next-open gaps are excluded', () => {
    expect(collectCrashVwapBounceCandidates(crashSession([bar(open + 36, 99.2)]))).toEqual([])
    expect(collectCrashVwapBounceCandidates(crashSession([bar(open + 36, 99.2), bar(open + 38, 99.3)]))).toEqual([])
    const hits = collectCrashVwapBounceCandidates(
      crashSession([bar(open + 36, 99.2), bar(open + 37, 99.3, { open: 99.1, low: 99.1 })]),
    )
    expect(hits[0]).toMatchObject({ confirmationClose: 99.2, entryOpen: 99.1 })
  })

  test('signal cutoff is explicit at 15:50, or 12:50 for a declared early close', () => {
    const at = (minute: number) => [
      ...Array.from({ length: minute - open }, (_, i) => bar(open + i, 100)),
      bar(minute, 99),
      bar(minute + 1, 99.2),
      bar(minute + 2, 99.3),
    ]
    expect(collectCrashVwapBounceCandidates(at(949))).toHaveLength(1)
    expect(collectCrashVwapBounceCandidates(at(950))).toEqual([])
    expect(collectCrashVwapBounceCandidates(at(769), hybridCrashVwapParams, 780)).toHaveLength(1)
    expect(collectCrashVwapBounceCandidates(at(770), hybridCrashVwapParams, 780)).toEqual([])
    const afterClose = JSON.parse(sessionText({ CRDO: [bar(780, 100)] }))
    afterClose.source.sessionCloseMinuteOfDay = 780
    expect(Result.isFailure(decodeHybridCrashVwapSessionBars(JSON.stringify(afterClose)))).toBe(true)
  })

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
    expect(hits).toMatchObject([
      {
        symbol: 'CRDO',
        signalMinuteOfDay: open + 35,
        confirmationMinuteOfDay: open + 36,
        entryMinuteOfDay: open + 37,
        entryOpen: 99 * 1.003,
      },
    ])
    expect(hits[0]?.crashBp).toBeLessThanOrEqual(-hybridCrashVwapParams.crashBp)
  })

  test('no fire without bounce', () => {
    expect(collectCrashVwapBounceCandidates(crashSession([bar(open + 36, 99 * 0.999), bar(open + 37, 99.3)]))).toEqual(
      [],
    )
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
        SNDK: crashSession([bar(open + 36, 99 * 1.002), bar(open + 37, 99.3)], 'SNDK'),
        CRDO: crashSession([bar(open + 36, 99 * 1.002), bar(open + 37, 99.3)]),
      }),
    )
    if (Result.isFailure(decoded)) throw decoded.failure
    const input = { session: decoded.success, evaluatedAt: '2026-10-07T20:00:00.000Z' }
    const record = evaluateHybridCrashVwapShadow(input)
    expect(evaluateHybridCrashVwapShadow(input)).toEqual(record)
    expect(record).toMatchObject({
      schemaVersion: 'bayn.hybrid-crash-vwap.shadow.v2',
      mode: HybridCrashVwapMode.Shadow,
      sessionDate: '2026-10-07',
      evaluatedAt: '2026-10-07T20:00:00.000Z',
      note: 'RESEARCH_ONLY_no_live_fills',
    })
    expect(record.candidates.map(({ symbol }) => symbol)).toEqual(['CRDO', 'SNDK'])
  })
})
