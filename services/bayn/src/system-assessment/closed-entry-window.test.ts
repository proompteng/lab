import { qualificationDeadlines } from './configuration'
import { registeredSchedule } from './schedule'
import { validateOperationalRegistration } from './operational-period'
import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { ClosedEntryWindowSchema } from '../cycle/runner/pass-observation'
import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from '../broker/identity'
import { closedEntryWindowWork, type ControllerPassEvidence } from './decision-work'
import { operationalRegistrationFixture } from './operational-period.test-support'
import { testHash } from './fixtures.test-support'
import { emptySourceCutFixture } from './source-cut.test-support'
import { bindOperationalObligations } from './operational-obligations'
import { measureReliability, ObligationClass } from './reliability'

const fixture = (evaluatedAt = '2026-11-04T00:00:02.000Z') => {
  const registration = operationalRegistrationFixture()
  const candidate = registration.policies[0]
  const clock = (offset: number) => new Date(Date.parse(evaluatedAt) + offset).toISOString()
  const window = Schema.decodeUnknownSync(ClosedEntryWindowSchema)({
    schemaVersion: 'bayn.closed-entry-window.v1',
    accountId: candidate.riskPolicy.accountId,
    authorityGenerationHash: candidate.authorityGenerationHash,
    strategyProtocolHash: candidate.protocolHash,
    executionPolicy: Result.getOrThrow(
      makeCycleExecutionPolicyFromModel(registration.obligations.configuration.protocol.executionModel),
    ),
    evaluatedAt,
    decidedAt: clock(5),
    calendar: registration.calendar.marketCalendar,
    calendarRead: {
      requestId: 'retained-calendar-read',
      status: 200,
      contentHash: testHash('broker response'),
      observedAt: clock(4),
    },
  })
  const identity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: candidate.riskPolicy.accountId,
    }),
  )
  const observation = {
    result: 'SUCCESS' as const,
    outcome: 'WINDOW_CLOSED' as const,
    executionIssuedAt: evaluatedAt,
    observedAt: clock(6),
    closedEntryWindow: window,
    executionBuild: {
      sourceRevision: candidate.sourceRevision,
      imageRepository: 'registry.example.test/lab/bayn',
      imageDigest: `sha256:${candidate.imageDigest}`,
    },
  }
  const pass: ControllerPassEvidence = {
    controllerKey: identity.identityHash,
    planHash: registration.obligations.configuration.controllerPlanHash!,
    epoch: 1,
    sequence: 1,
    receiptHash: testHash(observation),
    completedAt: clock(7),
    observation,
  }
  return { registration, window, observation, pass, witnessedAt: clock(8) }
}

test('an evidenced closed window reproduces its actual calendar, owner and causal completion', () => {
  const f = fixture()
  expect(Result.getOrThrow(closedEntryWindowWork(f.pass, f.registration, f.witnessedAt))).toEqual({
    sourceAt: f.window.evaluatedAt,
    correct: true,
  })
  const { closedEntryWindow: _proof, ...bare } = f.observation
  expect(
    Result.getOrThrow(closedEntryWindowWork({ ...f.pass, observation: bare }, f.registration, f.witnessedAt)),
  ).toBeUndefined()
  for (const changed of [
    { ...f.window, accountId: 'other-account' },
    { ...f.window, authorityGenerationHash: null },
    { ...f.window, authorityGenerationHash: testHash('other-generation') },
    { ...f.window, strategyProtocolHash: testHash('other-policy') },
    { ...f.window, decidedAt: f.window.evaluatedAt },
    { ...f.window, calendarRead: { ...f.window.calendarRead, status: 503 } },
    { ...f.window, calendarRead: { ...f.window.calendarRead, observedAt: f.witnessedAt } },
    {
      ...f.window,
      calendar: { ...f.window.calendar, requestedRange: { start: '2026-11-05' as const, end: '2026-12-04' as const } },
    },
  ]) {
    const pass = { ...f.pass, observation: { ...f.observation, closedEntryWindow: changed } }
    expect(Result.getOrThrow(closedEntryWindowWork(pass, f.registration, f.witnessedAt))?.correct).toBe(false)
  }
  expect(
    Result.getOrThrow(
      closedEntryWindowWork(
        {
          ...f.pass,
          observation: {
            ...f.observation,
            executionBuild: { ...f.observation.executionBuild, sourceRevision: 'b'.repeat(40) },
          },
        },
        f.registration,
        f.witnessedAt,
      ),
    )?.correct,
  ).toBe(false)
})

test('an open or substituted calendar cannot be relabeled as a closed-market abstention', () => {
  const f = fixture('2026-11-04T15:00:02.000Z')
  const registration = {
    ...f.registration,
    calendar: {
      ...f.registration.calendar,
      sessions: [{ ...f.registration.calendar.sessions[0]!, closeAt: '2026-11-05T00:00:00.000Z' }],
    },
  }
  expect(Result.getOrThrow(closedEntryWindowWork(f.pass, registration, f.witnessedAt))?.correct).toBe(false)
  const { normalizedResponseHash: _hash, ...material } = f.window.calendar
  const empty = { ...material, sessions: [], providerSessions: [] }
  const substituted = { ...f.window, calendar: { ...empty, normalizedResponseHash: testHash(empty) } }
  expect(
    Result.getOrThrow(
      closedEntryWindowWork(
        { ...f.pass, observation: { ...f.observation, closedEntryWindow: substituted } },
        registration,
        f.witnessedAt,
      ),
    )?.correct,
  ).toBe(false)
})

test('closed work uses its original scheduled bucket and durable deadline; omitted or late work remains a miss', () => {
  const first = fixture()
  const second = fixture('2026-11-04T00:01:02.000Z')
  const passes = [first.pass, { ...second.pass, sequence: 2 }]
  const { cut: base } = emptySourceCutFixture()
  const cut = {
    ...base,
    asOf: '2026-11-04T00:03:00.000Z',
    registrationHash: testHash(first.registration),
    controllerPasses: passes,
    decisions: [],
    mutations: [],
    durableObservations: passes.map((p) => ({
      kind: 'CONTROLLER' as const,
      sourceHash: p.receiptHash,
      sourceAt: p.completedAt,
      witnessedAt: new Date(Date.parse(p.completedAt) + 1).toISOString(),
      correct: true,
    })),
  }
  const measure = (source: typeof cut) => {
    const bound = Result.getOrThrow(bindOperationalObligations(source, first.registration, testHash(source)))
    return Result.getOrThrow(measureReliability(bound.reliability)).classes.find(
      (c) => c.class === ObligationClass.Decision,
    )!
  }
  expect(measure(cut).correctOnTime).toBe('2')
  expect(measure({ ...cut, controllerPasses: [first.pass] }).correctOnTime).toBe('1')
  const late = { ...cut, durableObservations: cut.durableObservations.map((w) => ({ ...w, witnessedAt: cut.asOf })) }
  expect(measure(late).correctOnTime).toBe('0')
  expect(measure(late).scheduled).toBe('2')
})

test('an exact reconciliation completes pending checks within their original bounds without removing outage misses', () => {
  const base = operationalRegistrationFixture()
  const configuration = {
    ...base.obligations.configuration,
    reconciliationIntervalMs: 30_000,
    reconciliationStaleThresholdMs: 120_000,
  }
  const uncommitted = {
    ...base,
    obligations: { ...base.obligations, configuration, ...Result.getOrThrow(qualificationDeadlines(configuration)) },
  }
  const schedule = Result.getOrThrow(registeredSchedule(uncommitted))
  const registration = {
    ...uncommitted,
    obligations: {
      ...uncommitted.obligations,
      decisionScheduleHash: schedule.find((r) => r.class === ObligationClass.Decision)!.scheduleEvidenceHash,
      reconciliationScheduleHash: schedule.find((r) => r.class === ObligationClass.Reconciliation)!
        .scheduleEvidenceHash,
    },
  }
  expect(Result.isSuccess(validateOperationalRegistration(registration))).toBe(true)
  const { cut: original } = emptySourceCutFixture()
  const measure = (offsets: readonly number[]) => {
    const cut = {
      ...original,
      registrationHash: testHash(registration),
      asOf: '2026-11-04T00:04:00.000Z',
      mutations: [],
      decisions: [],
      controllerPasses: [],
      durableObservations: offsets.map((seconds) => ({
        kind: 'RECONCILIATION' as const,
        sourceHash: testHash(seconds),
        sourceAt: new Date(Date.parse('2026-11-04T00:00:00.000Z') + seconds * 1000).toISOString(),
        witnessedAt: new Date(Date.parse('2026-11-04T00:00:00.000Z') + seconds * 1000 + 1000).toISOString(),
        correct: true,
      })),
    }
    const bound = Result.getOrThrow(bindOperationalObligations(cut, registration, testHash(cut)))
    return Result.getOrThrow(measureReliability(bound.reliability)).classes.find(
      (c) => c.class === ObligationClass.Reconciliation,
    )!
  }
  expect(measure([65, 95]).scheduled).toBe('4')
  expect(measure([65, 95]).correctOnTime).toBe('4')
  expect(measure([181]).scheduled).toBe('4')
  expect(measure([181]).correctOnTime).toBe('1')
  expect(measure([181]).missed).toHaveLength(3)
})
