import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { canonicalHashV1Result, sha256 } from '../../hash'
import { defaultMultiAssetEtfPolicy, multiAssetEtfs, sleeveNames } from './policy'
import { compileMultiAssetEtfSignal } from './signals'
import { barAt, fixtureBars, fixtureCalendar, marketAt, policyAt, withoutBar } from './test-support'

const policy = policyAt()
const signals = (date: string, chosen = policy, bars = fixtureBars) =>
  Result.getOrThrow(compileMultiAssetEtfSignal(chosen, marketAt(date, bars)))

test('matches the five frozen Wave 3C sleeve books at next open', () => {
  // Generated directly with makeFeatures/signalBook at 6662581cdd7d445ddced6440e72d28c810bb38a1.
  // Use fixtureBars in Wave 3C universe order, leaving SMH and VNQ absent (no substitutions).
  // Serialize [sleeve, [[executionDate, sorted [symbol, weight × 1e10 rounded]], ...]] in sleeveNames order.
  const dates = fixtureCalendar.sessions.filter(({ date }) => date >= '2026-11-16' && date <= '2026-12-10')
  const book = dates.map(({ date }) => signals(date))
  const rows = sleeveNames.map((name) => [
    name,
    book.map(({ executionSession, sleeveAttribution }) => {
      const values = Object.entries(sleeveAttribution[name].sleeveWeights)
        .map(([symbol, weight]) => [symbol, Math.round(weight * 1e10)] as const)
        .sort(([a], [b]) => a.localeCompare(b))
      return [executionSession, values]
    }),
  ])
  expect(sha256(JSON.stringify(rows))).toBe('826d1bf67480f9c35bea382e67f26cfea08625f1c87bad5409e5bae207257885')
})

test('evaluates pension -5 and TOM -2 through +4 on exchange sessions, including a half-day', () => {
  const pension = policyAt('pension')
  expect(signals('2026-11-20', pension).sleeveAttribution.pension.sleeveWeights).toEqual({})
  for (const date of ['2026-11-23', '2026-11-25', '2026-11-27', '2026-11-30']) {
    expect(signals(date, pension).sleeveAttribution.pension.sleeveWeights).toEqual({ SPY: 1 })
  }
  expect(signals('2026-12-01', pension).sleeveAttribution.pension.sleeveWeights).toEqual({})
  const tom = policyAt('turnOfMonth')
  expect(signals('2026-11-24', tom).targetWeights).toEqual({})
  const entry = signals('2026-11-25', tom)
  expect(entry.targetWeights.SPY).toBeGreaterThan(0)
  expect(entry.targetWeights.QQQ).toBeGreaterThan(0)
  for (const date of ['2026-11-27', '2026-11-30', '2026-12-01', '2026-12-04']) {
    expect(signals(date, tom).targetWeights).toEqual(entry.targetWeights)
  }
  expect(signals('2026-12-07', tom).targetWeights).toEqual({})
  expect(fixtureCalendar.providerSessions.find(({ date }) => date === '2026-11-27')?.regularCloseAt).toBe(
    '2026-11-27T18:00:00.000Z',
  )
  expect(compileMultiAssetEtfSignal(tom, { ...marketAt('2026-11-27'), executionSession: '2026-11-26' })).toEqual(
    Result.fail({ _tag: 'InvalidCalendar', executionSession: '2026-11-26' }),
  )
})

test('property: immutable decisions never read execution-session or later bars', () => {
  const date = '2026-11-27'
  const nextSession = '2026-11-30'
  const before = JSON.stringify(signals(date))
  fc.assert(
    fc.property(fc.constantFrom(...multiAssetEtfs), fc.double({ noNaN: true }), (symbol, value) => {
      expect(
        JSON.stringify(
          signals(date, policy, {
            ...fixtureBars,
            [date]: { [symbol]: barAt(value) },
            [nextSession]: { [symbol]: barAt(-value) },
          }),
        ),
      ).toBe(before)
    }),
    { seed: 420402, numRuns: 25 },
  )
})

test('fails closed on short history, incomplete calendar, or non-point-in-time adjustments', () => {
  expect(compileMultiAssetEtfSignal(policy, marketAt('2026-02-02'))).toEqual(
    Result.fail({ _tag: 'InsufficientHistory', availableSessions: 20, requiredSessions: 121 }),
  )
  const market = marketAt('2026-11-27')
  const { normalizedResponseHash: _hash, ...calendar } = market.calendar
  const truncated = { ...calendar, requestedRange: { ...calendar.requestedRange, end: '2026-11-27' } }
  expect(
    compileMultiAssetEtfSignal(policy, {
      ...market,
      calendar: { ...truncated, normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(truncated)) },
    }),
  ).toEqual(Result.fail({ _tag: 'InvalidCalendar', executionSession: market.executionSession }))
  expect(compileMultiAssetEtfSignal(policy, { ...market, adjustmentAsOfSession: market.executionSession })).toEqual(
    Result.fail({ _tag: 'InvalidHistory', expectedAdjustmentAsOfSession: '2026-11-25' }),
  )
  expect(Result.getOrThrow(defaultMultiAssetEtfPolicy()).historyStartSession).toBe('2016-01-04')
})

test('distinguishes missing candidate legs, missing mandatory inputs, and malformed adjusted bars', () => {
  const date = '2026-11-27'
  const gap = '2026-11-25'
  const target = signals(date, policy, withoutBar(gap, 'XLK'))
  expect(target.exclusions).toContainEqual({ _tag: 'MissingSymbolBar', symbol: 'XLK', session: gap })
  expect(target.targetWeights.XLK).toBeUndefined()
  expect(target.sleeveAttribution.rotation.portfolioContribution.XLK).toBeUndefined()
  expect(target.targetWeights.SPY).toBeGreaterThan(0)

  const priorGap = '2026-11-06'
  const trend = signals(date, policy, withoutBar(priorGap, 'GLD'))
  expect(trend.exclusions).toContainEqual({ _tag: 'MissingSymbolBar', symbol: 'GLD', session: priorGap })
  expect(trend.targetWeights.GLD).toBeUndefined()

  expect(compileMultiAssetEtfSignal(policy, marketAt(date, withoutBar(gap, 'HYG')))).toEqual(
    Result.fail({ _tag: 'MissingSymbolBar', symbol: 'HYG', session: gap }),
  )
  expect(compileMultiAssetEtfSignal(policy, marketAt(date, withoutBar('2026-10-30', 'TLT')))).toEqual(
    Result.fail({ _tag: 'MissingSymbolBar', symbol: 'TLT', session: '2026-10-30' }),
  )
  expect(
    compileMultiAssetEtfSignal(
      policy,
      marketAt(date, {
        ...fixtureBars,
        [gap]: { ...fixtureBars[gap], XLK: barAt(0) },
      }),
    ),
  ).toEqual(Result.fail({ _tag: 'InvalidSymbolBar', symbol: 'XLK', session: gap }))
})

test('a consistently split-adjusted bar basis leaves sleeve weights unchanged', () => {
  const splitAdjusted = Object.fromEntries(
    Object.entries(fixtureBars).map(([day, bars]) => {
      const bar = bars?.XLK
      if (bar === undefined) throw new Error('fixture missing XLK')
      return [
        day,
        {
          ...bars,
          XLK: {
            open: bar.open / 2,
            high: bar.high / 2,
            low: bar.low / 2,
            close: bar.close / 2,
            volume: bar.volume * 2,
          },
        },
      ]
    }),
  )
  expect(signals('2026-11-27', policy, splitAdjusted)).toEqual(signals('2026-11-27'))
})

const riskOff = Object.fromEntries(
  Object.entries(fixtureBars).map(([day, bars], i) => [day, { ...bars, HYG: barAt(90 - i / 10) }]),
)

test('falls back only to the registered defensive rotation pool on a valid risk-off gate', () => {
  const rotation = policyAt('rotation')
  const target = signals('2026-11-27', rotation, riskOff).sleeveAttribution.rotation.sleeveWeights
  expect(Object.keys(target).length).toBeGreaterThan(0)
  expect(Object.keys(target).every((symbol) => ['GLD', 'TLT', 'SHY'].includes(symbol))).toBe(true)
})

test('effective attribution nets to each capped portfolio weight, separately from the explicit sweep', () => {
  const risk = { ...policy.risk, maxGrossLeverage: 0.4, maxSingleSymbolWeight: 0.15, maxNetShortWeight: 0.03 }
  const capped = signals('2026-11-27', policyAt(undefined, { risk, idleCashSweep: { enabled: true, symbol: 'SHY' } }))
  const swept = signals('2026-11-27', policyAt(undefined, { idleCashSweep: { enabled: true, symbol: 'SHY' } }), riskOff)
  expect(swept.idleCashContribution.SHY).toBeGreaterThan(0)
  expect(swept.sleeveAttribution.rotation.portfolioContribution.SHY).toBeGreaterThan(0)
  for (const result of [capped, swept]) {
    for (const symbol of multiAssetEtfs) {
      const contribution = sleeveNames.reduce(
        (sum, sleeve) => sum + (result.sleeveAttribution[sleeve].portfolioContribution[symbol] ?? 0),
        0,
      )
      expect(contribution + (result.idleCashContribution[symbol] ?? 0)).toBeCloseTo(
        result.targetWeights[symbol] ?? 0,
        12,
      )
    }
  }
  expect(Object.values(capped.targetWeights).reduce((sum, weight) => sum + Math.abs(weight), 0)).toBeCloseTo(0.4, 12)
  expect(Object.values(capped.targetWeights).every((weight) => Math.abs(weight) <= 0.15)).toBe(true)
  expect(signals('2026-11-27').idleCashContribution).toEqual({})
})
