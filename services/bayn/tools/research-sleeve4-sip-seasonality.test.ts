import { expect, test } from 'bun:test'
import {
  sameClockDecision,
  sameClockOutcomes,
  sameClockRegistry,
  type OpenTape,
} from './research-sleeve4-sip-seasonality'

const mockDay = (date: string, flip = false, minutes = 390): OpenTape => ({
  date,
  minutes,
  prices: new Map(
    ['AMD', 'AVGO', 'COHR', 'INTC', 'LITE', 'MRVL', 'MU', 'WDC', 'GOOGL', 'META', 'MSFT', 'NFLX', 'TSLA'].map(
      (symbol, i) => {
        const values = new Float64Array(minutes)
        values[30] = 100
        values[59] = 2
        values[60] = 100 + (flip ? -i : i)
        return [symbol, values]
      },
    ),
  ),
})

const rule = sameClockRegistry[0]
if (rule === undefined) throw new Error('Expected the first frozen rule')

test('same-clock order is determined only by the past full sessions', () => {
  const prior = mockDay('2025-03-03')
  const current = mockDay('2025-03-05', true)
  const halfDay = mockDay('2025-03-04', true, 210)
  const result = sameClockOutcomes([prior, halfDay, current], rule)
  expect(result[0]?.observed).toBe(false)
  expect(result[1]?.intended).toBe(0)
  expect(result[2]?.fills.map(({ leg, entry, exit }) => [leg.symbol, leg.side, leg.weight, entry, exit])).toEqual([
    ['AMD', -1, 0.25, 100, 100],
    ['WDC', 1, 0.25, 100, 93],
    ['GOOGL', -1, 0.25, 100, 92],
    ['TSLA', 1, 0.25, 100, 88],
  ])
  expect(sameClockDecision([prior], rule).legs.map(({ symbol }) => symbol)).toEqual(['AMD', 'WDC', 'GOOGL', 'TSLA'])
})

test('fail closed on a missing history group, without replacing exits retroactively', () => {
  const prior = mockDay('2025-03-03')
  const reduced = new Map(prior.prices)
  reduced.delete('GOOGL')
  reduced.delete('TSLA')
  expect(sameClockDecision([{ ...prior, prices: reduced }], rule)).toEqual({ observed: false, legs: [] })
  const current = mockDay('2025-03-04')
  const wdc = current.prices.get('WDC')
  const tsla = current.prices.get('TSLA')
  if (wdc === undefined || tsla === undefined) throw new Error('Missing test inputs')
  wdc[60] = 0
  tsla[30] = 0
  const target = sameClockOutcomes([prior, current], rule)[1]
  expect(target?.intended).toBe(4)
  expect(target?.fills.length).toBe(3)
  expect(target?.fills.find(({ leg }) => leg.symbol === 'WDC')?.exit).toBeNull()
  wdc[62] = 101
  expect(sameClockOutcomes([prior, current], rule)[1]?.fills.find(({ leg }) => leg.symbol === 'WDC')).toMatchObject({
    exit: 101,
    delay: 2,
  })
})

test('the 64 registered variants are unique and the spread gate can leave both groups in cash', () => {
  expect(sameClockRegistry.length).toBe(64)
  expect(new Set(sameClockRegistry.map(({ id }) => id)).size).toBe(64)
  const first = mockDay('2025-03-03')
  const flat = new Map<string, Float64Array>()
  for (const [symbol, values] of first.prices) {
    const discounted = values.slice()
    discounted[60] = 100
    flat.set(symbol, discounted)
  }
  expect(sameClockDecision([{ ...first, prices: flat }], rule)).toEqual({ observed: true, legs: [] })
})
