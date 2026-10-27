import { prepareInferenceRateCard } from '../inference-costs'
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
import { OperatingCostCategory, OperatingCostCoverage } from '../operating-costs'
import { ObligationClass, ObligationOutcome } from './reliability'
import { frozenDeployedControlIdentity, systemQualificationPolicyHash, type SystemRegistration } from './policy'
import type { SessionEvidence } from './session'
import type { SystemAssessmentInputSchema } from './assessment'
import { DecisionRealismSchema, ExecutionEvidenceKind, FillRealismSchema } from './realism'
import { OrderSide } from '../execution/contracts'
import { registeredSchedule } from './schedule'
import { CashFlowEvidenceSchema } from './cash-flows'
import { withProviderSessions } from '../testing/market-calendar-fixture'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../jev/protocol'
import { qualificationDeadlines } from './configuration'
import { systemLatencyStressProtocolHash } from './latency-protocol'
import { replayRateCardFixture } from '../testing/inference-rate-card.test-support'
import { MarketKind } from '../instruments'
import { costAttributionRule } from './cost-attribution'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'

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
    inferenceRateCard: {
      schemaVersion: 'bayn.inference-rate-card.v1',
      rates: replayRateCardFixture({
        jev: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
        chart: {
          inputMicrosPerMillionTokens: '1',
          outputMicrosPerMillionTokens: '0',
          cachedInputMicrosPerMillionTokens: '0',
          cacheWriteInputMicrosPerMillionTokens: '0',
        },
      }).rates.filter(
        (rate) =>
          policy === JevResearchPolicy.Candidate ||
          (policy === JevResearchPolicy.Ablation && rate.provider === 'openai'),
      ),
    },
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
  const finalSession = registration.calendar.sessions.at(-1)
  if (finalSession === undefined) throw new Error('Missing fixture session')
  registration = {
    ...registration,
    policies: registration.policies.map((policy) => ({
      ...policy,
      inferenceRateCard: {
        ...policy.inferenceRateCard,
        rates: policy.inferenceRateCard.rates.map((rate) => ({
          ...rate,
          effectiveFrom: registration.registeredAt,
          effectiveUntil: new Date(Date.parse(finalSession.closeAt) + 86400000).toISOString(),
        })),
      },
    })),
  }
  return withRegistrationCommitments({
    ...registration,
    calendar: { ...registration.calendar, sourceHash: testHash(calendarFixture(registration)) },
  })
}

export const assessmentFixture = (registration: SystemRegistration = registrationFixture()) => {
  const asOf = '2026-12-01T00:00:00.000Z'
  const verifiedSources = new Set<string>()
  const source = (hash: string) => {
    verifiedSources.add(hash)
    return hash
  }
  const registrationHash = source(testHash(registration))
  source(registration.calendar.sourceHash)
  source(registration.latencyStressProtocolHash)
  source(registration.latencyReplayExecutionModelHash)
  for (const plan of registration.costAllocationPlans) source(plan.basisSourceHash)
  for (const hash of [
    registration.obligations.decisionScheduleHash,
    registration.obligations.reconciliationScheduleHash,
    registration.obligations.runtimeConfigurationHash,
  ])
    source(hash)
  const policies = registration.policies.map((definition) => {
    for (const hash of [
      definition.imageDigest,
      definition.strategyHash,
      definition.protocolHash,
      definition.parametersHash,
      definition.promptsHash,
      definition.continuationAndExitsHash,
      definition.costAllocationRuleHash,
      definition.executionModelHash,
      definition.riskPolicyHash,
    ])
      source(hash)
    const net = definition.policy === JevResearchPolicy.Candidate ? 1_000_000_000n : 100_000_000n
    const cost = 15_000_000n
    const sessions: SessionEvidence[] = registration.calendar.sessions.map((calendar, i) => {
      const identity = `${definition.policy}:${calendar.sessionDate}`
      const financialHash = source(sha256(`${identity}:financial`))
      const sourceHash = source(sha256(`${identity}:costs`))
      const inferenceEvidence = {
        schemaVersion: 'bayn.inference-cost-evidence.v2',
        accountBindingHash: definition.accountBindingHash,
        sessionDate: calendar.sessionDate,
        asOf,
        requests: [],
      }
      const inferenceRateCard = definition.inferenceRateCard
      source(testHash(inferenceEvidence))
      source(Result.getOrThrow(prepareInferenceRateCard(inferenceRateCard)).rateCardHash)
      const opening = 100_000_000_000n + BigInt(i) * net
      const cashFlows = Schema.decodeUnknownSync(CashFlowEvidenceSchema)({
        schemaVersion: 'bayn.system-cash-flow-evidence.v1',
        accountBindingHash: definition.accountBindingHash,
        sessionDate: calendar.sessionDate,
        asOf,
        coverage: 'COMPLETE',
        movements: [],
      })
      source(testHash(cashFlows))
      return {
        sessionDate: calendar.sessionDate,
        definitionHash: testHash(definition),
        cashFlows,
        financial: {
          sourceHash: financialHash,
          grossRealizedPnlMicros: (net + cost + 5_000_000n).toString(),
          executionCostMicros: '5000000',
          cashSettlementRoundingMicros: '0',
          openingUnrealizedPnlMicros: '0',
          closingUnrealizedPnlMicros: '0',
          cashInventory: {
            openingEquityMicros: opening.toString(),
            closingEquityMicros: (opening + net + cost).toString(),
            netExternalFlowsMicros: '0',
            passiveCashYieldMicros: '0',
            operatingCostsPaidFromAccountMicros: '0',
          },
          openingPositionCount: 0,
          closingPositionCount: 0,
          unsettledFillCount: 0,
          uncertainMutationCount: 0,
          completedEpisodes: 10,
          filledNotionalMicros: (100_000_000_000n + net + cost + 5_000_000n).toString(),
          decisionIds: [sha256(`${identity}:decision`)],
          fillIds: Array.from({ length: 20 }, (_, leg) => sha256(`${identity}:fill:${leg}`)),
        },
        inferenceEvidence,
        inferenceRateCard,
        operatingCosts: {
          schemaVersion: 'bayn.operating-cost-evidence.v1',
          accountBindingHash: definition.accountBindingHash,
          sessionDate: calendar.sessionDate,
          asOf,
          currency: 'USD',
          trading: { netPnlAfterExecutionFeesMicros: (net + cost).toString(), sourceHash: financialHash },
          coverage: Object.values(OperatingCostCategory).map((category) => ({
            category,
            status: OperatingCostCoverage.Complete,
            sourceHash,
          })),
          consumption: [
            {
              provider: `${definition.policy}:synthetic fixture`,
              documentId: sha256(`${identity}:invoice`),
              lineId: '1',
              sourceHash,
              category: OperatingCostCategory.Research,
              serviceStartDate: calendar.sessionDate,
              serviceEndDateExclusive: Schema.decodeUnknownSync(IsoDateSchema)(
                new Date(Date.parse(calendar.sessionDate) + 86_400_000).toISOString().slice(0, 10),
              ),
              grossAmountMicros: cost.toString(),
              credits: [],
              allocations: [
                {
                  accountBindingHash: definition.accountBindingHash,
                  sessionDate: calendar.sessionDate,
                  amountMicros: cost.toString(),
                  sourceHash,
                },
              ],
              unallocatedMicros: '0',
            },
          ],
          prepaidFunding: [],
        },
        marks: [
          {
            at: calendar.openAt,
            sourceHash: source(sha256(`${identity}:opening`)),
            cashFlowAdjustedTradingEquityMicros: opening.toString(),
          },
          {
            at: new Date(Date.parse(calendar.openAt) + 60_000).toISOString(),
            sourceHash: source(sha256(`${identity}:minute`)),
            cashFlowAdjustedTradingEquityMicros: (opening + net + cost).toString(),
          },
          {
            at: calendar.closeAt,
            sourceHash: source(sha256(`${identity}:closing`)),
            cashFlowAdjustedTradingEquityMicros: (opening + net + cost).toString(),
          },
        ],
        p95LatencyStress: {
          protocolHash: registration.latencyStressProtocolHash,
          sourceHash: source(sha256(`${identity}:latency`)),
          qualificationPnlMicros: net.toString(),
          executionReceiptHash: source(testHash(`${identity}:execution-receipt`)),
          image: {
            schemaVersion: 'bayn.replay-image-membership.v1',
            repository: 'registry.example.com/bayn',
            imageDigest: `sha256:${definition.imageDigest}`,
            platform: ReplayImagePlatform.Amd64,
            manifestDigest: `sha256:${definition.imageDigest}`,
            configDigest: `sha256:${testHash('config')}`,
            sourceRevision: definition.sourceRevision,
            executableSha256: testHash('executable'),
            dependencyReceiptSha256: testHash('dependencies'),
            policyDefinitionHash: testHash(definition),
            assurance: 'REGISTERED_IMAGE_MEMBERSHIP',
            runnerAuthentication: 'NOT_ESTABLISHED_BY_IMAGE_MEMBERSHIP',
          },
        },
      }
    })
    return { policy: definition.policy, sessions }
  })
  const schedule = [
    ...Result.getOrThrow(registeredSchedule(registration)),
    ...[ObligationClass.Mutation, ObligationClass.Recovery].map((kind) => ({
      obligationId: sha256(kind),
      class: kind,
      dueAt: '2026-11-02T14:30:00.000Z',
      deadlineAt: '2026-11-02T14:30:30.000Z',
      scheduleEvidenceHash: source(sha256(`${kind}:schedule`)),
    })),
  ]
  const input: typeof SystemAssessmentInputSchema.Type = {
    schemaVersion: 'bayn.system-assessment-input.v1',
    registration,
    asOf,
    registrationReceiptHash: registrationHash,
    sourceCutHash: source(sha256('synthetic captured source cut')),
    calendarEvidence: calendarFixture(registration),
    entryTimingSources: [],
    latencyStressSources: [],
    policies,
    reliability: {
      asOf,
      schedule,
      completions: schedule.map((o) => ({
        obligationId: o.obligationId,
        outcome: ObligationOutcome.Correct,
        completedAt: o.deadlineAt,
        evidenceHash: source(sha256(`${o.class}:completion`)),
      })),
    },
    obligationCoverageHash: source(sha256('complete obligation audit')),
    realism: { expectedDecisionIds: [], expectedFillIds: [], decisions: [], fills: [], unsupportedAssumptions: [] },
    safety: {
      coverage: 'COMPLETE',
      sourceHash: source(sha256('safety audit')),
      registrationHash,
      asOf,
      violations: [],
    },
  }
  return { input, verifiedSources, source }
}

export const supportedAssessmentFixture = () => {
  const fixture = assessmentFixture()
  const decisions: (typeof DecisionRealismSchema.Type)[] = []
  const fills: (typeof FillRealismSchema.Type)[] = []
  for (const policy of fixture.input.policies) {
    const definition = fixture.input.registration.policies.find((p) => p.policy === policy.policy)
    if (definition === undefined) throw new Error('Missing fixture definition')
    for (const session of policy.sessions) {
      const financial = session.financial
      const decisionId = financial?.decisionIds[0]
      const calendar = fixture.input.registration.calendar.sessions.find((s) => s.sessionDate === session.sessionDate)
      if (financial === null || decisionId === undefined || calendar === undefined)
        throw new Error('Missing fixture evidence')
      decisions.push({
        decisionId,
        policyDefinitionHash: session.definitionHash,
        authorityGenerationHash: definition.authorityGenerationHash,
        decisionAt: calendar.openAt,
        persistedAt: calendar.openAt,
        snapshotHash: fixture.source(sha256(`${decisionId}:snapshot`)),
        inputs: [{ contentHash: fixture.source(sha256(`${decisionId}:input`)), availableAt: calendar.openAt }],
      })
      for (const [i, fillId] of financial.fillIds.entries()) {
        const price = 5_000_000_000n + (i % 2 === 0 ? 0n : BigInt(financial.grossRealizedPnlMicros) / 10n)
        const routingStartedAt = new Date(Date.parse(calendar.openAt) + (i + 1) * 1000).toISOString()
        fills.push({
          fillId,
          intentId: sha256(`${fillId}:intent`),
          orderId: sha256(`${fillId}:order`),
          decisionId,
          positionOwnerGenerationHash: definition.authorityGenerationHash,
          kind: ExecutionEvidenceKind.Broker,
          sourceHash: fixture.source(sha256(`${fillId}:receipt`)),
          side: i % 2 === 0 ? OrderSide.Buy : OrderSide.Sell,
          requestedQuantityAtoms: '1000000000',
          cumulativeFilledQuantityAtoms: '1000000000',
          fillQuantityAtoms: '1000000000',
          quantityStepAtoms: '1',
          fillPriceAtoms: (price * 1000n).toString(),
          priceTickAtoms: '10000000',
          limitPriceAtoms: (price * 1000n).toString(),
          pricing: {
            _tag: 'SpotQuote',
            bidPriceAtoms: (price * 1000n).toString(),
            askPriceAtoms: (price * 1000n).toString(),
            sourceHash: fixture.source(sha256(`${fillId}:quote`)),
            availableAt: routingStartedAt,
            freshUntil: calendar.closeAt,
          },
          supportedCapacityAtoms: null,
          capacitySourceHash: null,
          routingStartedAt,
          requestDispatchedAt: routingStartedAt,
          submissionDeadlineAt: calendar.closeAt,
          filledAt: new Date(Date.parse(routingStartedAt) + 10).toISOString(),
          expiresAt: calendar.closeAt,
        })
      }
    }
  }
  return {
    ...fixture,
    input: {
      ...fixture.input,
      realism: {
        expectedDecisionIds: decisions.map((d) => d.decisionId),
        expectedFillIds: fills.map((f) => f.fillId),
        decisions,
        fills,
        unsupportedAssumptions: [],
      },
    },
  }
}
import { ReplayImagePlatform } from './replay-image-platform'
