import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { QualificationRuntimeSchema } from './configuration'
import { MarketKind } from '../instruments'
import { operationalRegistrationFixture } from './operational-period.test-support'
import { validateOperationalRegistration } from './operational-period'
import { registeredSchedule } from './schedule'
import { ObligationClass } from './reliability'

test('operational reporting needs one real native policy, retained incidents and no economic research quotas', () => {
  const registration = operationalRegistrationFixture()
  expect(Result.isSuccess(validateOperationalRegistration(registration))).toBe(true)
  expect(registration.policies).toHaveLength(1)
  for (const changed of [
    { ...registration, bootstrap: { replicates: 10000 } },
    { ...registration, retainedIncidentSources: [] },
    {
      ...registration,
      calendar: { ...registration.calendar, tradingMarkets: ['EQUITY', 'CRYPTO'] },
    },
    {
      ...registration,
      obligations: { ...registration.obligations, decisionWindowMs: registration.obligations.decisionWindowMs + 1 },
    },
    { ...registration, policies: [{ ...registration.policies[0], capitalAuthorization: undefined }] },
  ])
    expect(Result.isFailure(validateOperationalRegistration(changed))).toBe(true)
})

test('native reporting retains global signal alignment and original deadlines across its final boundary', () => {
  const registration = operationalRegistrationFixture()
  const schedule = Result.getOrThrow(registeredSchedule(registration))
  const decisions = schedule.filter((row) => row.class === ObligationClass.Decision)
  const delay = registration.obligations.configuration.protocol.decisionDelaySeconds * 1000
  expect(Date.parse(decisions[0]!.dueAt)).toBe(Date.parse(registration.calendar.sessions[0]!.openAt) + delay)
  expect(Date.parse(decisions.at(-1)!.deadlineAt) - Date.parse(decisions.at(-1)!.dueAt)).toBe(
    registration.obligations.decisionWindowMs,
  )
  expect(decisions.at(-1)!.deadlineAt > registration.calendar.sessions[0]!.closeAt).toBe(true)
  const shifted = {
    ...registration,
    calendar: {
      ...registration.calendar,
      sessions: [{ ...registration.calendar.sessions[0]!, openAt: '2026-11-04T00:00:30.000Z' }],
    },
  }
  expect(
    Result.getOrThrow(registeredSchedule(shifted)).find((row) => row.class === ObligationClass.Decision)?.dueAt,
  ).toBe(new Date(Date.parse('2026-11-04T00:01:00.000Z') + delay).toISOString())
})

test('native reporting rejects omitted time and overlapping cuts', () => {
  const registration = operationalRegistrationFixture()
  for (const openAt of ['2026-11-05T00:00:00.000Z', '2026-11-04T00:01:00.000Z']) {
    const sessions = [
      ...registration.calendar.sessions,
      { sessionDate: '2026-11-05', openAt, closeAt: '2026-11-05T00:02:00.000Z' },
    ]
    expect(
      Result.isFailure(
        validateOperationalRegistration({ ...registration, calendar: { ...registration.calendar, sessions } }),
      ),
    ).toBe(true)
  }
})

test('new operational periods bind actual equity-only scope while retained financial runtime material remains decodable', () => {
  const registration = operationalRegistrationFixture()
  expect(registration.calendar.tradingMarkets).toEqual([MarketKind.Equity])
  expect(registration.obligations.configuration.entryMarkets).toEqual([MarketKind.Equity])
  const { entryMarkets: _scope, ...historical } = registration.obligations.configuration
  expect(Schema.decodeUnknownSync(QualificationRuntimeSchema)(historical)).toEqual(historical)
  expect(
    Result.isFailure(
      validateOperationalRegistration({
        ...registration,
        obligations: { ...registration.obligations, configuration: historical },
      }),
    ),
  ).toBe(true)
})
