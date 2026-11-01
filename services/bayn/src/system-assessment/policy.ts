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
import { jevModel } from '../jev/contract'
import { decisionsModel } from '../jev/decisions'
import { approvedExecutionRiskPolicyHashes } from '../execution/risk-policy'
import { PolicySchema } from '../risk'
import { InferenceRateCardSchema, inferenceRatesCoverWindow, prepareInferenceRateCard } from '../inference-costs'
import { MarketKind } from '../instruments'
import {
  JevAcceptanceInputSchema,
  JevAcceptanceVersion,
  JevResearchPolicy,
  jevAcceptanceProtocolHash,
  jevAcceptanceInferenceRateFloor,
  jevAcceptanceExecutionRiskLimits,
} from '../jev/acceptance'
import { BootstrapPlanSchema, validateBootstrapPlan, type NumericalAssessmentTerms } from '../jev/bootstrap-plan'
import { Sha256Schema, StrictNonEmptyStringSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'
import { QualificationRuntimeSchema, qualificationDeadlines } from './configuration'
import { systemLatencyStressProtocolHash } from './latency-protocol'
import { costAttributionRule } from './cost-attribution'
import { CostAllocationPlanSchema, validateCostAllocationPlans } from './cost-allocation'
import {
  frozenDeployedControlIdentity,
  frozenControlOrigin,
  frozenControlPrompts,
  frozenControlContinuation,
} from './frozen-control-identity'

export const systemQualificationPolicy = {
  schemaVersion: 'bayn.system-qualification-policy.v3',
  evaluationWindowRule: 'PROSPECTIVE_NONEMPTY_REGISTERED_CALENDAR',
  program: 'BAYN_SYSTEM_QUALIFICATION',
  environment: 'PAPER',
  allocationRule: 'PROSPECTIVELY_REGISTERED_WITHIN_APPROVED_RISK_SCOPE',
  reliabilityNumerator: 999,
  reliabilityDenominator: 1000,
  maximumSafetyViolations: 0,
  operatingCostCategories: ['INFERENCE', 'DATA', 'INFRASTRUCTURE', 'RESEARCH'],
  markCoverageRule: 'REGISTERED_DECISION_INTERVAL',
  inferenceQualificationRule: 'ACTUAL_VERIFIED_COSTS_WITH_SEPARATE_TARIFF_STRESS',
  decisionPersistenceRule: 'COMMITTED_SOURCE_AT_INDEPENDENT_MUTATION_ADMISSION_BEFORE_ROUTING',
  executionOrderRule:
    'SEALED_ENTRY_AND_INDEPENDENT_APPROVED_PROTECTION_WITH_PER_ORDER_FILLS_AND_SHARED_ENTRY_INVENTORY',
  sourceCutVersion: 'bayn.system-source-cut.v4',
  cashYieldIsTradingEdge: false,
  costAttributionRule,
  frozenDeployedControlIdentity,
  frozenControlOrigin,
  frozenControlPrompts,
  frozenControlContinuation,
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

const registrationFields = {
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
  policies: Schema.Array(PolicyDefinitionSchema).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
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
}

const RetainedSystemRegistrationSchema = Schema.Struct({
  ...registrationFields,
  schemaVersion: Schema.Literal('bayn.system-registration.v2'),
})
const CurrentSystemRegistrationSchema = Schema.Struct({
  ...registrationFields,
  schemaVersion: Schema.Literal('bayn.system-registration.v3'),
  allocationMicros: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  bootstrap: BootstrapPlanSchema,
})
export const SystemRegistrationSchema = Schema.Union([
  CurrentSystemRegistrationSchema,
  RetainedSystemRegistrationSchema,
])

export type SystemRegistration = typeof SystemRegistrationSchema.Type

export const systemQualificationPolicyHash = (version = JevAcceptanceVersion.Current) =>
  Result.gen(function* () {
    // Exact pre-window policy identity for immutable historical evidence. New admission always uses Current.
    if (version === JevAcceptanceVersion.RetainedV3)
      return '81379af13f662669fc056164502d1e04c38e80e003f1c88f1b8a41a6552608fd'
    if (version === JevAcceptanceVersion.RetainedV2)
      return '7e465b71f52ae99a7f5a5254f04fde8b6432091f63ff51ef42bd1de02f92f90b'
    return yield* canonicalHashV1Result({
      ...systemQualificationPolicy,
      acceptanceProtocolHash: yield* jevAcceptanceProtocolHash(version),
    })
  })

export const validateSystemRegistration = (input: unknown, version = JevAcceptanceVersion.Current) =>
  Result.gen(function* () {
    const registration = yield* Schema.decodeUnknownResult(
      SystemRegistrationSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError((cause) => new SystemAssessmentError({ message: 'System registration is malformed', cause })),
    )
    const candidatePolicy = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    const legacy = version !== JevAcceptanceVersion.Current
    const invalid = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    if (
      registration.policyHash !== (yield* systemQualificationPolicyHash(version)) ||
      registration.acceptanceProtocolHash !== (yield* jevAcceptanceProtocolHash(version)) ||
      registration.latencyStressProtocolHash !== (yield* systemLatencyStressProtocolHash())
    )
      return yield* invalid('Registration must bind the current system and acceptance policies')
    if (version === JevAcceptanceVersion.RetainedV2 && registration.calendar.sessions.length !== 20)
      return yield* invalid('Retained v2 evidence must retain its original calendar length')
    if (
      (legacy && registration.schemaVersion !== 'bayn.system-registration.v2') ||
      (!legacy && registration.schemaVersion !== 'bayn.system-registration.v3')
    )
      return yield* invalid('Registration schema must match its recorded policy version')
    if (
      new Set(registration.policies.map((p) => p.policy)).size !== registration.policies.length ||
      candidatePolicy === undefined ||
      (legacy && registration.policies.length !== Object.values(JevResearchPolicy).length)
    )
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
    if (registration.schemaVersion === 'bayn.system-registration.v3') {
      const bootstrap = validateBootstrapPlan(
        registration.bootstrap,
        registration.calendar.sessions.length,
        registration.attemptIndex,
        registration.policies.length - 1,
      )
      if (Result.isFailure(bootstrap)) return yield* invalid(bootstrap.failure)
      if (
        registration.policies.some(
          (p) => BigInt(registration.allocationMicros) > BigInt(p.riskPolicy.maxGrossExposureMicros),
        )
      )
        return yield* invalid('Registered allocation exceeds an approved exposure limit')
    }
    const tariffFloor = yield* jevAcceptanceInferenceRateFloor(version)
    const riskCeilings = jevAcceptanceExecutionRiskLimits(version)
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
      const approvedHashes = yield* approvedExecutionRiskPolicyHashes(
        policy.riskPolicy.accountId,
        policy.riskPolicy.allowedSymbols,
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
        if (legacy && BigInt(policy.riskPolicy[key]) > riskCeilings[key])
          return yield* invalid('Registered risk limits cannot expand the frozen qualification ceilings')
      if (
        policy.policy === JevResearchPolicy.Deployed &&
        (policy.strategyHash !== frozenDeployedControlIdentity.strategyHash ||
          policy.parametersHash !== frozenDeployedControlIdentity.parametersHash ||
          policy.protocolHash !== frozenDeployedControlIdentity.protocolHash ||
          policy.executionModelHash !== frozenControlOrigin.executionModelHash ||
          policy.promptsHash !== (yield* canonicalHashV1Result(frozenControlPrompts)) ||
          policy.continuationAndExitsHash !== (yield* canonicalHashV1Result(frozenControlContinuation)))
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
              { provider: 'typesafe', model: jevModel },
              { provider: 'openai', model: decisionsModel },
            ]
          : policy.policy === JevResearchPolicy.Ablation
            ? [{ provider: 'openai', model: decisionsModel }]
            : []
      const firstSession = registration.calendar.sessions[0]
      const lastSession = registration.calendar.sessions.at(-1)
      if (firstSession === undefined || lastSession === undefined)
        return yield* invalid('Registration requires an evaluation calendar')
      for (const { provider, model } of requiredModels) {
        if (
          !inferenceRatesCoverWindow(
            rates.map(({ rate }) => rate),
            {
              provider,
              model,
              startAt: firstSession.openAt,
              endAt: lastSession.closeAt,
            },
          )
        )
          return yield* invalid(
            `Registered ${policy.policy} tariff must continuously cover ${provider}/${model} through the final close`,
          )
      }
      for (const { rate } of rates)
        if (
          legacy &&
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
    return { registration, registrationHash: yield* canonicalHashV1Result(registration), candidatePolicy }
  })

export const verifyStoredSystemRegistration = (input: unknown) =>
  Result.gen(function* () {
    const decoded = yield* Schema.decodeUnknownResult(
      SystemRegistrationSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError((cause) => new SystemAssessmentError({ message: 'Stored registration is malformed', cause })),
    )
    const versions = [JevAcceptanceVersion.Current, JevAcceptanceVersion.RetainedV3, JevAcceptanceVersion.RetainedV2]
    const identities = yield* Result.all(
      versions.map((version) => Result.map(jevAcceptanceProtocolHash(version), (hash) => ({ version, hash }))),
    )
    const selected = identities.find((identity) => identity.hash === decoded.acceptanceProtocolHash)
    if (selected === undefined)
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Stored registration has an unknown acceptance policy' }),
      )
    const version = selected.version
    return { ...(yield* validateSystemRegistration(decoded, version)), version }
  })

export const registeredAllocationMicros = (registration: SystemRegistration): string =>
  registration.schemaVersion === 'bayn.system-registration.v3' ? registration.allocationMicros : '100000000000'

export const registeredMarkIntervalMs = (registration: SystemRegistration): number =>
  registration.schemaVersion === 'bayn.system-registration.v3' ? registration.obligations.decisionIntervalMs : 60_000

export const registeredAssessmentTerms = (
  registration: SystemRegistration,
  riskPolicy: typeof PolicySchema.Type,
): NumericalAssessmentTerms => {
  return {
    allocationUsd: Number(BigInt(registeredAllocationMicros(registration))) / 1_000_000,
    maximumSessionLossUsd: Number(BigInt(riskPolicy.maxDailyLossMicros)) / 1_000_000,
    maximumDrawdownUsd: Number(BigInt(riskPolicy.maxDrawdownMicros)) / 1_000_000,
    maximumMarkGapMs: registeredMarkIntervalMs(registration),
    bootstrap:
      registration.schemaVersion === 'bayn.system-registration.v3'
        ? registration.bootstrap
        : { blockLengthSessions: 2, replicates: 10000, seed: 20260921 },
  }
}
