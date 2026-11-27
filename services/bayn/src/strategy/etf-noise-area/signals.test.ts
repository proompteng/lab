import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import type { EquityProviderSession } from '../../equity-hours'
import { OrderSide } from '../../execution/contracts'
import { planNoiseAreaEntries, planNoiseAreaExit, planNoiseAreaProtection } from './exit-plan'
import { defaultEtfNoiseAreaPolicy } from './policy'
import { evaluateNoiseAreaCheckpoint, noiseAreaSessionSchedule, type PriorNoiseAreaSession } from './signals'

const micros = 1_000_000n
const session = (date: string, halfDay = false): EquityProviderSession => ({
  date,
  regularOpenAt: `${date}T14:30:00.000Z`,
  regularCloseAt: `${date}T${halfDay ? 18 : 21}:00:00.000Z`,
  sessionOpenAt: `${date}T13:00:00.000Z`,
  sessionCloseAt: `${date}T22:00:00.000Z`,
})

const fixture = (date: string, time = '15:00', halfDay = false, price = 102n * micros) => {
  const target = session(date, halfDay)
  const checkpointAt = `${date}T${time}:00.000Z`
  const start = new Date(Date.parse(checkpointAt) - 60_000).toISOString()
  const observedAt = `${date}T${time}:03.000Z`
  const history = []
  for (let day = Date.parse(target.regularOpenAt) - 86_400_000; history.length < 14; day -= 86_400_000) {
    const prior = new Date(day)
    const priorDate = prior.toISOString().slice(0, 10)
    if (prior.getUTCDay() !== 0 && prior.getUTCDay() !== 6 && priorDate !== '2026-11-26') {
      history.unshift(session(priorDate))
    }
  }
  const priorSessions: PriorNoiseAreaSession[] = history.map((prior) => ({
    symbol: 'QQQ',
    sessionDate: prior.date,
    availableAt: prior.regularCloseAt,
    openPriceMicros: 100n * micros,
    highPriceMicros: 102n * micros,
    lowPriceMicros: 98n * micros,
    closePriceMicros: 100n * micros,
    previousClosePriceMicros: 100n * micros,
    checkpointCloseMicros: Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [(i + 1) * 30, (i % 2 === 0 ? 101n : 99n) * micros]),
    ),
  }))
  return {
    policy: defaultEtfNoiseAreaPolicy,
    symbol: 'QQQ' as const,
    sessionDate: date,
    providerSessions: [...history, target],
    checkpointAt,
    observedAt,
    position: { _tag: 'Flat', entryTaken: false } as const,
    priorSessions,
    bars: [
      {
        symbol: 'QQQ' as const,
        eventAt: target.regularOpenAt,
        availableAt: `${date}T14:31:01.000Z`,
        openPriceMicros: 100n * micros,
        closePriceMicros: 100n * micros,
      },
      {
        symbol: 'QQQ' as const,
        eventAt: start,
        availableAt: observedAt,
        openPriceMicros: 100n * micros,
        closePriceMicros: price,
      },
    ] as const,
  }
}

const evaluate = (input: Parameters<typeof evaluateNoiseAreaCheckpoint>[0]) =>
  Result.getOrThrow(evaluateNoiseAreaCheckpoint(input))

describe('calendar checkpoints and mandatory flatten', () => {
  test('uses the actual summer regular-session open and the 10:00–15:00 ET grid', () => {
    const summer = {
      ...session('2026-07-10'),
      regularOpenAt: '2026-07-10T13:30:00.000Z',
      regularCloseAt: '2026-07-10T20:00:00.000Z',
    }
    const result = Result.getOrThrow(noiseAreaSessionSchedule(defaultEtfNoiseAreaPolicy, summer))
    expect(result.checkpointTimes.map((at) => at.slice(11, 16))).toEqual([
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
      '16:30',
      '17:00',
      '17:30',
      '18:00',
      '18:30',
      '19:00',
    ])
    expect(result.flattenAt).toBe('2026-07-10T19:58:00.000Z')
    expect(result.earlyClose).toBe(false)
  })

  for (const [name, date] of [
    ['Black Friday', '2026-11-27'],
    ['Christmas Eve', '2026-12-24'],
  ]) {
    test(`${name}: last checkpoint 12:30 ET and flatten 12:58 ET even with extended data and no bars`, () => {
      const schedule = Result.getOrThrow(noiseAreaSessionSchedule(defaultEtfNoiseAreaPolicy, session(date, true)))
      expect(schedule.checkpointTimes.map((at) => at.slice(11, 16))).toEqual([
        '15:00',
        '15:30',
        '16:00',
        '16:30',
        '17:00',
        '17:30',
      ])
      expect(schedule.flattenAt).toBe(`${date}T17:58:00.000Z`)
      const breakout = evaluate(fixture(date, '17:30', true))
      if (breakout._tag !== 'LongBreakout') throw new Error('expected last checkpoint breakout')
      const [entry] = Result.getOrThrow(
        planNoiseAreaEntries({
          policy: defaultEtfNoiseAreaPolicy,
          signals: [breakout],
          capitalBudgetMicros: 180_000n * micros,
          usedGrossMicros: 0n,
        }),
      )
      if (entry === undefined) throw new Error('expected funded breakout')
      expect(entry.flattenAt).toBe(schedule.flattenAt)
      const protection = Result.getOrThrow(planNoiseAreaProtection(defaultEtfNoiseAreaPolicy, entry, 102n * micros))
      expect(protection.flattenAt).toBe(schedule.flattenAt)
      expect(evaluate(fixture(date, '18:00', true))._tag).toBe('NoSignal')

      const holding = {
        ...fixture(date, '17:30', true),
        position: { _tag: 'Holding', side: 'SHORT' } as const,
        bars: [],
        priorSessions: [],
      }
      expect(evaluate({ ...holding, observedAt: `${date}T17:57:59.999Z` })._tag).toBe('NoSignal')
      const flatten = evaluate({ ...holding, observedAt: schedule.flattenAt })
      expect(flatten._tag).toBe('TimedHalfDayFlatten')
      if (flatten._tag !== 'TimedHalfDayFlatten') throw new Error('expected timed exit')
      expect(planNoiseAreaExit(flatten)).toEqual({
        symbol: 'QQQ',
        side: OrderSide.Buy,
        reason: 'TimedHalfDayFlatten',
        reduceOnly: true,
        flattenAt: `${date}T17:58:00.000Z`,
      })
      expect(evaluate({ ...holding, observedAt: `${date}T18:10:00.000Z` })).toEqual(flatten)
      expect(
        evaluate({ ...holding, observedAt: schedule.flattenAt, position: { _tag: 'Flat', entryTaken: false } })._tag,
      ).toBe('NoSignal')
    })
  }

  test('requires unambiguous provider regular hours and keeps a full-day exit distinct', () => {
    const value = fixture('2026-11-25')
    const holding = {
      ...value,
      observedAt: '2026-11-25T20:58:00.000Z',
      position: { _tag: 'Holding', side: 'LONG' } as const,
    }
    expect(evaluate(holding)._tag).toBe('TimedFlatten')
    expect(Result.isFailure(evaluateNoiseAreaCheckpoint({ ...holding, providerSessions: [] }))).toBe(true)
    expect(
      Result.isFailure(
        evaluateNoiseAreaCheckpoint({
          ...holding,
          providerSessions: [session(value.sessionDate), session(value.sessionDate)],
        }),
      ),
    ).toBe(true)
    const wrongDate = { ...session(value.sessionDate), regularCloseAt: '2026-11-26T18:00:00.000Z' }
    expect(Result.isFailure(noiseAreaSessionSchedule(value.policy, wrongDate))).toBe(true)
  })

  test('never shifts the checkpoint grid for a delayed open, but retains the regular-close flatten', () => {
    const date = '2026-11-27'
    const delayed = { ...session(date, true), regularOpenAt: `${date}T15:00:00.000Z` }
    expect(Result.getOrThrow(noiseAreaSessionSchedule(defaultEtfNoiseAreaPolicy, delayed))).toEqual({
      checkpointTimes: [],
      flattenAt: `${date}T17:58:00.000Z`,
      earlyClose: true,
    })
  })
})

describe('causal Noise Area evaluator', () => {
  const date = '2026-11-25'

  test('uses strict comparisons on both bands and the previous close on a gap', () => {
    const long = evaluate(fixture(date))
    expect(long).toMatchObject({
      _tag: 'LongBreakout',
      atr14Micros: 4n * micros,
      sessionOpenPriceMicros: 100n * micros,
      referencePriceMicros: 102n * micros,
    })
    expect(evaluate(fixture(date, '15:00', false, 98n * micros))._tag).toBe('ShortBreakout')
    for (const boundary of [101_200_000n, 98_800_000n]) {
      expect(evaluate(fixture(date, '15:00', false, boundary))._tag).toBe('NoSignal')
    }
    expect(evaluate(fixture(date, '15:00', false, 101_200_001n))._tag).toBe('LongBreakout')
    expect(evaluate(fixture(date, '15:00', false, 98_799_999n))._tag).toBe('ShortBreakout')

    const value = fixture(date, '15:00', false, 103n * micros)
    const gap = {
      ...value,
      priorSessions: value.priorSessions.map((row, index) =>
        index === 13 ? { ...row, highPriceMicros: 103n * micros, closePriceMicros: 103n * micros } : row,
      ),
    }
    expect(evaluate(gap)._tag).toBe('NoSignal')
    const short = fixture(date, '15:00', false, 97n * micros)
    expect(
      evaluate({
        ...short,
        priorSessions: short.priorSessions.map((row, index) =>
          index === 13 ? { ...row, lowPriceMicros: 97n * micros, closePriceMicros: 97n * micros } : row,
        ),
      })._tag,
    ).toBe('NoSignal')
  })

  test('takes 14 same-minute absolute returns and includes overnight gaps in ATR', () => {
    const value = fixture(date)
    const priorSessions = value.priorSessions.map((row, index) => ({
      ...row,
      previousClosePriceMicros: index === 0 ? 90n * micros : row.previousClosePriceMicros,
      checkpointCloseMicros: { 30: (index % 2 === 0 ? 99n : 101n) * micros },
    }))
    expect(evaluate({ ...value, priorSessions })).toMatchObject({
      _tag: 'LongBreakout',
      atr14Micros: 4_571_429n,
    })
    const inside = fixture(date, '15:00', false, 101_100_000n)
    expect(evaluate({ ...inside, priorSessions })._tag).toBe('NoSignal')
  })

  test('keeps observed zero returns in the mean', () => {
    const value = fixture(date, '15:30', false, 100_900_000n)
    const priorSessions = value.priorSessions.map((row, index) => ({
      ...row,
      checkpointCloseMicros: { 60: (index < 7 ? 100n : 101n) * micros },
    }))
    // Seven 0% and seven 1% samples give a 0.6% band after the multiplier.
    expect(evaluate({ ...value, priorSessions })._tag).toBe('LongBreakout')
  })

  test.each([
    ['LONG', 99n * micros, 100n * micros],
    ['SHORT', 102n * micros, 101n * micros],
  ] as const)('exits a held %s across a zero-width band but suppresses flat entries', (side, price, anchor) => {
    const value = fixture(date, '15:30', false, price)
    const priorSessions = value.priorSessions.map((row, index) => ({
      ...row,
      // Prior close is $101 and today's open is $100, so the two anchor levels differ.
      closePriceMicros: index === 13 ? 101n * micros : row.closePriceMicros,
      checkpointCloseMicros: { 60: row.openPriceMicros },
    }))
    const position = { _tag: 'Holding', side } as const
    expect(evaluate({ ...value, priorSessions })._tag).toBe('NoSignal')
    expect(evaluate({ ...fixture(date, '15:30', false, anchor), priorSessions, position })._tag).toBe('NoSignal')
    expect(evaluate({ ...value, priorSessions, position })).toEqual({
      _tag: 'OppositeBandExit',
      symbol: 'QQQ',
      side,
      flattenAt: `${date}T20:58:00.000Z`,
    })
  })

  test('ignores future events, revisions, and target-session history instead of leaking them', () => {
    const value = fixture(date)
    const futureAt = `${date}T15:00:04.000Z`
    const laterBar = { ...value.bars[1], availableAt: futureAt, closePriceMicros: 80n * micros }
    const priorSessions = value.priorSessions.flatMap((row) => [
      row,
      { ...row, availableAt: futureAt, checkpointCloseMicros: { 30: 102n * micros } },
    ])
    expect(
      evaluate({
        ...value,
        providerSessions: [...value.providerSessions, session('2026-11-27', true)],
        priorSessions: [...priorSessions, ...priorSessions.map((row) => ({ ...row, sessionDate: date }))],
        bars: [
          ...value.bars,
          laterBar,
          { ...laterBar, eventAt: `${date}T15:00:00.000Z` },
          { ...laterBar, eventAt: `${date}T14:29:00.000Z` },
          { ...value.bars[1], symbol: 'SMH' },
        ],
      }),
    ).toEqual(evaluate(value))

    expect(evaluate({ ...value, bars: [value.bars[0], laterBar] })).toEqual({
      _tag: 'MissingWarmup',
      reason: 'CurrentBars',
    })
    expect(evaluate({ ...value, observedAt: `${date}T14:59:59.999Z` })._tag).toBe('NoSignal')
    expect(evaluate({ ...value, observedAt: `${date}T15:01:00.000Z` })._tag).toBe('NoSignal')
    expect(evaluate(fixture(date, '15:15'))._tag).toBe('NoSignal')
  })

  test.each([
    ['opening', 0, '14:30:59.999'],
    ['checkpoint-ending', 1, '14:59:59.999'],
  ] as const)('fails the observation on a premature %s revision even with a finalized row', (_, index, time) => {
    const value = fixture(date)
    const premature = { ...value.bars[index], availableAt: `${date}T${time}Z` }
    expect(evaluateNoiseAreaCheckpoint({ ...value, bars: [...value.bars, premature] })).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'NoiseAreaInputError', message: expect.stringContaining(premature.eventAt) },
    })
  })

  test('fails the observation on a premature prior summary even with a finalized summary or missing warmup', () => {
    const value = fixture(date)
    const prior = value.priorSessions.at(-1)
    if (prior === undefined) throw new Error('expected warmup fixture')
    const premature = { ...prior, availableAt: `${prior.sessionDate}T20:59:59.999Z` }
    const priorSessions = [...value.priorSessions, premature]
    const failure = {
      _tag: 'Failure',
      failure: { _tag: 'NoiseAreaInputError', message: expect.stringContaining(prior.sessionDate) },
    }
    expect(evaluateNoiseAreaCheckpoint({ ...value, priorSessions })).toMatchObject(failure)
    expect(evaluateNoiseAreaCheckpoint({ ...value, priorSessions: priorSessions.slice(1), bars: [] })).toMatchObject(
      failure,
    )
  })

  test('fails closed on missing, conflicting, or nonmatching official warmup and current bars', () => {
    const value = fixture(date, '18:30')
    const prior = value.priorSessions.at(-1)
    if (prior === undefined) throw new Error('expected warmup fixture')
    expect(evaluate({ ...value, priorSessions: value.priorSessions.slice(1) })).toMatchObject({
      _tag: 'MissingWarmup',
      reason: 'PriorSessions',
    })
    expect(evaluate({ ...value, priorSessions: [...value.priorSessions, prior] })).toMatchObject({
      _tag: 'MissingWarmup',
      reason: 'PriorSessions',
    })
    expect(
      evaluate({
        ...value,
        priorSessions: [...value.priorSessions.slice(0, -1), { ...prior, checkpointCloseMicros: {} }],
      }),
    ).toMatchObject({ _tag: 'MissingWarmup', reason: 'PriorCheckpoint' })
    expect(
      evaluate({
        ...value,
        providerSessions: [...value.providerSessions.slice(0, -2), session(prior.sessionDate, true), session(date)],
        priorSessions: [
          ...value.priorSessions.slice(0, -1),
          { ...prior, availableAt: `${prior.sessionDate}T18:00:00.000Z` },
        ],
      }),
    ).toMatchObject({ _tag: 'MissingWarmup', reason: 'PriorCheckpoint' })
    for (const bars of [[value.bars[1]], [...value.bars, value.bars[1]]]) {
      expect(evaluate({ ...value, bars })).toMatchObject({ _tag: 'MissingWarmup', reason: 'CurrentBars' })
    }
  })

  test('exits only through the opposite band without reversing or re-entering', () => {
    for (const [side, price, orderSide] of [
      ['LONG', 98n * micros, OrderSide.Sell],
      ['SHORT', 102n * micros, OrderSide.Buy],
    ] as const) {
      const position = { _tag: 'Holding', side } as const
      const value = fixture(date, '15:30', false, price)
      expect(evaluate({ ...fixture(date, '15:30', false, 100n * micros), position })._tag).toBe('NoSignal')
      expect(evaluate({ ...value, position: { _tag: 'Flat', entryTaken: true } })._tag).toBe('NoSignal')
      const exit = evaluate({ ...value, position })
      if (exit._tag !== 'OppositeBandExit') throw new Error('expected opposite-band exit')
      expect(planNoiseAreaExit(exit)).toMatchObject({ side: orderSide, reason: 'OppositeBandExit', reduceOnly: true })
    }
  })
})
