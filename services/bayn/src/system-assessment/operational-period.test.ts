import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { QualificationRuntimeSchema, qualificationDeadlines } from './configuration'
import { MarketKind } from '../instruments'
import { operationalRegistrationFixture } from './operational-period.test-support'
import { validateOperationalRegistration, verifyStoredOperationalRegistration } from './operational-period'
import { registrationFixture, testHash } from './fixtures.test-support'
import { JevAcceptanceVersion } from '../jev/acceptance'
import { registeredSchedule } from './schedule'
import { ObligationClass } from './reliability'
import { sha256 } from '../hash'
import { currentEntryMarkets } from '../execution/trading-scope'

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

test('stored v38 operational periods retain their exact identity but cannot register as current periods', () => {
  const registration = operationalRegistrationFixture(
    registrationFixture(undefined, 20, JevAcceptanceVersion.RetainedV5),
  )
  const verified = Result.getOrThrow(verifyStoredOperationalRegistration(registration))
  expect(verified.registration).toEqual(registration)
  expect(verified.registrationHash).toBe(testHash(registration))
  expect(registration.obligations.configuration.protocol.schemaVersion).toBe('bayn.jev.protocol.v38')
  expect(Result.isFailure(validateOperationalRegistration(registration))).toBe(true)
  const configuration = registration.obligations.configuration
  for (const protocol of [
    { ...configuration.protocol, schemaVersion: 'bayn.jev.protocol.v40' },
    { ...configuration.protocol, maximumEntryLimitSlippageBps: 0 },
  ])
    expect(
      Result.isFailure(
        verifyStoredOperationalRegistration({
          ...registration,
          obligations: { ...registration.obligations, configuration: { ...configuration, protocol } },
        }),
      ),
    ).toBe(true)
})

test('the streaming operational controller cannot borrow a retained polling runtime', () => {
  const registration = operationalRegistrationFixture()
  expect(registration.obligations.configuration.schemaVersion).toBe('bayn.qualification-runtime.v2')
  expect(registration.obligations.configuration).not.toHaveProperty('cyclePollIntervalMs')
  const polling = registrationFixture().obligations.configuration
  const configuration = {
    ...polling,
    controllerPlanHash: registration.obligations.configuration.controllerPlanHash,
    entryMarkets: currentEntryMarkets,
  }
  const mixed = {
    ...registration,
    obligations: {
      ...registration.obligations,
      ...Result.getOrThrow(qualificationDeadlines(configuration)),
      configuration,
    },
  }
  expect(Result.isFailure(validateOperationalRegistration(mixed))).toBe(true)
  const retainedConfiguration = { ...configuration, controllerPlanHash: sha256('bayn.execution-controller-plan.v3') }
  const retained = {
    ...mixed,
    obligations: {
      ...mixed.obligations,
      ...Result.getOrThrow(qualificationDeadlines(retainedConfiguration)),
      configuration: retainedConfiguration,
    },
  }
  expect(Result.getOrThrow(verifyStoredOperationalRegistration(retained)).registration).toEqual(retained)
  expect(testHash(retained)).toBe(Result.getOrThrow(verifyStoredOperationalRegistration(retained)).registrationHash)
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
