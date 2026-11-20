import { describe, expect, test } from 'bun:test'

import { calendarTargets, compileCalendar, type TargetSplit } from './cosmosalpha-calendar-targets'

const days = ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07']
const train: TargetSplit = { name: 'train', startDate: days[0], endDate: days[3] }
const targets = (prices: number[], splits = [train]) =>
  calendarTargets(compileCalendar(days, splits), Float64Array.from(prices))

describe('complete-calendar return targets', () => {
  test('uses the earlier complete-calendar close even if it is outside index membership', () => {
    const all = targets([100, 101, Number.NaN, 180])
    expect(all[0]).toEqual({ status: 'ok', split: 'train', endpoint: { index: 1, sessions: 1 }, value: 101 / 100 - 1 })
    expect([all[0], all[3]].map((target) => target?.endpoint?.index ?? null)).toEqual([1, null])
  })

  test.each([
    [150, 0.1],
    [50, -0.1],
  ])('compresses a suspension ending at %s using calendar sessions', (close, value) => {
    expect(targets([100, Number.NaN, Number.NaN, close])[0]).toEqual({
      status: 'ok',
      split: 'train',
      endpoint: { index: 3, sessions: 3 },
      value,
    })
  })

  test('does not clip an adjacent-session return across a weekend', () => {
    expect(targets([100, 100, 150, 150])[1]).toEqual({
      status: 'ok',
      split: 'train',
      endpoint: { index: 2, sessions: 1 },
      value: 0.5,
    })
  })

  test.each([0, -10])('does not skip the finite invalid endpoint %s to find a later profitable close', (bad) => {
    const result = targets([100, bad, 150, 160])
    expect(result[0]).toEqual({
      status: 'invalid-endpoint-close',
      split: 'train',
      endpoint: { index: 1, sessions: 1 },
      value: null,
    })
    expect(result[1]?.status).toBe('invalid-current-close')
  })

  test('handles invalid current closes and all-nonfinite tails explicitly', () => {
    const result = targets([Number.NaN, 100, Number.NaN, Number.POSITIVE_INFINITY])
    expect(result.map((target) => target.status)).toEqual([
      'invalid-current-close',
      'cutoff',
      'invalid-current-close',
      'invalid-current-close',
    ])
    expect(result.every((target) => target.value === null)).toBe(true)
  })

  test('never carries a label endpoint from training into a later split', () => {
    const splits: TargetSplit[] = [
      { name: 'train', startDate: days[0], endDate: '2020-01-05' },
      { name: 'test', startDate: days[2], endDate: days[3] },
    ]
    const result = targets([100, 110, 1000, 1200], splits)
    expect(result[1]).toEqual({ status: 'cutoff', split: 'train', endpoint: null, value: null })
    expect(result[2]?.endpoint?.index).toBe(3)
    expect(result[3]?.status).toBe('cutoff')
    expect(targets([100, 110, 1, Number.NaN], splits).slice(0, 2)).toEqual(result.slice(0, 2))
  })

  test('leaves warmup and between-split dates outside target admission', () => {
    const result = targets([100, 101, 102, 103], [{ name: 'train', startDate: days[1], endDate: days[2] }])
    expect(result[0]?.status).toBe('outside-split')
    expect(result[3]?.status).toBe('outside-split')
    expect(result[2]?.status).toBe('cutoff')
  })

  test('future split prices cannot change any earlier split targets', () => {
    const calendar = Array.from({ length: 20 }, (_, i) => `2020-02-${String(i + 1).padStart(2, '0')}`)
    const layout = compileCalendar(calendar, [
      { name: 'train', startDate: '2020-02-01', endDate: '2020-02-10' },
      { name: 'test', startDate: '2020-02-11', endDate: '2020-02-20' },
    ])
    for (let seed = 0; seed < 40; seed += 1) {
      const prices = Float64Array.from(calendar, (_, i) => ((i + seed) % 4 === 0 ? Number.NaN : 10 + i))
      const original = calendarTargets(layout, prices).slice(0, 10)
      prices.fill(seed % 2 === 0 ? 100000 : Number.NaN, 10)
      expect(calendarTargets(layout, prices).slice(0, 10)).toEqual(original)
    }
  })

  test('rejects duplicate calendars, invalid dates, overlapping splits and incomplete price arrays', () => {
    expect(() => compileCalendar([days[0], days[0]], [train])).toThrow()
    expect(() => compileCalendar(['2020-02-30'], [train])).toThrow()
    expect(() => compileCalendar(days, [train, { name: 'test', startDate: days[2], endDate: days[3] }])).toThrow()
    expect(() => targets([100, 101])).toThrow()
  })
})
