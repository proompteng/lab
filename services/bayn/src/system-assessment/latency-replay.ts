import { Result, Schema } from 'effect'
import type { Policy } from '../risk'

import { BrokerEnvironment, BrokerIdentitySchema, type BrokerIdentity } from '../broker/identity'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { canonicalHashV1Result } from '../hash'
import type { BacktestInputSchema } from '../intraday-replay/backtest'
import { nativeReplayPolicyIdentity, type NativeReplayPolicy } from '../intraday-replay/native-policy'
import {
  registeredReplayInferenceTariff,
  registeredStrategyReplayInferenceTariff,
} from '../intraday-replay/inference-costs'
import { JevResearchPolicy } from '../jev/acceptance'
import { makeRepeatedMomentumPolicy, repeatedMomentumPromptPolicy } from '../strategy/repeated-momentum/policy'
import { stagedChartQuestionPolicy } from '../jev/staged-chart-questions'
import { entryJudgmentPolicy } from '../jev/entry-questions'
import { jevPositionExitPolicy } from '../jev/exit-policy'
import { JevProtocolSchema, type JevProtocol } from '../jev/protocol'
import { approvedExecutionRiskPolicyHashes } from '../execution/risk-policy'
import { qualificationCalendar } from './calendar'
import { SystemAssessmentError } from './economics'
import { measureRegisteredDecisionLatency } from './native-decision-latency'
import { deriveAlphaBaselineSources } from './alpha-observation-witness'
import { derivePreparedAlphaBaselineSources } from './alpha-baseline-witness'
import { verifyRegisteredAlphaBaselinePreparations } from './alpha-baseline-capture'
import {
  ResearchStrategyEngine,
  researchStrategyPolicyMaterial,
  validateResearchStrategyBinding,
} from './strategy-binding'
import {
  SystemRegistrationSchema,
  isStrategyBoundSystemRegistration,
  registeredAllocationMicros,
  verifyStoredSystemRegistration,
  type SystemRegistration,
} from './policy'
import { SystemSourceCutSchema } from './source-cut'
import {
  systemLatencyStressProtocol,
  systemLatencyStressProtocolHash,
  strategyBoundSystemLatencyStressProtocol,
  strategyBoundSystemLatencyStressProtocolHash,
  preparedAlphaSystemLatencyStressProtocol,
  preparedAlphaSystemLatencyStressProtocolHash,
} from './latency-protocol'

export const SystemLatencyReplaySchema = Schema.Struct({
  registration: SystemRegistrationSchema,
  sourceCut: SystemSourceCutSchema,
  brokerIdentity: BrokerIdentitySchema,
})

type BacktestInput = typeof BacktestInputSchema.Type

export const latencyReplayExecutionModelHash = (input: Pick<BacktestInput, 'assumptions' | 'fractionalTrading'>) =>
  canonicalHashV1Result({
    schemaVersion: 'bayn.latency-replay-execution-model.v1',
    assumptions: input.assumptions,
    fractionalTrading: input.fractionalTrading,
  })

/** Material supplied by the selected compiled policy; source authenticity is verified separately. */
export const latencyReplayPolicyMaterial = (
  protocol: JevProtocol,
  accountId: string,
  policy: NativeReplayPolicy,
  riskPolicy: Policy,
) =>
  Result.gen(function* () {
    const approved = yield* approvedExecutionRiskPolicyHashes(accountId, protocol.universe)
    if (!approved.includes(yield* canonicalHashV1Result(riskPolicy)))
      return yield* Result.fail(
        new SystemAssessmentError({
          message: 'Replay risk material is not approved for its bound account and universe',
        }),
      )
    const { plans: _plans, ...positionProtection } = jevPositionExitPolicy(protocol, {})
    return {
      riskPolicy,
      prompts:
        policy === JevResearchPolicy.Momentum
          ? repeatedMomentumPromptPolicy
          : policy === JevResearchPolicy.Ablation
            ? stagedChartQuestionPolicy
            : { chart: stagedChartQuestionPolicy, jev: entryJudgmentPolicy },
      continuationAndExits: {
        schemaVersion: 'bayn.native-continuation-policy.v1',
        protocol,
        positionProtection,
        ...(policy === JevResearchPolicy.Momentum ? { momentum: makeRepeatedMomentumPolicy(protocol) } : {}),
      },
    }
  })

export const bindLatencyReplayInput = (
  input: BacktestInput,
  registration: SystemRegistration,
  brokerIdentity: BrokerIdentity,
) =>
  Result.gen(function* () {
    const fail = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    if (isStrategyBoundSystemRegistration(registration))
      return yield* bindStrategyLatencyReplayInput(input, registration, brokerIdentity)
    if (input.schemaVersion !== 'bayn.backtest.v11')
      return yield* fail('Retained registration requires its original replay input version')
    if (registration.obligations.configuration.schemaVersion !== 'bayn.qualification-runtime.v1')
      return yield* fail('Polling latency replay cannot establish a streaming runtime registration')
    const definition = registration.policies.find((p) => p.policy === input.policy)
    const first = registration.calendar.sessions[0]
    const last = registration.calendar.sessions.at(-1)
    const configuration = {
      ...registration.obligations.configuration,
      protocol: yield* Schema.decodeUnknownResult(JevProtocolSchema)(
        registration.obligations.configuration.protocol,
      ).pipe(
        Result.mapError(
          (cause) =>
            new SystemAssessmentError({ message: 'New replay execution requires the current protocol', cause }),
        ),
      ),
    }
    if (definition === undefined || first === undefined || last === undefined)
      return yield* fail('Latency replay requires the registered policy and complete calendar')
    const material = yield* latencyReplayPolicyMaterial(
      configuration.protocol,
      definition.riskPolicy.accountId,
      input.policy,
      definition.riskPolicy,
    )
    const identity = yield* nativeReplayPolicyIdentity(input.policy, configuration.protocol)
    const tariff = yield* registeredReplayInferenceTariff(
      definition.inferenceRateCard,
      input.interval,
      input.policy,
      configuration.protocol,
    )
    if (
      brokerIdentity.environment !== BrokerEnvironment.Sandbox ||
      registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)?.accountBindingHash !==
        (yield* canonicalHashV1Result({
          schemaVersion: 'bayn.inference-cost-account.v1',
          accountId: brokerIdentity.accountId,
        })) ||
      definition.accountBindingHash !==
        (yield* canonicalHashV1Result({
          schemaVersion: 'bayn.inference-cost-account.v1',
          accountId: definition.riskPolicy.accountId,
        })) ||
      definition.riskPolicyHash !== (yield* canonicalHashV1Result(material.riskPolicy)) ||
      (yield* canonicalHashV1Result(input.inference.costs)) !== (yield* canonicalHashV1Result(tariff)) ||
      definition.promptsHash !== (yield* canonicalHashV1Result(material.prompts)) ||
      definition.continuationAndExitsHash !== (yield* canonicalHashV1Result(material.continuationAndExits))
    )
      return yield* fail(
        'Latency replay differs from the registered account, risk, tariff, prompts or continuation policy',
      )
    if (
      input.inference.mode !== 'retained-responses' ||
      input.build.sourceRevision !== definition.sourceRevision ||
      input.build.imageDigest !== `sha256:${definition.imageDigest}` ||
      input.build.strategyBehaviorHash !== definition.strategyHash ||
      input.build.strategyParameterHash !== definition.parametersHash ||
      identity.protocolHash !== definition.protocolHash ||
      definition.strategyHash !== identity.strategy.behaviorHash ||
      definition.parametersHash !== identity.strategy.parameterHash ||
      definition.executionModelHash !== (yield* canonicalHashV1Result(configuration.protocol.executionModel)) ||
      input.openingCashMicros !== registeredAllocationMicros(registration) ||
      input.assetObservationPolicy !== 'retained-as-of-session' ||
      input.interval.startAt !== first.openAt ||
      input.interval.endAt !== last.closeAt
    )
      return yield* fail('Latency replay differs from the registered policy, allocation or interval')
    if (
      input.cadence.pollIntervalMs !== configuration.cyclePollIntervalMs ||
      input.cadence.reconciliationIntervalMs !== configuration.reconciliationIntervalMs ||
      input.cadence.reconciliationPassTimeoutMs !== configuration.operationTimeoutMs ||
      input.cadence.reconciliationStaleThresholdMs !== configuration.reconciliationStaleThresholdMs ||
      (yield* latencyReplayExecutionModelHash(input)) !== registration.latencyReplayExecutionModelHash
    )
      return yield* fail('Latency replay changed registered execution assumptions or operational cadence')
    const profiles = configuration.protocol.marketProfiles
    if (
      input.source.marketSources.length !== profiles.length ||
      profiles.some(
        (profile) =>
          !input.source.marketSources.some(
            (source) =>
              source.universeId === profile.universeId && source.universeSymbolHash === profile.universeSymbolHash,
          ),
      )
    )
      return yield* fail('Registered latency replay must retain every market used by the native policy')
    const calendar = yield* normalizeMarketCalendarResult(
      input.calendar.filter((day) => day.date >= first.sessionDate && day.date <= last.sessionDate),
      { start: first.sessionDate, end: last.sessionDate },
    )
    const { sessions, sourceHash } = yield* qualificationCalendar(calendar, registration.calendar.operatingHours)
    if (
      sourceHash !== registration.calendar.sourceHash ||
      (yield* canonicalHashV1Result(sessions)) !== (yield* canonicalHashV1Result(registration.calendar.sessions))
    )
      return yield* fail('Latency replay calendar omits, substitutes or changes registered sessions')
    return sessions.map((s) => ({ date: s.sessionDate, openAt: s.openAt, closeAt: s.closeAt }))
  })

export const prepareSystemLatencyReplay = (input: typeof SystemLatencyReplaySchema.Type) =>
  Result.gen(function* () {
    const { registration } = yield* verifyStoredSystemRegistration(input.registration)
    const preparedAlpha = registration.schemaVersion === 'bayn.system-registration.v7'
    const strategyBound = isStrategyBoundSystemRegistration(registration)
    const protocolHash = yield* preparedAlpha
      ? preparedAlphaSystemLatencyStressProtocolHash()
      : strategyBound
        ? strategyBoundSystemLatencyStressProtocolHash()
        : systemLatencyStressProtocolHash()
    const expectedSourceCutVersion = preparedAlpha
      ? 'bayn.system-source-cut.v6'
      : strategyBound
        ? 'bayn.system-source-cut.v5'
        : 'bayn.system-source-cut.v4'
    if (
      registration.latencyStressProtocolHash !== protocolHash ||
      input.sourceCut.schemaVersion !== expectedSourceCutVersion ||
      (yield* canonicalHashV1Result(input.sourceCut.sourceMaterial)) !== input.sourceCut.sourceMaterialHash
    )
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Latency replay protocol or source material differs' }),
      )
    const calibration = yield* measureRegisteredDecisionLatency(registration, input.sourceCut, input.brokerIdentity)
    if (calibration.status !== 'MEASURED' || calibration.p95FullBatchMs === null)
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Latency replay requires complete registered calibration' }),
      )
    return {
      registration,
      brokerIdentity: input.brokerIdentity,
      protocol: preparedAlpha
        ? preparedAlphaSystemLatencyStressProtocol
        : strategyBound
          ? strategyBoundSystemLatencyStressProtocol
          : systemLatencyStressProtocol,
      protocolHash,
      calibration,
      p95FullBatchMs: calibration.p95FullBatchMs,
    }
  })

const bindStrategyLatencyReplayInput = (
  input: BacktestInput,
  registration: Extract<
    SystemRegistration,
    { schemaVersion: 'bayn.system-registration.v6' | 'bayn.system-registration.v7' }
  >,
  brokerIdentity: BrokerIdentity,
) =>
  Result.gen(function* () {
    const fail = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    const preparedAlpha = registration.schemaVersion === 'bayn.system-registration.v7'
    if (
      (input.schemaVersion !== 'bayn.backtest.v12' && input.schemaVersion !== 'bayn.backtest.v13') ||
      (input.schemaVersion === 'bayn.backtest.v13') !== preparedAlpha ||
      input.latencyStress === null
    )
      return yield* fail('Engine-bound streaming registration requires its exact versioned replay input and source cut')
    if (
      (yield* canonicalHashV1Result(input.latencyStress.registration)) !==
        (yield* canonicalHashV1Result(registration)) ||
      input.latencyStress.sourceCut.schemaVersion !==
        (preparedAlpha ? 'bayn.system-source-cut.v6' : 'bayn.system-source-cut.v5') ||
      input.latencyStress.sourceCut.registrationHash !== (yield* canonicalHashV1Result(registration)) ||
      input.latencyStress.sourceCut.runtimeConfigurationHash !== registration.obligations.runtimeConfigurationHash ||
      (yield* canonicalHashV1Result(input.latencyStress.brokerIdentity)) !==
        (yield* canonicalHashV1Result(brokerIdentity))
    )
      return yield* fail(
        'Streaming replay source cut belongs to a different registration, runtime or controller account',
      )
    const definition = registration.policies.find((policy) => policy.policy === input.policy)
    const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    const first = registration.calendar.sessions[0]
    const last = registration.calendar.sessions.at(-1)
    const configuration = registration.obligations.configuration
    if (definition === undefined || candidate === undefined || first === undefined || last === undefined)
      return yield* fail('Streaming latency replay requires its registered role and complete calendar')
    const binding = yield* validateResearchStrategyBinding(input.strategyBinding)
    if (binding.engine === ResearchStrategyEngine.FrozenDeployed)
      return yield* fail('Frozen control requires its independently retained original replay path')
    const material = researchStrategyPolicyMaterial(binding)
    const protocol =
      binding.engine === ResearchStrategyEngine.Jev ? binding.parameters : binding.parameters.sharedProtocol
    const tariff = yield* registeredStrategyReplayInferenceTariff(definition.inferenceRateCard, input.interval, binding)
    const approved = yield* approvedExecutionRiskPolicyHashes(definition.riskPolicy.accountId, protocol.universe)
    if (
      configuration.schemaVersion !== 'bayn.qualification-runtime.v3' ||
      (yield* canonicalHashV1Result(binding)) !== (yield* canonicalHashV1Result(definition.strategyBinding)) ||
      (yield* canonicalHashV1Result(protocol)) !== (yield* canonicalHashV1Result(configuration.protocol)) ||
      brokerIdentity.environment !== BrokerEnvironment.Sandbox ||
      candidate.accountBindingHash !==
        (yield* canonicalHashV1Result({
          schemaVersion: 'bayn.inference-cost-account.v1',
          accountId: brokerIdentity.accountId,
        })) ||
      definition.accountBindingHash !==
        (yield* canonicalHashV1Result({
          schemaVersion: 'bayn.inference-cost-account.v1',
          accountId: definition.riskPolicy.accountId,
        })) ||
      definition.riskPolicyHash !== (yield* canonicalHashV1Result(definition.riskPolicy)) ||
      !approved.includes(definition.riskPolicyHash) ||
      definition.promptsHash !== (yield* canonicalHashV1Result(material.prompts)) ||
      definition.continuationAndExitsHash !== (yield* canonicalHashV1Result(material.continuationAndExits)) ||
      definition.executionModelHash !== (yield* canonicalHashV1Result(material.executionModel)) ||
      (yield* canonicalHashV1Result(input.inference.costs)) !== (yield* canonicalHashV1Result(tariff))
    )
      return yield* fail('Streaming replay differs from its complete engine, account, risk, tariff, prompts or exits')
    if (
      input.inference.mode !== 'retained-responses' ||
      input.build.sourceRevision !== definition.sourceRevision ||
      input.build.imageDigest !== `sha256:${definition.imageDigest}` ||
      input.build.strategyBehaviorHash !== definition.strategyHash ||
      input.build.strategyParameterHash !== definition.parametersHash ||
      binding.protocolHash !== definition.protocolHash ||
      input.openingCashMicros !== registeredAllocationMicros(registration) ||
      input.assetObservationPolicy !== 'retained-as-of-session' ||
      input.interval.startAt !== first.openAt ||
      input.interval.endAt !== last.closeAt ||
      input.source.transport !== 'original-capture' ||
      input.source.deliveryModel.schemaVersion !== 'bayn.original-capture-arrivals.v1'
    )
      return yield* fail(
        'Streaming replay requires exact registered build, allocation, interval and original arrival evidence',
      )
    if (
      input.cadence.reconciliationIntervalMs !== configuration.reconciliationIntervalMs ||
      input.cadence.reconciliationPassTimeoutMs !== configuration.operationTimeoutMs ||
      input.cadence.reconciliationStaleThresholdMs !== configuration.reconciliationStaleThresholdMs ||
      (yield* latencyReplayExecutionModelHash(input)) !== registration.latencyReplayExecutionModelHash
    )
      return yield* fail('Streaming replay changed registered execution assumptions or reconciliation cadence')
    const profiles = configuration.protocol.marketProfiles
    if (
      input.source.marketSources.length !== profiles.length ||
      profiles.some(
        (profile) =>
          !input.source.marketSources.some(
            (source) =>
              source.universeId === profile.universeId && source.universeSymbolHash === profile.universeSymbolHash,
          ),
      )
    )
      return yield* fail('Streaming replay must retain every registered native market source')
    const normalized = yield* normalizeMarketCalendarResult(
      input.calendar.filter((day) => day.date >= first.sessionDate && day.date <= last.sessionDate),
      { start: first.sessionDate, end: last.sessionDate },
    )
    const { sessions, sourceHash } = yield* qualificationCalendar(normalized, registration.calendar.operatingHours)
    if (
      sourceHash !== registration.calendar.sourceHash ||
      (yield* canonicalHashV1Result(normalized)) !==
        (yield* canonicalHashV1Result(registration.calendar.marketCalendar)) ||
      (yield* canonicalHashV1Result(sessions)) !== (yield* canonicalHashV1Result(registration.calendar.sessions))
    )
      return yield* fail('Streaming replay calendar differs from its complete registered native calendar')
    if (input.schemaVersion === 'bayn.backtest.v13') {
      const cut = input.latencyStress.sourceCut
      if (cut.schemaVersion !== 'bayn.system-source-cut.v6')
        return yield* fail('Prepared alpha replay requires its complete preparation source cut')
      const retained = yield* verifyRegisteredAlphaBaselinePreparations(
        registration,
        cut.alphaBaselinePreparations,
        cut.asOf,
      )
      const witnessed = yield* derivePreparedAlphaBaselineSources({ ...cut, alphaBaselinePreparations: retained })
      // These remain candidate-owned market inputs. Each role keeps its own account, portfolio, authority and build.
      const sources = binding.engine === ResearchStrategyEngine.IntradayAlpha ? witnessed : []
      if (
        (yield* canonicalHashV1Result(input.alphaBaselinePreparations)) !== (yield* canonicalHashV1Result(sources)) ||
        (binding.engine === ResearchStrategyEngine.IntradayAlpha &&
          sources.some((source) => {
            const policyHash = canonicalHashV1Result(source.payload.policy)
            return Result.isFailure(policyHash) || policyHash.success !== binding.strategy.parameterHash
          }))
      )
        return yield* fail(
          'Prepared alpha replay differs from the exact candidate-owned policy, build and committed source',
        )
    } else {
      const sources =
        binding.engine === ResearchStrategyEngine.IntradayAlpha
          ? yield* deriveAlphaBaselineSources(input.latencyStress.sourceCut)
          : []
      if ((yield* canonicalHashV1Result(input.alphaBaselineSources)) !== (yield* canonicalHashV1Result(sources)))
        return yield* fail('Alpha replay baselines differ from independently witnessed registered source evidence')
    }
    return sessions.map((session) => ({ date: session.sessionDate, openAt: session.openAt, closeAt: session.closeAt }))
  })
