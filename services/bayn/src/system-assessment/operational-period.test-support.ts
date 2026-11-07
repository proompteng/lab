import { Result, Schema } from 'effect'
import { MarketCalendarObservationSchema } from '../broker/alpaca/model'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { makeStrategyProtocolHashResult } from '../contracts'
import { jevBehaviorHash } from '../jev/protocol'
import { Authority, makeResearchCapitalGrantGenerationResult } from '../execution/contracts'
import {
  makeResearchCapitalActivationRequest,
  makeResearchCapitalPlanHash,
  researchCapitalGrantProof,
} from '../execution/configuration'
import { registrationFixture, testHash } from './fixtures.test-support'
import { operationalReliabilityPolicy, type OperationalRegistration } from './operational-period'
import { registeredSchedule } from './schedule'
import { ObligationClass } from './reliability'
import { currentEntryMarkets } from '../execution/trading-scope'
import { qualificationDeadlines } from './configuration'
import { executionControllerPlanHash } from '../execution/controller'

export const operationalRegistrationFixture = (base = registrationFixture()): OperationalRegistration => {
  const registered = base.policies.find((policy) => policy.policy === 'JEV')
  if (registered === undefined) throw new Error('Missing candidate')
  const candidate = {
    ...registered,
    strategyHash: jevBehaviorHash,
    protocolHash: Result.getOrThrow(
      makeStrategyProtocolHashResult({
        name: 'jev',
        behaviorHash: jevBehaviorHash,
        parameterHash: registered.parametersHash,
        parameterSchemaVersion: base.obligations.configuration.protocol.schemaVersion,
      }),
    ),
    executionModelHash: testHash(base.obligations.configuration.protocol.executionModel),
  }
  const broker = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: candidate.riskPolicy.accountId,
    }),
  )
  const material = {
    activation: {
      sourceRevision: candidate.sourceRevision,
      imageRepository: 'registry.example.test/lab/bayn',
      imageDigest: `sha256:${candidate.imageDigest}`,
    },
    strategy: {
      name: 'jev',
      behaviorHash: candidate.strategyHash,
      parameterHash: candidate.parametersHash,
      parameterSchemaVersion: base.obligations.configuration.protocol.schemaVersion,
      protocolHash: candidate.protocolHash,
    },
    broker: { environment: broker.environment, accountId: broker.accountId, identityHash: broker.identityHash },
    riskPolicyHash: candidate.riskPolicyHash,
    limits: { maxOpenOrders: 0, maxPositions: 0 },
  } as const
  const planHash = Result.getOrThrow(
    makeResearchCapitalPlanHash({ schemaVersion: 'bayn.research-execution-plan.v1', ...material }),
  )
  const request = Result.getOrThrow(
    makeResearchCapitalActivationRequest({
      schemaVersion: 'bayn.research-execution-mandate.v1',
      grant: { _tag: 'Research', planHash },
      ...material,
    }),
  )
  const { schemaVersion: _schema, ...proof } = researchCapitalGrantProof(request)
  const generation = Result.getOrThrow(
    makeResearchCapitalGrantGenerationResult({
      ...proof,
      schemaVersion: 'bayn.paper-authority-generation.v3',
      maximum: Authority.Execution,
      previousGenerationHash: testHash('previous generation'),
      reconciliationId: testHash('reconciliation'),
      reconciliationContentHash: testHash('reconciled content'),
    }),
  )
  const buildLineage = {
    schemaVersion: 'bayn.research-capital-build-lineage.v1' as const,
    requestHash: request.requestHash,
    authoredActivation: request.activation,
    activation: request.activation,
  }
  const configuration = {
    ...base.obligations.configuration,
    controllerPlanHash: executionControllerPlanHash,
    entryMarkets: currentEntryMarkets,
  }
  const calendarMaterial = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
    source: 'alpaca-v2-calendar',
    requestedRange: { start: '2026-11-04', end: '2026-12-04' },
    timeZone: 'UTC',
    sessions: [{ date: '2026-11-04', openAt: '2026-11-04T13:00:00.000Z', closeAt: '2026-11-04T22:00:00.000Z' }],
    providerSessions: [
      {
        date: '2026-11-04',
        regularOpenAt: '2026-11-04T14:30:00.000Z',
        regularCloseAt: '2026-11-04T21:00:00.000Z',
        sessionOpenAt: '2026-11-04T13:00:00.000Z',
        sessionCloseAt: '2026-11-04T22:00:00.000Z',
      },
    ],
  }
  const marketCalendar = Schema.decodeUnknownSync(MarketCalendarObservationSchema)({
    ...calendarMaterial,
    normalizedResponseHash: testHash(calendarMaterial),
  })
  const registration: OperationalRegistration = {
    schemaVersion: 'bayn.operational-registration.v1',
    program: 'BAYN_OPERATIONAL_RELIABILITY',
    environment: 'PAPER',
    policyHash: testHash(operationalReliabilityPolicy),
    attemptIndex: 1,
    priorAttemptHash: testHash('retained history'),
    registeredAt: '2026-11-03T21:00:00.000Z',
    retainedIncidentSources: [testHash('retained failed opening and cycles')],
    calendar: {
      referenceMarket: 'NATIVE_POLICY',
      operatingHours: 'NATIVE',
      tradingMarkets: currentEntryMarkets,
      sourceHash: testHash(marketCalendar),
      marketCalendar,
      sessions: [
        { sessionDate: '2026-11-04', openAt: '2026-11-04T00:00:00.000Z', closeAt: '2026-11-04T00:02:00.000Z' },
      ],
    },
    policies: [
      {
        ...candidate,
        authorityGenerationHash: generation.generationHash,
        capitalAuthorization: { request, buildLineage, generation },
      },
    ],
    obligations: { ...base.obligations, configuration, ...Result.getOrThrow(qualificationDeadlines(configuration)) },
  }
  const schedule = Result.getOrThrow(registeredSchedule(registration))
  return {
    ...registration,
    obligations: {
      ...registration.obligations,
      decisionScheduleHash: schedule.find((row) => row.class === ObligationClass.Decision)!.scheduleEvidenceHash,
      reconciliationScheduleHash: schedule.find((row) => row.class === ObligationClass.Reconciliation)!
        .scheduleEvidenceHash,
    },
  }
}
