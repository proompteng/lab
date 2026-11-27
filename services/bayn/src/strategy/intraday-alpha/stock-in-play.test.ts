import { expect, test } from 'bun:test'
import { cappedBreakoutExtension, openingRangeRelativeVolume } from './stock-in-play'

test('RVOL needs today and exactly fourteen complete same-horizon prior ranges', () => {
  const priors = Array.from({ length: 14 }, (_, i) => 100 + i * 10)
  expect(openingRangeRelativeVolume(330, priors)).toBe(2)
  expect(openingRangeRelativeVolume(330, priors.slice(1))).toBeNull()
  expect(openingRangeRelativeVolume(330, [null, ...priors.slice(1)])).toBeNull()
  expect(openingRangeRelativeVolume(null, priors)).toBeNull()
})

test('the chase cap is inclusive and symmetric for long and short breakouts', () => {
  expect(cappedBreakoutExtension(1, 101, 100, 4, 0.25)).toBeCloseTo(0.01)
  expect(cappedBreakoutExtension(-1, 99, 100, 4, 0.25)).toBeCloseTo(0.01)
  expect(cappedBreakoutExtension(1, 101.01, 100, 4, 0.25)).toBeNull()
  expect(cappedBreakoutExtension(-1, 101, 100, 4, null)).toBeNull()
})
