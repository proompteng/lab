import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeCandidate6Decision } from './decision'
import type { Candidate6DecisionInput, Candidate6DecisionFailure } from './model'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'

const weekdays = (start: string, end: string): readonly IsoDate[] => {
  const dates: IsoDate[] = []
  const cursor = new Date(`${start}T00:00:00.000Z`)
  const final = new Date(`${end}T00:00:00.000Z`)
  while (cursor <= final) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10) as IsoDate)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

const calendar = weekdays('2021-12-20', '2022-02-11')
const signalDate = '2022-01-25' as IsoDate
const executionDate = '2022-01-26' as IsoDate

const makeBar = (
  sessionDate: IsoDate,
  close = sessionDate === signalDate ? 99.6 : 100,
  overrides: Partial<DailyBar> = {},
): DailyBar => ({
  symbol: 'SPY',
  sessionDate,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 2_000_000,
  source: DataSource.Alpaca,
  sourceFeed: DataFeed.Sip,
  adjustment: PriceAdjustment.All,
  publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
  ...overrides,
})

const decisionBars = (): readonly DailyBar[] => {
  const signalIndex = calendar.indexOf(signalDate)
  return calendar.slice(signalIndex - 19, signalIndex + 1).map((date) => makeBar(date))
}

const input = (overrides: Partial<Candidate6DecisionInput> = {}): Candidate6DecisionInput => {
  const resolvedSignalDate = overrides.signalDate ?? signalDate
  return {
    signalDate: resolvedSignalDate,
    executionDate,
    publicationAsOf: overrides.publicationAsOf ?? resolvedSignalDate,
    calendar,
    bars: decisionBars(),
    position: { activeEntrySignalDate: null, currentWeights: { SPY: 0 } },
    portfolioEquityUsd: 1_000_000,
    finalizedAtEpochMilliseconds: 1_700_000_000_000,
    observedAtEpochMilliseconds: 1_700_000_060_000,
    ...overrides,
  }
}

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'fixture must succeed')
  return result.success
}

const failure = <A>(result: Result.Result<A, Candidate6DecisionFailure>): Candidate6DecisionFailure => {
  assert(Result.isFailure(result), 'fixture must fail')
  return result.failure
}

describe('candidate 6 pure decision', () => {
  test('is deterministic and input-order invariant', () => {
    const ordered = success(makeCandidate6Decision(input()))
    const reversed = success(makeCandidate6Decision(input({ bars: [...decisionBars()].reverse() })))

    expect(reversed).toEqual(ordered)
    expect(ordered).toMatchObject({
      candidateOrdinal: 6,
      strategyName: 'month-end-liquidity-reversal',
      action: 'enter',
      reason: 'entry-signal',
      targetWeights: { SPY: 0.3 },
    })
    expect(ordered.feature?.pressureReturn).toBeCloseTo(-0.004, 12)
    expect(ordered.feature?.bufferedRoundTripCost).toBeCloseTo(0.0015, 12)
    expect(ordered.orderIntents).toEqual([
      {
        symbol: 'SPY',
        side: 'buy',
        fromWeight: 0,
        toWeight: 0.3,
        weightDelta: 0.3,
        maximumNotionalUsd: 300_000,
        reason: 'month-end-pressure-entry',
      },
    ])
  })

  test('never reads or accepts a future bar', () => {
    const issue = failure(makeCandidate6Decision(input({ bars: [...decisionBars(), makeBar(executionDate)] })))
    expect(issue).toEqual({ _tag: 'FutureBar', sessionDate: executionDate, signalDate })
  })

  test('keeps target exposure and turnover bounded, including liquidity sizing', () => {
    const decision = success(makeCandidate6Decision(input({ portfolioEquityUsd: 1_000_000_000 })))
    expect(decision.targetWeights.SPY).toBeCloseTo(0.0009998, 12)
    expect(decision.constraints.grossExposure).toBeLessThanOrEqual(decision.constraints.maximumGrossExposure)
    expect(decision.constraints.oneWayTurnover).toBeLessThanOrEqual(decision.constraints.maximumOneWayTurnover)
    expect(decision.targetWeights.SPY).toBeLessThanOrEqual(decision.constraints.maximumSymbolWeight)
  })

  test('requires expected reversion to clear buffered round-trip costs', () => {
    const expensiveBars = decisionBars().map((bar) =>
      bar.sessionDate === signalDate ? makeBar(signalDate, 99.8) : bar,
    )
    const decision = success(makeCandidate6Decision(input({ bars: expensiveBars })))
    expect(decision.action).toBe('cash')
    expect(decision.reason).toBe('cost-exceeds-expected-reversion')
    expect(decision.feature?.netExpectedReversion).toBeLessThanOrEqual(0)
    expect(decision.orderIntents).toEqual([])
  })

  test('holds through T+3, exits at T+3 close for T+4 open, and exits overdue exposure', () => {
    const activeEntrySignalDate = signalDate
    const holdSignal = '2022-01-31' as IsoDate
    const holdExecution = '2022-02-01' as IsoDate
    const hold = success(
      makeCandidate6Decision(
        input({
          signalDate: holdSignal,
          executionDate: holdExecution,
          position: { activeEntrySignalDate, currentWeights: { SPY: 0.34 } },
          bars: calendar.slice(0, calendar.indexOf(holdSignal) + 1).map((date) => makeBar(date)),
        }),
      ),
    )
    expect(hold).toMatchObject({ action: 'hold', reason: 'active-hold-window', targetWeights: { SPY: 0.34 } })

    const exitSignal = '2022-02-03' as IsoDate
    const exitExecution = '2022-02-04' as IsoDate
    const exit = success(
      makeCandidate6Decision(
        input({
          signalDate: exitSignal,
          executionDate: exitExecution,
          position: { activeEntrySignalDate, currentWeights: { SPY: 0.35 } },
          bars: calendar.slice(0, calendar.indexOf(exitSignal) + 1).map((date) => makeBar(date)),
        }),
      ),
    )
    expect(exit).toMatchObject({ action: 'exit', reason: 'scheduled-exit', targetWeights: { SPY: 0 } })
    expect(exit.orderIntents[0]?.reason).toBe('scheduled-reversal-exit')

    const overdueSignal = '2022-02-04' as IsoDate
    const overdue = success(
      makeCandidate6Decision(
        input({
          signalDate: overdueSignal,
          executionDate: '2022-02-07',
          position: { activeEntrySignalDate, currentWeights: { SPY: 0.12 } },
          bars: calendar.slice(0, calendar.indexOf(overdueSignal) + 1).map((date) => makeBar(date)),
        }),
      ),
    )
    expect(overdue).toMatchObject({ action: 'exit', reason: 'overdue-exit', targetWeights: { SPY: 0 } })
    expect(overdue.orderIntents[0]?.reason).toBe('overdue-risk-exit')
  })

  test('trims market drift above the exposure cap without changing the hold clock', () => {
    const signal = '2022-01-31' as IsoDate
    const trim = success(
      makeCandidate6Decision(
        input({
          signalDate: signal,
          executionDate: '2022-02-01',
          position: { activeEntrySignalDate: signalDate, currentWeights: { SPY: 0.36 } },
          bars: calendar.slice(0, calendar.indexOf(signal) + 1).map((date) => makeBar(date)),
        }),
      ),
    )
    expect(trim).toMatchObject({ action: 'hold', reason: 'exposure-cap-trim', targetWeights: { SPY: 0.35 } })
    expect(trim.orderIntents[0]?.reason).toBe('exposure-cap-trim')
  })

  test('stays cash through the T+1 transition and liquidates any unexpected exposure', () => {
    const transitionCalendar = [
      '2024-05-23',
      '2024-05-24',
      '2024-05-28',
      '2024-05-29',
      '2024-05-30',
      '2024-05-31',
    ] as const satisfies readonly IsoDate[]
    const excluded = success(
      makeCandidate6Decision(
        input({
          signalDate: '2024-05-24',
          executionDate: '2024-05-28',
          calendar: transitionCalendar,
          bars: [],
        }),
      ),
    )
    expect(excluded).toMatchObject({ action: 'cash', reason: 'calendar-exclusion', targetWeights: { SPY: 0 } })

    const liquidate = success(
      makeCandidate6Decision(
        input({
          signalDate: '2024-05-24',
          executionDate: '2024-05-28',
          calendar: transitionCalendar,
          bars: [],
          position: { activeEntrySignalDate: null, currentWeights: { SPY: 0.2 } },
        }),
      ),
    )
    expect(liquidate).toMatchObject({ action: 'exit', reason: 'calendar-exclusion', targetWeights: { SPY: 0 } })
    expect(liquidate.orderIntents[0]?.reason).toBe('calendar-exclusion-exit')
  })
})

describe('candidate 6 fail-closed outcomes', () => {
  test.each([
    ['duplicate calendar', () => input({ calendar: [...calendar, signalDate] }), 'InvalidCalendar'],
    ['unsorted calendar', () => input({ calendar: [...calendar].reverse() }), 'InvalidCalendar'],
    [
      'missing signal calendar',
      () => input({ calendar: calendar.filter((date) => date !== signalDate) }),
      'InvalidCalendar',
    ],
    ['wrong execution session', () => input({ executionDate: '2022-01-27' }), 'InvalidExecutionSession'],
    ['wrong publication session', () => input({ publicationAsOf: '2022-01-24' }), 'PublicationSessionMismatch'],
    ['observation before finalization', () => input({ observedAtEpochMilliseconds: 1 }), 'InvalidObservationTime'],
    ['stale finalization', () => input({ observedAtEpochMilliseconds: 1_700_100_000_001 }), 'StaleFinalization'],
    ['non-finite equity', () => input({ portfolioEquityUsd: Number.NaN }), 'InvalidPortfolioEquity'],
    [
      'negative current weight',
      () => input({ position: { activeEntrySignalDate: null, currentWeights: { SPY: -0.1 } } }),
      'InvalidCurrentWeight',
    ],
    [
      'unbound exposure',
      () => input({ position: { activeEntrySignalDate: null, currentWeights: { SPY: 0.1 } } }),
      'UnboundExposure',
    ],
    [
      'unknown active entry',
      () => input({ position: { activeEntrySignalDate: '2022-01-24', currentWeights: { SPY: 0.1 } } }),
      'UnknownActiveEntry',
    ],
  ] as const)('%s', (_label, makeInput, tag) => {
    expect(failure(makeCandidate6Decision(makeInput()))._tag).toBe(tag)
  })

  test.each([
    ['duplicate bar', () => [...decisionBars(), decisionBars()[0] as DailyBar], 'DuplicateBar'],
    [
      'non-finite open',
      () =>
        decisionBars().map((bar) =>
          bar.sessionDate === signalDate ? makeBar(signalDate, 99.6, { open: Number.NaN }) : bar,
        ),
      'MalformedBar',
    ],
    [
      'invalid range',
      () =>
        decisionBars().map((bar) => (bar.sessionDate === signalDate ? makeBar(signalDate, 99.6, { high: 90 }) : bar)),
      'MalformedBar',
    ],
    [
      'wrong adjustment',
      () =>
        decisionBars().map((bar) =>
          bar.sessionDate === signalDate ? makeBar(signalDate, 99.6, { adjustment: 'raw' as PriceAdjustment }) : bar,
        ),
      'UnexpectedCorporateActionPolicy',
    ],
    [
      'wrong source',
      () =>
        decisionBars().map((bar) =>
          bar.sessionDate === signalDate ? makeBar(signalDate, 99.6, { source: 'other' as DataSource }) : bar,
        ),
      'UnexpectedMarketDataSource',
    ],
    [
      'wrong feed',
      () =>
        decisionBars().map((bar) =>
          bar.sessionDate === signalDate ? makeBar(signalDate, 99.6, { sourceFeed: 'other' as DataFeed }) : bar,
        ),
      'UnexpectedMarketDataFeed',
    ],
    [
      'wrong schema',
      () =>
        decisionBars().map((bar) =>
          bar.sessionDate === signalDate
            ? makeBar(signalDate, 99.6, { publicationSchemaVersion: 'other' as PublicationSchema })
            : bar,
        ),
      'UnexpectedPublicationSchema',
    ],
    ['missing required bar', () => decisionBars().slice(1), 'MissingBar'],
    ['insufficient liquidity', () => decisionBars().map((bar) => ({ ...bar, volume: 1 })), 'InsufficientLiquidity'],
  ] as const)('%s', (_label, makeBars, tag) => {
    expect(failure(makeCandidate6Decision(input({ bars: makeBars() })))._tag).toBe(tag)
  })

  test('rejects insufficient history before feature construction', () => {
    const shortCalendar = weekdays('2022-01-17', '2022-01-31')
    const issue = failure(
      makeCandidate6Decision(
        input({
          signalDate,
          executionDate,
          calendar: shortCalendar,
          bars: shortCalendar.slice(0, shortCalendar.indexOf(signalDate) + 1).map((date) => makeBar(date)),
        }),
      ),
    )
    expect(issue).toMatchObject({ _tag: 'InsufficientHistory', required: 20 })
  })
})
