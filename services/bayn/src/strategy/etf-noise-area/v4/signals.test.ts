import { expect, test } from 'bun:test'

import {
  Direction,
  breadthSymbols,
  confirmsRegime,
  inverseNoiseScale,
  observeCheckpoint,
  type Checkpoint,
} from './signals'

test('sizes against complete intraday and overnight volatility without exceeding the reservation', () => {
  const bar = { open: 100, high: 102, low: 99, close: 101, volume: 100, vwap: 101 }
  const prefix = [bar, bar, bar, bar, bar, { ...bar, close: 102, volume: 300, vwap: 102 }]
  const quiet = observeCheckpoint(prefix, 100)
  const gap = observeCheckpoint(prefix, 95)
  const typical = 0.02
  expect(quiet?.vwap).toBe(101.375)
  expect(gap?.realizedNoise).toBeCloseTo(Math.hypot(Math.log(100 / 95), Math.log(101 / 100), Math.log(102 / 101)), 12)
  expect(inverseNoiseScale(quiet, typical)).toBe(1)
  expect(inverseNoiseScale(gap, typical)).toBeCloseTo(typical / (gap?.realizedNoise ?? 0), 12)
  expect(inverseNoiseScale(observeCheckpoint(prefix), typical)).toBe(0)
  expect(observeCheckpoint([bar, undefined, ...prefix.slice(2)], 100)).toBeUndefined()
})

test('requires strict opening range and VWAP, complete external breadth, and midday directional efficiency', () => {
  const long: Checkpoint = {
    open: 100,
    close: 103,
    openingHigh: 102,
    openingLow: 99,
    vwap: 101,
    realizedNoise: 0.012,
    atr: 0.75,
    signedEfficiency: 0.2,
  }
  const map = new Map(breadthSymbols.map((symbol) => [symbol, long]))
  expect(confirmsRegime('QQQ', Direction.Long, 90, map)).toBe(true)
  expect(confirmsRegime('QQQ', Direction.Long, 120, map)).toBe(false)
  map.set('QQQ', { ...long, signedEfficiency: 0.4 })
  map.set('SMH', { ...long, close: long.open })
  expect(confirmsRegime('QQQ', Direction.Long, 120, map)).toBe(true)
  map.set('IWM', { ...long, close: long.vwap })
  expect(confirmsRegime('QQQ', Direction.Long, 120, map)).toBe(false)
  map.set('SMH', long)
  map.set('QQQ', { ...long, openingHigh: long.close })
  expect(confirmsRegime('QQQ', Direction.Long, 90, map)).toBe(false)
  map.set('QQQ', { ...long, vwap: long.close })
  expect(confirmsRegime('QQQ', Direction.Long, 90, map)).toBe(false)
  map.set('QQQ', long)
  map.delete('XLK')
  expect(confirmsRegime('QQQ', Direction.Long, 90, map)).toBe(false)

  const short = { ...long, close: 97, vwap: 99, openingLow: 98, signedEfficiency: -0.4 }
  expect(confirmsRegime('SMH', Direction.Short, 180, new Map(breadthSymbols.map((symbol) => [symbol, short])))).toBe(
    true,
  )
})
