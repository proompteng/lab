import { Result } from 'effect'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
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

export const operationalRegistrationFixture = (): OperationalRegistration => {
  const base = registrationFixture()
  const candidate = base.policies.find((policy) => policy.policy === 'JEV')
  if (candidate === undefined) throw new Error('Missing candidate')
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
      tradingMarkets: base.calendar.tradingMarkets,
      sourceHash: testHash('complete native reporting scope'),
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
    obligations: base.obligations,
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
