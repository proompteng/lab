import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import {
  alphaBaselinePreparationIdentity,
  reproduceAlphaBaselinePreparation,
  reproduceRecordedAlphaBaselinePreparation,
} from './alpha-baseline-preparation'
import { preparedAlphaBaselineFixture } from './alpha-baseline-preparation.test-support'

test('preparation reproduces a prior-session baseline before any completed regular-session observation', () => {
  const record = preparedAlphaBaselineFixture()
  expect(Result.isSuccess(reproduceRecordedAlphaBaselinePreparation(record))).toBe(true)
  expect(record.payload.acquisition.completedAt < '2026-09-04T13:30:00.000Z').toBe(true)
  expect(record.payload.acquisition.trailingBaseline.latestPriorSessionDate).toBe('2026-09-03')
  expect(Object.keys(record.payload.acquisition.trailingBaseline.symbols)).toHaveLength(20)
})

test('scope survives cycle rollover and calendar range changes but separates releases and accounts', () => {
  const { payload } = preparedAlphaBaselineFixture()
  const identity = Result.getOrThrow(alphaBaselinePreparationIdentity(payload, payload.executionBuild))
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      [
        { session_open: '0400', session_close: '2000', date: '2026-09-03', open: '09:30', close: '16:00' },
        { session_open: '0400', session_close: '2000', date: '2026-09-04', open: '09:30', close: '16:00' },
      ],
      { start: '2026-09-03', end: '2026-09-04' },
    ),
  )
  expect(
    Result.getOrThrow(
      alphaBaselinePreparationIdentity({ ...payload, cycleId: 'f'.repeat(64), calendar }, payload.executionBuild),
    ).scopeHash,
  ).toBe(identity.scopeHash)
  expect(
    Result.getOrThrow(
      alphaBaselinePreparationIdentity(payload, { ...payload.executionBuild, imageDigest: `sha256:${'b'.repeat(64)}` }),
    ).scopeHash,
  ).not.toBe(identity.scopeHash)
  expect(
    Result.getOrThrow(
      alphaBaselinePreparationIdentity({ ...payload, accountId: 'other-account' }, payload.executionBuild),
    ).scopeHash,
  ).not.toBe(identity.scopeHash)
})

test('source rows, query identities and actual acquisition/record clocks cannot be substituted', () => {
  const record = preparedAlphaBaselineFixture()
  const { acquisition } = record.payload
  const { inputs } = acquisition
  const first = inputs.intradayDailyRows[0]
  expect(first).toBeDefined()
  for (const changed of [
    { ...acquisition, trailingBaseline: { ...acquisition.trailingBaseline, latestPriorSessionDate: '2026-09-02' } },
    { ...acquisition, inputs: { ...inputs, intradayDailyRows: [...inputs.intradayDailyRows, first] } },
    {
      ...acquisition,
      inputs: {
        ...inputs,
        intradayDailyRows: [
          { ...first, sessionDate: record.payload.sessionDate },
          ...inputs.intradayDailyRows.slice(1),
        ],
      },
    },
    { ...acquisition, query: { ...acquisition.query, minimumSessions: 6 } },
    { ...acquisition, completedAt: '2026-09-04T12:01:01.000Z' },
    { ...acquisition, startedAt: '2026-09-04T11:59:59.000Z' },
  ]) {
    expect(Result.isFailure(reproduceAlphaBaselinePreparation({ ...record.payload, acquisition: changed }))).toBe(true)
  }
  expect(
    Result.isFailure(reproduceRecordedAlphaBaselinePreparation({ ...record, recordedAt: '2026-09-04T12:01:02.999Z' })),
  ).toBe(true)
})
