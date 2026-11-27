import { expect, test } from 'bun:test'
import { adaptiveEntryCollarBps, adaptiveStopBufferBps } from './adaptive-collars'

test('entry collars are 10% of ATR14 in price-relative bps, clamped independently of price scale', () => {
  expect(adaptiveEntryCollarBps(100, 0)).toBe(15)
  expect(adaptiveEntryCollarBps(100, 2.5)).toBe(25)
  expect(adaptiveEntryCollarBps(10, 0.25)).toBe(25)
  expect(adaptiveEntryCollarBps(100, 12)).toBe(40)
})

test('stop buffers are 25% of ATR14 relative to the stop price and do not inherit the entry collar', () => {
  expect(adaptiveStopBufferBps(80, 2)).toBe(62.5)
  expect(adaptiveStopBufferBps(100, 0)).toBe(0)
  expect(adaptiveStopBufferBps(100, 400)).toBeNull()
})

test('invalid reference prices and missing or negative volatility fail closed', () => {
  for (const helper of [adaptiveEntryCollarBps, adaptiveStopBufferBps]) {
    expect(helper(0, 1)).toBeNull()
    expect(helper(Infinity, 1)).toBeNull()
    expect(helper(100, NaN)).toBeNull()
    expect(helper(100, -1)).toBeNull()
    expect(helper(100, Infinity)).toBeNull()
  }
})
