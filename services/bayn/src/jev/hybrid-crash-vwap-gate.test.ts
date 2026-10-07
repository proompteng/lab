import { describe, expect, test } from 'bun:test'

import {
  collectCrashVwapBounceCandidates,
  evaluateHybridCrashVwapShadow,
  hybridCrashVwapParams,
  resolveHybridCrashVwapMode,
  sessionVwapSeries,
  type HybridBar,
} from './hybrid-crash-vwap-gate'

const bar = (minuteOfDay: number, close: number, opts: Partial<HybridBar> = {}): HybridBar => ({
  symbol: opts.symbol ?? 'CRDO',
  minuteOfDay,
  open: opts.open ?? close,
  high: opts.high ?? close,
  low: opts.low ?? close,
  close,
  volume: opts.volume ?? 1000,
})

describe('hybrid-crash-vwap-gate', () => {
  test('mode defaults off; on coerces to shadow', () => {
    expect(resolveHybridCrashVwapMode({})).toBe('off')
    expect(resolveHybridCrashVwapMode({ BAYN_HYBRID_CRASH_VWAP: 'off' })).toBe('off')
    expect(resolveHybridCrashVwapMode({ BAYN_HYBRID_CRASH_VWAP: 'shadow' })).toBe('shadow')
    expect(resolveHybridCrashVwapMode({ BAYN_HYBRID_CRASH_VWAP: 'on' })).toBe('shadow')
  })

  test('session VWAP is cumulative typical/volume', () => {
    const bars = [
      bar(570, 100, { high: 100, low: 100, volume: 100 }),
      bar(571, 110, { high: 110, low: 110, volume: 100 }),
    ]
    const v = sessionVwapSeries(bars)
    expect(v[0]).toBe(100)
    expect(v[1]).toBe(105)
  })

  test('fires only with crash∩VWAP and bounce confirm', () => {
    const open = hybridCrashVwapParams.rthOpenMinutes
    // Build: flat then crash -100bp below VWAP, then bounce
    const bars: HybridBar[] = []
    let px = 100
    for (let m = 0; m < 35; m++) {
      bars.push(bar(open + m, px, { volume: 1000 }))
    }
    // crash bar: -100bp
    const crashClose = px * (1 - 0.01)
    bars.push(bar(open + 35, crashClose, { volume: 5000 }))
    // bounce +1m
    bars.push(bar(open + 36, crashClose * 1.002, { volume: 1000 }))
    // continue
    bars.push(bar(open + 37, crashClose * 1.003, { volume: 1000 }))

    const hits = collectCrashVwapBounceCandidates(bars)
    expect(hits.length).toBe(1)
    expect(hits[0]!.signalMinuteOfDay).toBe(open + 35)
    expect(hits[0]!.entryMinuteOfDay).toBe(open + 36)
    expect(hits[0]!.crashBp).toBeLessThanOrEqual(-hybridCrashVwapParams.crashBp)
  })

  test('no fire without bounce', () => {
    const open = hybridCrashVwapParams.rthOpenMinutes
    const bars: HybridBar[] = []
    let px = 100
    for (let m = 0; m < 35; m++) bars.push(bar(open + m, px))
    const crashClose = px * (1 - 0.01)
    bars.push(bar(open + 35, crashClose))
    bars.push(bar(open + 36, crashClose * 0.999)) // continues down
    expect(collectCrashVwapBounceCandidates(bars)).toEqual([])
  })

  test('evaluate returns null when off; record when shadow', () => {
    const open = hybridCrashVwapParams.rthOpenMinutes
    const bars: HybridBar[] = []
    for (let m = 0; m < 35; m++) bars.push(bar(open + m, 100))
    const crashClose = 99
    bars.push(bar(open + 35, crashClose))
    bars.push(bar(open + 36, crashClose * 1.002))

    expect(
      evaluateHybridCrashVwapShadow({
        sessionDate: '2026-10-07',
        barsBySymbol: { CRDO: bars },
        env: { BAYN_HYBRID_CRASH_VWAP: 'off' },
      }),
    ).toBeNull()

    const rec = evaluateHybridCrashVwapShadow({
      sessionDate: '2026-10-07',
      barsBySymbol: { CRDO: bars },
      evaluatedAt: '2026-10-07T20:00:00.000Z',
      env: { BAYN_HYBRID_CRASH_VWAP: 'shadow' },
    })
    expect(rec).not.toBeNull()
    expect(rec!.schemaVersion).toBe('bayn.hybrid-crash-vwap.shadow.v1')
    expect(rec!.note).toBe('RESEARCH_ONLY_no_live_fills')
    expect(rec!.mode).toBe('shadow')
    expect(rec!.candidates.length).toBeGreaterThanOrEqual(1)
  })
})
