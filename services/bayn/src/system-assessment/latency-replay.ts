import { Result, Schema } from 'effect'
import type { Policy } from '../risk'

import { BrokerEnvironment, BrokerIdentitySchema, type BrokerIdentity } from '../broker/identity'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { canonicalHashV1Result } from '../hash'
import type { BacktestInputSchema } from '../intraday-replay/backtest'
import { nativeReplayPolicyIdentity, type NativeReplayPolicy } from '../intraday-replay/native-policy'
import { registeredReplayInferenceTariff } from '../intraday-replay/inference-costs'
import { JevResearchPolicy } from '../jev/acceptance'
import { makeRepeatedMomentumPolicy, repeatedMomentumPromptPolicy } from '../strategy/repeated-momentum/policy'
import { stagedChartQuestionPolicy } from '../jev/staged-chart-questions'
import { entryJudgmentPolicy } from '../jev/entry-questions'
import { jevPositionExitPolicy } from '../jev/exit-policy'
import { JevProtocolSchema, type JevProtocol } from '../jev/protocol'
import { approvedExecutionRiskPolicyHashes } from '../execution/risk-policy'
import { SystemAssessmentError } from './economics'
import { measureFullBatchLatency } from './full-batch-latency'
import {
  SystemRegistrationSchema,
  registeredAllocationMicros,
  verifyStoredSystemRegistration,
  type SystemRegistration,
} from './policy'
import { SystemSourceCutSchema } from './source-cut'
import { systemLatencyStressProtocol, systemLatencyStressProtocolHash } from './latency-protocol'

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
    const tariff = yield* registeredReplayInferenceTariff(definition.inferenceRateCard, input.interval, input.policy)
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
    const sessions = calendar.providerSessions.map((s) => ({
      sessionDate: s.date,
      openAt: s.regularOpenAt,
      closeAt: s.regularCloseAt,
    }))
    if (
      (yield* canonicalHashV1Result(calendar)) !== registration.calendar.sourceHash ||
      (yield* canonicalHashV1Result(sessions)) !== (yield* canonicalHashV1Result(registration.calendar.sessions))
    )
      return yield* fail('Latency replay calendar omits, substitutes or changes registered sessions')
    return sessions.map((s) => ({ date: s.sessionDate, openAt: s.openAt, closeAt: s.closeAt }))
  })

export const prepareSystemLatencyReplay = (input: typeof SystemLatencyReplaySchema.Type) =>
  Result.gen(function* () {
    const { registration } = yield* verifyStoredSystemRegistration(input.registration)
    const protocolHash = yield* systemLatencyStressProtocolHash()
    if (
      registration.latencyStressProtocolHash !== protocolHash ||
      (yield* canonicalHashV1Result(input.sourceCut.sourceMaterial)) !== input.sourceCut.sourceMaterialHash
    )
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Latency replay protocol or source material differs' }),
      )
    const calibration = yield* measureFullBatchLatency(registration, input.sourceCut, input.brokerIdentity)
    if (calibration.status !== 'MEASURED' || calibration.p95FullBatchMs === null)
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Latency replay requires complete registered calibration' }),
      )
    return {
      registration,
      brokerIdentity: input.brokerIdentity,
      protocol: systemLatencyStressProtocol,
      protocolHash,
      calibration,
      p95FullBatchMs: calibration.p95FullBatchMs,
    }
  })
