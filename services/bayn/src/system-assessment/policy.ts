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

import { canonicalHashV1Result } from '../hash'
import { BrokerEnvironment } from '../broker/identity'
import { jevModel } from '../jev/contract'
import { decisionsModel } from '../jev/decisions'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'
import { PolicySchema } from '../risk'
import { InferenceRateCardSchema, prepareInferenceRateCard } from '../inference-costs'
import { MarketKind } from '../instruments'
import {
  JevAcceptanceInputSchema,
  JevResearchPolicy,
  jevAcceptanceProtocolHash,
  jevAcceptanceInferenceRateFloor,
  jevAcceptanceExecutionRiskLimits,
} from '../jev/acceptance'
import { Sha256Schema, StrictNonEmptyStringSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'
import { QualificationRuntimeSchema, qualificationDeadlines } from './configuration'
import { systemLatencyStressProtocolHash } from './latency-protocol'
import { costAttributionRule } from './cost-attribution'
import { CostAllocationPlanSchema, validateCostAllocationPlans } from './cost-allocation'

/** Last retained PAPER activation before acceptance v2 froze; see the control identity evidence in the owning contract. */
export const frozenDeployedControlIdentity = {
  strategyHash: '3da39b009a0cb2052b007ae9ba51f448c16b69281a37cf5ffe122314f1d801af',
  parametersHash: 'cd004b8b43e50dde70ba70fb43deff19c5c65d60f4455e84a2e8df9991c0335f',
  protocolHash: 'f38c7d47dc0b8eedb13da1ae7e29faa3da2ce8983fee05f4a2c89dc0ec59eb97',
} as const

export const systemQualificationPolicy = {
  schemaVersion: 'bayn.system-qualification-policy.v1',
  program: 'BAYN_SYSTEM_QUALIFICATION',
  environment: 'PAPER',
  allocationMicros: '100000000000',
  reliabilityNumerator: 999,
  reliabilityDenominator: 1000,
  maximumSafetyViolations: 0,
  operatingCostCategories: ['INFERENCE', 'DATA', 'INFRASTRUCTURE', 'RESEARCH'],
  maximumMarkGapMs: 60_000,
  inferenceQualificationRule: 'MAX_INVOICE_TARIFF',
  cashYieldIsTradingEdge: false,
  costAttributionRule,
  frozenDeployedControlIdentity,
} as const

export const PolicyDefinitionSchema = Schema.Struct({
  policy: Schema.Enum(JevResearchPolicy),
  accountBindingHash: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  riskPolicyHash: Sha256Schema,
  riskPolicy: PolicySchema,
  sourceRevision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  imageDigest: Sha256Schema,
  strategyHash: Sha256Schema,
  protocolHash: Sha256Schema,
  parametersHash: Sha256Schema,
  promptsHash: Sha256Schema,
  continuationAndExitsHash: Sha256Schema,
  costAllocationRuleHash: Sha256Schema,
  inferenceRateCard: InferenceRateCardSchema,
  executionModelHash: Sha256Schema,
})

export const SystemRegistrationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.system-registration.v2'),
  program: Schema.Literal('BAYN_SYSTEM_QUALIFICATION'),
  environment: Schema.Literal('PAPER'),
  policyHash: Sha256Schema,
  acceptanceProtocolHash: Sha256Schema,
  attemptIndex: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  priorAttemptHash: Sha256Schema,
  registeredAt: UtcInstantSchema,
  calendar: Schema.Struct({
    referenceMarket: Schema.Literal('US_EQUITIES'),
    tradingMarkets: Schema.Array(Schema.Enum(MarketKind)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(2),
      Schema.isUnique(),
    ),
    operatingHours: Schema.Literal('REGULAR_SESSION'),
    sourceHash: Sha256Schema,
    sessions: JevAcceptanceInputSchema.fields.registration.fields.sessions,
  }),
  policies: Schema.Array(PolicyDefinitionSchema).check(Schema.isMinLength(4), Schema.isMaxLength(4)),
  costAllocationPlans: Schema.Array(CostAllocationPlanSchema).check(Schema.isMaxLength(20000)),
  obligations: Schema.Struct({
    configuration: QualificationRuntimeSchema,
    decisionScheduleHash: Sha256Schema,
    reconciliationScheduleHash: Sha256Schema,
    decisionIntervalMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 86_400_000 })),
    decisionWindowMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 })),
    reconciliationIntervalMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 86_400_000 })),
    reconciliationFreshnessMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 })),
    mutationDeadlineMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 })),
    recoveryDeadlineMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 })),
    runtimeConfigurationHash: Sha256Schema,
  }),
  latencyStressProtocolHash: Sha256Schema,
  latencyReplayExecutionModelHash: Sha256Schema,
  statisticalAssumptions: Schema.Array(StrictNonEmptyStringSchema).check(Schema.isMinLength(1)),
})

export type SystemRegistration = typeof SystemRegistrationSchema.Type

export const systemQualificationPolicyHash = () =>
  Result.gen(function* () {
    return yield* canonicalHashV1Result({
      ...systemQualificationPolicy,
      acceptanceProtocolHash: yield* jevAcceptanceProtocolHash(),
    })
  })

export const validateSystemRegistration = (input: unknown) =>
  Result.gen(function* () {
    const registration = yield* Schema.decodeUnknownResult(
      SystemRegistrationSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError((cause) => new SystemAssessmentError({ message: 'System registration is malformed', cause })),
    )
    const invalid = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    if (
      registration.policyHash !== (yield* systemQualificationPolicyHash()) ||
      registration.acceptanceProtocolHash !== (yield* jevAcceptanceProtocolHash()) ||
      registration.latencyStressProtocolHash !== (yield* systemLatencyStressProtocolHash())
    )
      return yield* invalid('Registration must bind the current system policy and frozen acceptance contract')
    if (new Set(registration.policies.map((p) => p.policy)).size !== Object.values(JevResearchPolicy).length)
      return yield* invalid('Registration requires the candidate and each distinct matched control')
    if (new Set(registration.policies.map((p) => p.accountBindingHash)).size !== registration.policies.length)
      return yield* invalid('Each policy requires its own economic account scope and cost allocation')
    yield* validateCostAllocationPlans(
      registration.costAllocationPlans,
      new Set(registration.policies.map((policy) => policy.accountBindingHash)),
      new Set(registration.calendar.sessions.map((session) => session.sessionDate)),
    )
    const markets = registration.obligations.configuration.protocol.marketProfiles.map((profile) => profile.market)
    if (
      registration.calendar.tradingMarkets.length !== markets.length ||
      markets.some((market) => !registration.calendar.tradingMarkets.includes(market))
    )
      return yield* invalid('Registered trading markets must include the complete native policy')
    const ablationIdentity = yield* entryAblationStrategyIdentity(
      makeEntryAblationPolicy(registration.obligations.configuration.protocol),
    )
    const momentumIdentity = yield* repeatedMomentumStrategyIdentity(
      makeRepeatedMomentumPolicy(registration.obligations.configuration.protocol),
    )
    const tariffFloor = yield* jevAcceptanceInferenceRateFloor()
    const riskCeilings = jevAcceptanceExecutionRiskLimits()
    for (const policy of registration.policies) {
      if (
        policy.riskPolicyHash !== (yield* canonicalHashV1Result(policy.riskPolicy)) ||
        policy.accountBindingHash !==
          (yield* canonicalHashV1Result({
            schemaVersion: 'bayn.inference-cost-account.v1',
            accountId: policy.riskPolicy.accountId,
          }))
      )
        return yield* invalid('Registered risk policy must bind its exact material and economic account')
      const approvedHashes = yield* Result.all(
        [BrokerEnvironment.Live, BrokerEnvironment.Sandbox].map((environment) =>
          Result.flatMap(
            makeExecutionRiskPolicy(policy.riskPolicy.accountId, policy.riskPolicy.allowedSymbols, environment),
            canonicalHashV1Result,
          ),
        ),
      )
      if (!approvedHashes.includes(policy.riskPolicyHash))
        return yield* invalid('Registered risk limits must preserve an existing source-approved execution policy')
      for (const key of [
        'maxOrderNotionalMicros',
        'maxSymbolExposureMicros',
        'maxGrossExposureMicros',
        'maxNetExposureMicros',
        'maxDailyTradedNotionalMicros',
      ] as const)
        if (BigInt(policy.riskPolicy[key]) > riskCeilings[key])
          return yield* invalid('Registered risk limits cannot expand the frozen qualification ceilings')
      if (
        policy.policy === JevResearchPolicy.Deployed &&
        (policy.strategyHash !== frozenDeployedControlIdentity.strategyHash ||
          policy.parametersHash !== frozenDeployedControlIdentity.parametersHash ||
          policy.protocolHash !== frozenDeployedControlIdentity.protocolHash)
      )
        return yield* invalid('Deployed control must preserve the frozen pre-Jev strategy, parameters and protocol')
      if (
        policy.policy === JevResearchPolicy.Ablation &&
        (policy.strategyHash !== ablationIdentity.strategy.behaviorHash ||
          policy.parametersHash !== ablationIdentity.strategy.parameterHash ||
          policy.protocolHash !== ablationIdentity.protocolHash ||
          policy.promptsHash !== entryAblationQuestionPolicyHash ||
          policy.executionModelHash !==
            (yield* canonicalHashV1Result(registration.obligations.configuration.protocol.executionModel)))
      )
        return yield* invalid('Ablation must bind its complete source-defined policy and the candidate execution model')
      if (
        policy.policy === JevResearchPolicy.Momentum &&
        (policy.strategyHash !== momentumIdentity.strategy.behaviorHash ||
          policy.parametersHash !== momentumIdentity.strategy.parameterHash ||
          policy.protocolHash !== momentumIdentity.protocolHash ||
          policy.promptsHash !== (yield* repeatedMomentumPromptsHash()) ||
          policy.executionModelHash !==
            (yield* canonicalHashV1Result(registration.obligations.configuration.protocol.executionModel)))
      )
        return yield* invalid(
          'Momentum must bind its complete source-defined policy without providers and the candidate execution model',
        )
      if (policy.costAllocationRuleHash !== (yield* canonicalHashV1Result(costAttributionRule)))
        return yield* invalid('Registration must freeze the executable service-period cost attribution rule')
      const { rates } = yield* prepareInferenceRateCard(policy.inferenceRateCard)
      const requiredModels =
        policy.policy === JevResearchPolicy.Candidate
          ? [
              ['typesafe', jevModel],
              ['openai', decisionsModel],
            ]
          : policy.policy === JevResearchPolicy.Ablation
            ? [['openai', decisionsModel]]
            : []
      const firstSession = registration.calendar.sessions[0]
      const lastSession = registration.calendar.sessions.at(-1)
      if (firstSession === undefined || lastSession === undefined)
        return yield* invalid('Registration requires an evaluation calendar')
      for (const [provider, model] of requiredModels) {
        let coveredUntil = firstSession.openAt
        for (const { rate } of rates
          .filter(({ rate }) => rate.provider === provider && rate.model === model)
          .sort((a, b) => a.rate.effectiveFrom.localeCompare(b.rate.effectiveFrom))) {
          if (rate.effectiveFrom > coveredUntil) break
          if (rate.effectiveUntil > coveredUntil) coveredUntil = rate.effectiveUntil
        }
        if (coveredUntil <= lastSession.closeAt)
          return yield* invalid(
            `Registered ${policy.policy} tariff must continuously cover ${provider}/${model} through the final close`,
          )
      }
      for (const { rate } of rates)
        if (
          rate.provider === 'typesafe' &&
          registration.calendar.sessions.some(
            (session) => rate.effectiveFrom <= session.closeAt && rate.effectiveUntil > session.openAt,
          ) &&
          (BigInt(rate.inputMicrosPerMillionTokens) < BigInt(tariffFloor.inputMicrosPerMillionTokens) ||
            BigInt(rate.outputMicrosPerMillionTokens) < BigInt(tariffFloor.outputMicrosPerMillionTokens))
        )
          return yield* invalid('Registered Jev tariff cannot lower the frozen qualification cost floor')
    }
    const expected = yield* qualificationDeadlines(registration.obligations.configuration)
    for (const key of [
      'runtimeConfigurationHash',
      'decisionIntervalMs',
      'decisionWindowMs',
      'reconciliationIntervalMs',
      'reconciliationFreshnessMs',
      'mutationDeadlineMs',
      'recoveryDeadlineMs',
    ] as const)
      if (registration.obligations[key] !== expected[key])
        return yield* invalid('Registered deadlines must derive from the frozen runtime configuration and protocol')
    const candidate = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
    if (candidate?.parametersHash !== (yield* canonicalHashV1Result(registration.obligations.configuration.protocol)))
      return yield* invalid('Scheduled decision deadlines must use the candidate protocol')
    let previousClose = Date.parse(registration.registeredAt)
    let previousDate = ''
    for (const session of registration.calendar.sessions) {
      if (
        Date.parse(session.openAt) <= previousClose ||
        Date.parse(session.closeAt) <= Date.parse(session.openAt) ||
        session.sessionDate <= previousDate ||
        session.openAt.slice(0, 10) !== session.sessionDate ||
        session.closeAt.slice(0, 10) !== session.sessionDate
      )
        return yield* invalid('Calendar must be ordered, nonoverlapping and registered before the first open')
      previousClose = Date.parse(session.closeAt)
      previousDate = session.sessionDate
    }
    return { registration, registrationHash: yield* canonicalHashV1Result(registration) }
  })
