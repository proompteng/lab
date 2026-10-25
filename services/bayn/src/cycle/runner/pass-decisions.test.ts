import { expect, test } from 'bun:test'
import { Schema } from 'effect'

import { candidateObservationFixture } from '../../testing/candidate-observation-fixture'
import { cyclePassLogFacts, retainAutonomousCyclePassObservation } from './pass-decisions'
import { RetainedAutonomousCyclePassObservationSchema } from './pass-observation'
import { DecisionReadinessReason } from './readiness'
import { Reason as RiskReason } from '../../risk'
import { strictParseOptions } from '../../schemas'
import type { CyclePassObservation } from './model'

test('retains readiness and holding reasons through the durable observation schema and log projection', () => {
  const { cycle } = candidateObservationFixture()
  const readiness = {
    reason: DecisionReadinessReason.SnapshotCoverage,
    message: 'intraday symbol lacks the complete rolling lookback baseline',
    symbol: 'IWM',
  }
  const observation: CyclePassObservation = {
    outcome: 'SUCCEEDED',
    observedAt: '2026-09-04T14:30:02.000Z',
    result: {
      outcome: 'RECOVERED',
      action: 'WAITING',
      readiness,
      observedAt: '2026-09-04T14:30:02.000Z',
      cycle,
    },
  }
  const retained = retainAutonomousCyclePassObservation(observation)
  expect(Schema.decodeUnknownSync(RetainedAutonomousCyclePassObservationSchema)(retained)).toEqual(retained)
  expect(retained).toMatchObject({ recoveryAction: 'WAITING', readiness })
  expect(cyclePassLogFacts(observation).annotations).toMatchObject({
    recoveryAction: 'WAITING',
    readiness: JSON.stringify(readiness),
  })
  const holding = retainAutonomousCyclePassObservation({
    ...observation,
    result: {
      outcome: 'RECOVERED',
      action: 'WAITING',
      observedAt: observation.observedAt,
      cycle,
      waitReason: 'ENTRY_INTENTS_SETTLED_UNTIL_CLOSE',
    },
  })
  expect(Schema.decodeUnknownSync(RetainedAutonomousCyclePassObservationSchema)(holding)).toEqual(holding)
  expect(holding).toMatchObject({ recoveryAction: 'WAITING', waitReason: 'ENTRY_INTENTS_SETTLED_UNTIL_CLOSE' })
  expect(Schema.is(RetainedAutonomousCyclePassObservationSchema)({ ...retained, recoveryAction: 'COMPLETED' })).toBe(
    false,
  )
})

test('still decodes a retained pass written before readiness details were available', () => {
  const previous = { result: 'SUCCESS', outcome: 'RECOVERED', observedAt: '2026-09-04T14:30:02.000Z' } as const
  expect(Schema.decodeUnknownSync(RetainedAutonomousCyclePassObservationSchema)(previous)).toEqual(previous)
})

test('durable account protection retains typed limit reasons and accepts older observations', () => {
  const previous = {
    result: 'SUCCESS',
    outcome: 'RECOVERED',
    recoveryAction: 'WAITING',
    observedAt: '2026-09-04T14:30:02.000Z',
    readiness: { reason: DecisionReadinessReason.AccountProtection, message: 'Existing account limit' },
  } as const
  const decode = Schema.decodeUnknownSync(RetainedAutonomousCyclePassObservationSchema, strictParseOptions)
  expect(decode(JSON.parse(JSON.stringify(previous)))).toEqual(previous)
  const current = {
    ...previous,
    readiness: {
      ...previous.readiness,
      accountProtectionReasons: [RiskReason.DailyLossExceeded, RiskReason.DrawdownExceeded] as const,
    },
  }
  for (const accountProtectionReasons of [
    [RiskReason.DailyLossExceeded],
    [RiskReason.DrawdownExceeded],
    [RiskReason.DailyLossExceeded, RiskReason.DrawdownExceeded],
  ] as const) {
    const serialized = { ...current, readiness: { ...current.readiness, accountProtectionReasons } }
    expect(decode(JSON.parse(JSON.stringify(serialized)))).toEqual(serialized)
  }
  for (const accountProtectionReasons of [
    [],
    ['UNKNOWN'],
    null,
    RiskReason.DailyLossExceeded,
    [RiskReason.DrawdownExceeded, RiskReason.DrawdownExceeded],
  ]) {
    expect(() =>
      decode({
        ...current,
        readiness: { ...current.readiness, accountProtectionReasons },
      }),
    ).toThrow()
  }
  expect(() =>
    decode({
      ...current,
      readiness: { ...current.readiness, reason: DecisionReadinessReason.SnapshotStale },
    }),
  ).toThrow()
  expect(() => decode({ ...current, readiness: { ...current.readiness, unknownField: true } })).toThrow()
})

test('rejects newly tagged waiting observations without exactly one reason', () => {
  const waiting = {
    result: 'SUCCESS',
    outcome: 'RECOVERED',
    recoveryAction: 'WAITING',
    observedAt: '2026-09-04T14:30:02.000Z',
  }
  expect(Schema.is(RetainedAutonomousCyclePassObservationSchema)(waiting)).toBe(false)
  expect(
    Schema.is(RetainedAutonomousCyclePassObservationSchema)({
      ...waiting,
      waitReason: 'ENTRY_INTENTS_SETTLED_UNTIL_CLOSE',
      readiness: { reason: DecisionReadinessReason.DecisionPending, message: 'waiting for a decision' },
    }),
  ).toBe(false)
})

test('retains a broker-cache wait without inventing a recovered cycle', () => {
  const waiting: CyclePassObservation = {
    outcome: 'WAITING',
    observedAt: '2026-09-04T14:30:02.000Z',
    waitReason: 'BROKER_OBSERVATION_PENDING',
  }
  const retained = retainAutonomousCyclePassObservation(waiting)
  expect(Schema.decodeUnknownSync(RetainedAutonomousCyclePassObservationSchema)(retained)).toEqual(retained)
  expect(retained).toEqual({ result: 'SUCCESS', ...waiting })
  expect(cyclePassLogFacts(waiting).level).toBe('INFO')
  expect(Schema.is(RetainedAutonomousCyclePassObservationSchema)({ ...retained, waitReason: undefined })).toBe(false)
  expect(Schema.is(RetainedAutonomousCyclePassObservationSchema)({ ...retained, recoveryAction: 'WAITING' })).toBe(
    false,
  )
})

test('retains a cycle-free admission wait with its exact evidence clock even when completion crosses expiry', () => {
  const observation = {
    outcome: 'SUCCEEDED',
    observedAt: '2026-09-04T14:31:00.001Z',
    result: {
      outcome: 'ADMISSION_WAITING',
      observedAt: '2026-09-04T14:30:02.000Z',
      readiness: {
        reason: DecisionReadinessReason.AccountProtection,
        message: 'DRAWDOWN_EXCEEDED',
        accountProtectionReasons: [RiskReason.DrawdownExceeded],
      },
      admissionProtection: {
        authorityGenerationHash: 'a'.repeat(64),
        authorityUpdatedAt: '2026-09-04T14:29:00.123456Z',
        reconciliationId: 'b'.repeat(64),
        tradingDate: '2026-09-04',
        validUntil: '2026-09-04T14:31:00.000Z',
      },
    },
  } as const satisfies CyclePassObservation
  const retained = retainAutonomousCyclePassObservation(observation)
  expect(Schema.decodeUnknownSync(RetainedAutonomousCyclePassObservationSchema)(retained)).toEqual(retained)
  expect(retained).toEqual({ result: 'SUCCESS', ...observation.result })
  expect(cyclePassLogFacts(observation)).toMatchObject({
    level: 'INFO',
    annotations: { outcome: 'ADMISSION_WAITING', reconciliationId: 'b'.repeat(64) },
  })
  for (const invalid of [
    { ...retained, admissionProtection: undefined },
    { ...retained, recoveryAction: 'WAITING' },
    { ...retained, waitReason: 'BROKER_OBSERVATION_PENDING' },
    { ...retained, readiness: { reason: DecisionReadinessReason.SnapshotUnavailable, message: 'source unavailable' } },
    { ...retained, outcome: 'RECOVERED', recoveryAction: 'WAITING' },
    {
      ...retained,
      admissionProtection: { ...observation.result.admissionProtection, validUntil: observation.result.observedAt },
    },
  ])
    expect(Schema.is(RetainedAutonomousCyclePassObservationSchema)(invalid)).toBe(false)
})
