import { expect, test } from 'bun:test'

import { closedLeg, type Bar } from './noise-area-study-replay'
import {
  breakEvenSlippage,
  confirms,
  NoiseConfirmation,
  OpeningRange,
  replayReversion,
  sessionFeatures,
  trialCount,
  Volatility,
  walkForwardVolatility,
} from './research-10yr-intraday-vwap-regime'

// Isolated micro-fixtures for clock and fill invariants; they are never inputs to the historical study.
const bar = (close: number, open = 100, vwap = 100, volume = 20): Bar => ({
  open,
  high: Math.max(101, open, close, vwap),
  low: Math.min(99, open, close, vwap),
  close,
  volume,
  vwap,
})

const flat = (slots: number): (Bar | undefined)[] => Array.from({ length: slots }, () => bar(100))

test('uses volume-weighted provider VWAP, freezes the opening range, and does not bridge gaps', () => {
  const bars = [bar(102, 100, 101, 40), bar(98, 102, 99, 20), bar(100), bar(115), undefined, bar(100)]
  const features = sessionFeatures(bars, bars.length)
  expect(features.vwap[0]).toBe(101)
  expect(features.vwap[1]).toBeCloseTo((101 * 40 + 99 * 20) / 60)
  expect(features.range).toEqual({ high: 102, low: 98 })
  expect(features.vwap.slice(4)).toEqual([undefined, undefined])
  expect(features.variance).toBeUndefined()
  expect(sessionFeatures([bar(102, 100, 101), bar(98, 102, 99)], 2).variance).toBeCloseTo(
    (Math.log(102 / 100) ** 2 + Math.log(98 / 102) ** 2) / 2,
  )
})

test('confirmations observe the signal close and opening range, not later bars', () => {
  const bars = flat(78)
  bars[5] = bar(102)
  const features = sessionFeatures(bars, 78)
  for (const gate of [NoiseConfirmation.Vwap, NoiseConfirmation.Range]) {
    expect(confirms(gate, { slot: 5, side: 1 }, bars, features)).toBe(true)
    expect(confirms(gate, { slot: 5, side: -1 }, bars, features)).toBe(false)
    bars[6] = bar(1, 1, 1, 1_000_000)
    expect(confirms(gate, { slot: 5, side: 1 }, bars, sessionFeatures(bars, 78))).toBe(true)
  }
})

test('a VWAP fade sizes before the entry open and a VWAP cross exits at the next open', () => {
  const bars = flat(78)
  bars[5] = bar(98) // 09:55 bar completes at 10:00; below both VWAP and the opening range.
  bars[6] = bar(101, 105) // Entry at 10:00 open. This completed close triggers the exit.
  bars[7] = bar(100, 103) // Exit at 10:05 open, not the crossing close.
  const features = sessionFeatures(bars, 78)
  expect(replayReversion(bars, 78, features, OpeningRange.Inside).roundTrips).toBe(0)
  expect(replayReversion(bars, 78, features, OpeningRange.Any)).toMatchObject({
    ...closedLeg(1, 203, 105, 103),
    roundTrips: 1,
    lastExit: 7,
  })
  bars[6] = undefined
  expect(replayReversion(bars, 78, sessionFeatures(bars, 78), OpeningRange.Any)).toMatchObject({
    roundTrips: 0,
    missingEntries: 1,
    unresolved: 0,
  })
})

test.each([
  [78, 66, 76],
  [42, 36, 40],
])('obeys the timed flatten for a %i-slot session and never prices a late exit', (slots, entry, deadline) => {
  const bars = flat(slots)
  bars[entry - 1] = bar(98)
  for (let slot = entry; slot < slots; slot++) bars[slot] = bar(98)
  expect(replayReversion(bars, slots, sessionFeatures(bars, slots), OpeningRange.Any)).toMatchObject({
    roundTrips: 1,
    lastExit: deadline,
  })
  bars[deadline] = undefined
  const unresolved = replayReversion(bars, slots, sessionFeatures(bars, slots), OpeningRange.Any)
  expect(unresolved).toMatchObject({ roundTrips: 0, unresolved: 1, lastExit: -1 })
  expect(breakEvenSlippage(unresolved)).toBeNull()
})

test('exits at the first provable open after a bar gap while holding', () => {
  const bars = flat(78)
  bars[5] = bar(102)
  bars[6] = bar(102, 102)
  bars[7] = undefined
  bars[8] = bar(102, 103)
  expect(replayReversion(bars, 78, sessionFeatures(bars, 78), OpeningRange.Any)).toMatchObject({
    ...closedLeg(-1, 195, 102, 103),
    heldGaps: 1,
    roundTrips: 1,
    lastExit: 8,
  })
})

test('fits the median before each fold and cannot read current or later session volatility', () => {
  const dates = [
    ...Array.from({ length: 25 }, (_, i) => `2016-01-${String(i + 1).padStart(2, '0')}`),
    '2016-11-28',
    '2016-11-29',
    '2017-11-27',
  ]
  const variance: (number | undefined)[] = dates.map(() => 4)
  const reference = walkForwardVolatility(dates, variance)
  variance[25] = 400
  const changed = walkForwardVolatility(dates, variance)
  expect(changed.cutoffs.get(2017)).toEqual({ observations: 5, median: 2 })
  expect(changed.cutoffs.get(2017)).toEqual(reference.cutoffs.get(2017))
  expect(changed.cutoffs.get(2018)?.observations).toBe(7)
  expect(changed.labels.slice(25, 27)).toEqual([Volatility.Low, Volatility.High])
  variance[25] = undefined
  expect(walkForwardVolatility(dates, variance).labels.slice(25, 27)).toEqual([Volatility.Low, undefined])
})

test('uses the exact 20 non-control books × 4 costs and the signed zero-net cost root', () => {
  expect(trialCount).toBe(80)
  const execution = { roundTrips: 1, missingEntries: 0, heldGaps: 0, unresolved: 0, lastExit: 9 }
  expect(breakEvenSlippage({ ...execution, base: 45, slope: 15 })).toBe(3)
  expect(breakEvenSlippage({ ...execution, base: -45, slope: 15 })).toBe(-3)
  expect(breakEvenSlippage({ ...execution, base: 0, slope: 0 })).toBeNull()
})
