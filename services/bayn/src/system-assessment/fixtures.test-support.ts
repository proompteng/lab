import { Result, Schema } from 'effect'
import {
  makeRepeatedMomentumPolicy,
  repeatedMomentumStrategyIdentity,
  repeatedMomentumPromptsHash,
} from '../strategy/repeated-momentum/policy'
import {
  entryAblationStrategyIdentity,
  makeEntryAblationPolicy,
  entryAblationQuestionPolicyHash,
} from '../jev/entry-ablation-policy'
import { IsoDateSchema } from '../schemas'
import { canonicalHashV1Result, sha256 } from '../hash'
import { jevAcceptanceProtocolHash, JevResearchPolicy } from '../jev/acceptance'
import { OperatingCostCategory } from '../operating-costs'
import { ObligationClass } from './reliability'
import { frozenDeployedControlIdentity, systemQualificationPolicyHash, type SystemRegistration } from './policy'
import { registeredSchedule } from './schedule'
import { withProviderSessions } from '../testing/market-calendar-fixture'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../jev/protocol'
import { qualificationDeadlines } from './configuration'
import { systemLatencyStressProtocolHash } from './latency-protocol'
import { InferenceRateCardSchema } from '../inference-costs'
import type { ReplayInferenceCostModelSchema } from '../intraday-replay/inference-costs'
import { jevModel } from '../jev/contract'
import { decisionsModel } from '../jev/decisions'
import { MarketKind } from '../instruments'
import { costAttributionRule } from './cost-attribution'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'

export const replayRateCardFixture = (tariff: typeof ReplayInferenceCostModelSchema.Type) =>
  Schema.decodeUnknownSync(InferenceRateCardSchema)({
    schemaVersion: 'bayn.inference-rate-card.v1',
    rates: [
      { provider: 'typesafe', model: jevModel, ...tariff.jev },
      { provider: 'openai', model: decisionsModel, ...tariff.chart },
    ].map((rate) => ({
      ...rate,
      currency: 'USD',
      source: 'Synthetic registered tariff',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveUntil: '2027-01-01T00:00:00.000Z',
    })),
  })

export const testHash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))

export const registeredRiskFixture = (accountId: string) => {
  const riskPolicy = Result.getOrThrow(makeExecutionRiskPolicy(accountId, defaultJevProtocolDocument.universe))
  return {
    accountBindingHash: testHash({ schemaVersion: 'bayn.inference-cost-account.v1', accountId }),
    riskPolicyHash: testHash(riskPolicy),
    riskPolicy,
  }
}

export const calendarFixture = (registration: SystemRegistration) => {
  const material = withProviderSessions({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v2' as const,
    source: 'alpaca-v2-calendar' as const,
    timeZone: 'UTC' as const,
    requestedRange: {
      start: registration.calendar.sessions[0]?.sessionDate ?? '2026-11-02',
      end: registration.calendar.sessions.at(-1)?.sessionDate ?? '2026-11-27',
    },
    sessions: registration.calendar.sessions.map((s) => ({
      date: s.sessionDate,
      openAt: s.openAt,
      closeAt: s.closeAt,
    })),
  })
  return { ...material, normalizedResponseHash: testHash(material) }
}

const ablationIdentity = Result.getOrThrow(
  entryAblationStrategyIdentity(
    makeEntryAblationPolicy(Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))),
  ),
)

const momentumIdentity = Result.getOrThrow(
  repeatedMomentumStrategyIdentity(
    makeRepeatedMomentumPolicy(Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))),
  ),
)

const baseRegistrationFixture = (): SystemRegistration => ({
  schemaVersion: 'bayn.system-registration.v2',
  program: 'BAYN_SYSTEM_QUALIFICATION',
  environment: 'PAPER',
  policyHash: Result.getOrThrow(systemQualificationPolicyHash()),
  acceptanceProtocolHash: Result.getOrThrow(jevAcceptanceProtocolHash()),
  attemptIndex: 1,
  priorAttemptHash: sha256('reviewed prior attempt history'),
  registeredAt: '2026-10-30T12:00:00.000Z',
  calendar: {
    referenceMarket: 'US_EQUITIES',
    tradingMarkets: [MarketKind.Equity, MarketKind.Crypto],
    operatingHours: 'REGULAR_SESSION',
    sourceHash: sha256('synthetic calendar'),
    sessions: Array.from({ length: 20 }, (_, i) => {
      const day = Schema.decodeUnknownSync(IsoDateSchema)(
        new Date(Date.UTC(2026, 10, 2 + i + Math.floor(i / 5) * 2)).toISOString().slice(0, 10),
      )
      return { sessionDate: day, openAt: `${day}T14:30:00.000Z`, closeAt: `${day}T14:32:00.000Z` }
    }),
  },
  policies: Object.values(JevResearchPolicy).map((policy) => ({
    policy,
    ...registeredRiskFixture(`${policy}:account`),
    authorityGenerationHash: sha256(`${policy}:generation`),
    sourceRevision: 'a'.repeat(40),
    imageDigest: sha256('image'),
    strategyHash: sha256(policy),
    protocolHash: sha256(`${policy}:protocol`),
    parametersHash:
      policy === JevResearchPolicy.Candidate
        ? testHash(Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument)))
        : sha256(`${policy}:parameters`),
    promptsHash: sha256(`${policy}:prompts`),
    continuationAndExitsHash: sha256(`${policy}:exit`),
    costAllocationRuleHash: testHash(costAttributionRule),
    inferenceRateCard: { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] },
    executionModelHash: sha256(`${policy}:execution`),
    ...(policy === JevResearchPolicy.Momentum
      ? {
          strategyHash: momentumIdentity.strategy.behaviorHash,
          parametersHash: momentumIdentity.strategy.parameterHash,
          protocolHash: momentumIdentity.protocolHash,
          promptsHash: Result.getOrThrow(repeatedMomentumPromptsHash()),
          executionModelHash: testHash(defaultJevProtocolDocument.executionModel),
        }
      : {}),
    ...(policy === JevResearchPolicy.Ablation
      ? {
          strategyHash: ablationIdentity.strategy.behaviorHash,
          parametersHash: ablationIdentity.strategy.parameterHash,
          protocolHash: ablationIdentity.protocolHash,
          promptsHash: entryAblationQuestionPolicyHash,
          executionModelHash: testHash(defaultJevProtocolDocument.executionModel),
        }
      : {}),
    ...(policy === JevResearchPolicy.Deployed ? frozenDeployedControlIdentity : {}),
  })),
  costAllocationPlans: [],
  obligations: {
    configuration: {
      schemaVersion: 'bayn.qualification-runtime.v1',
      controllerPlanHash: sha256('controller plan'),
      cyclePollIntervalMs: 60000,
      operationTimeoutMs: 30000,
      reconciliationIntervalMs: 60000,
      reconciliationStaleThresholdMs: 180001,
      unknownMutationThresholdMs: 120000,
      protocol: Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument)),
    },
    decisionScheduleHash: sha256('decisions'),
    reconciliationScheduleHash: sha256('reconciliations'),
    decisionIntervalMs: 60000,
    decisionWindowMs: 30000,
    reconciliationIntervalMs: 60000,
    reconciliationFreshnessMs: 30000,
    mutationDeadlineMs: 30000,
    recoveryDeadlineMs: 120000,
    runtimeConfigurationHash: sha256('configuration'),
  },
  latencyReplayExecutionModelHash: sha256('shared latency execution model'),
  latencyStressProtocolHash: Result.getOrThrow(systemLatencyStressProtocolHash()),
  statisticalAssumptions: [
    'Synthetic fixture only: sessions are exchangeable under the registered two-session blocks; no live performance claim.',
  ],
})

export const withRegistrationCommitments = (registration: SystemRegistration): SystemRegistration => {
  const derived = {
    ...registration,
    costAllocationPlans: registration.policies.flatMap((definition) =>
      registration.calendar.sessions.flatMap((session) =>
        Object.values(OperatingCostCategory).map((category) => ({
          provider: `${definition.policy}:synthetic fixture`,
          category,
          serviceStartDate: session.sessionDate,
          serviceEndDateExclusive: Schema.decodeUnknownSync(IsoDateSchema)(
            new Date(Date.parse(session.sessionDate) + 86400000).toISOString().slice(0, 10),
          ),
          basisSourceHash: testHash({
            syntheticCostBasis: definition.accountBindingHash,
            category,
            sessionDate: session.sessionDate,
          }),
          weights: [
            { accountBindingHash: definition.accountBindingHash, sessionDate: session.sessionDate, weight: '1' },
          ],
        })),
      ),
    ),
    obligations: {
      ...registration.obligations,
      ...Result.getOrThrow(qualificationDeadlines(registration.obligations.configuration)),
    },
  }
  const schedule = Result.getOrThrow(registeredSchedule(derived))
  const decisions = schedule.find((o) => o.class === ObligationClass.Decision)
  const reconciliations = schedule.find((o) => o.class === ObligationClass.Reconciliation)
  if (decisions === undefined || reconciliations === undefined) throw new Error('Missing fixture schedule')
  return {
    ...derived,
    obligations: {
      ...derived.obligations,
      decisionScheduleHash: decisions.scheduleEvidenceHash,
      reconciliationScheduleHash: reconciliations.scheduleEvidenceHash,
    },
  }
}

export const registrationFixture = (registeredAt?: string): SystemRegistration => {
  let registration = baseRegistrationFixture()
  if (registeredAt !== undefined) {
    const firstMonday = new Date(registeredAt)
    firstMonday.setUTCDate(firstMonday.getUTCDate() + ((8 - firstMonday.getUTCDay()) % 7 || 7))
    firstMonday.setUTCHours(0, 0, 0, 0)
    registration = {
      ...registration,
      registeredAt,
      calendar: {
        ...registration.calendar,
        sessions: registration.calendar.sessions.map((session, index) => {
          const sessionDate = Schema.decodeUnknownSync(IsoDateSchema)(
            new Date(firstMonday.getTime() + (index + Math.floor(index / 5) * 2) * 86400000).toISOString().slice(0, 10),
          )
          return {
            sessionDate,
            openAt: sessionDate + session.openAt.slice(10),
            closeAt: sessionDate + session.closeAt.slice(10),
          }
        }),
      },
    }
  }
  return withRegistrationCommitments({
    ...registration,
    calendar: { ...registration.calendar, sourceHash: testHash(calendarFixture(registration)) },
  })
}
