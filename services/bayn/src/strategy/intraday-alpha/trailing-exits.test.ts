import { expect, test } from 'bun:test'
import { breakevenStopAfterOneR, noiseAreaExitLevel, tightenProtectiveStop } from './trailing-exits'

test('the paper exit uses the breakout-side band, distinct from the opposite-band ablation', () => {
  expect(noiseAreaExitLevel(1, 'vwap-boundary', 101, 98, 102)).toBe(102)
  expect(noiseAreaExitLevel(1, 'vwap-boundary', 103, 98, 102)).toBe(103)
  expect(noiseAreaExitLevel(-1, 'vwap-boundary', 97, 98, 102)).toBe(97)
  expect(noiseAreaExitLevel(-1, 'vwap-boundary', 99, 98, 102)).toBe(98)
  expect(noiseAreaExitLevel(1, 'opposite-band', 101, 98, 102)).toBe(98)
  expect(noiseAreaExitLevel(-1, 'opposite-band', 101, 98, 102)).toBe(102)
})

test('protective stops only tighten and breakeven requires at least one original R', () => {
  expect(tightenProtectiveStop(1, 100, 97)).toBe(100)
  expect(tightenProtectiveStop(-1, 100, 103)).toBe(100)
  expect(breakevenStopAfterOneR(1, 98, 100, 2, 101.99)).toBe(98)
  expect(breakevenStopAfterOneR(1, 98, 100, 2, 102)).toBe(100)
  expect(breakevenStopAfterOneR(-1, 102, 100, 2, 98)).toBe(100)
  expect(breakevenStopAfterOneR(-1, 99, 100, 2, 98)).toBe(99)
})
