import { expect, test } from 'bun:test'

import { Enhancement } from '../src/strategy/etf-noise-area/v4/policy'
import { breadthSymbols } from '../src/strategy/etf-noise-area/v4/signals'
import { budgetedShares, capital, closedLeg, netAt, type Bar, type Day } from './noise-area-study-replay'
import { replaySessions } from './noise-area-v4-replay'

test('compares the real B0 control and applies each treatment before a separately observed fill', () => {
  const quiet = { open: 100, close: 100.1, high: 100.2, low: 99.9, volume: 1_000, vwap: 100 }
  const slots = 78
  const normal = () => Array<Bar | undefined>(slots).fill(quiet)
  const days: Day[] = Array.from({ length: 17 }, (_, i) => ({
    date: `2020-01-${String(i + 1).padStart(2, '0')}`,
    slots,
    bars: new Map(breadthSymbols.map((symbol) => [symbol, normal()])),
  }))
  const bars = normal()
  bars[5] = { ...quiet, close: 101, high: 101.1 }
  bars[6] = { ...quiet, open: 100.8, high: 104.2, low: 99.95, close: 104 }
  bars[7] = { ...quiet, open: 103, high: 104, low: 100 }
  bars[8] = { ...quiet, open: 99, low: 98.5 }
  bars[75] = { ...quiet, open: 104, high: 104.1 }
  const flatPeer = { ...quiet, close: quiet.open }
  const today = new Map(
    breadthSymbols.map((symbol) => [symbol, symbol === 'QQQ' ? bars : Array<Bar | undefined>(slots).fill(flatPeer)]),
  )
  days.push({ date: '2020-01-18', slots, bars: today })
  const row = replaySessions(days).at(-1)?.rows
  const b0 = row?.get('B0')
  const trailing = row?.get(Enhancement.Trailing)
  if (b0 === undefined || trailing === undefined) throw new Error('Missing matched replay arms')
  const quantity = budgetedShares(capital / 2, 100.8, 101)
  expect(b0.base).toBeCloseTo(closedLeg(1, quantity, 100.8, 104).base)
  expect(trailing.base).toBeCloseTo(closedLeg(1, quantity, 100.8, 99).base)
  expect(trailing.turnover).toBeCloseTo((quantity * (100.8 + 99)) / capital)
  expect(netAt(trailing, 5)).toBeCloseTo(trailing.base - 5 * trailing.slope)
  expect(netAt(trailing, 10)).toBeLessThan(netAt(trailing, 5) ?? -Infinity)
  expect(row?.get(Enhancement.Volatility)?.turnover).toBeLessThan(b0.turnover)
  expect(row?.get(Enhancement.Regime)?.trades).toBe(0)

  bars[8] = undefined
  const afterGap = replaySessions(days).at(-1)?.rows.get(Enhancement.Trailing)
  expect(afterGap?.missingHeld).toBe(1)
  expect(afterGap?.base).toBeCloseTo(closedLeg(1, quantity, 100.8, 100).base)
})
