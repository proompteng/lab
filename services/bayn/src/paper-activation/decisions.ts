import { Result } from 'effect'

import type { ApplicationPlanFor } from '../app'
import type { ReadPreflight } from '../broker/alpaca'
import { BrokerEnvironment } from '../broker/identity'
import type { LoadedRuntimeConfig } from '../config'
import type { ExecutionCandidateDiscoveryReceipt } from '../execution-candidate-discovery'
import { noCapitalAuthority } from '../execution/authority'
import { BrokerAccess, type CapitalAuthorityKind } from '../execution/authority'
import {
  decodePaperActivationConfigurationResult,
  isResearchPaperActivationRequest,
  isResearchPaperBuildContinuation,
  type ExecutionPolicy,
  type PaperActivationRequest,
  type PaperActivationRevisionBinding,
  type QualifiedPaperActivationRequest,
  type ResearchPaperActivationRequest,
  type ResearchPaperBuildContinuation,
} from '../execution/configuration'
import { Authority, KillState, type AuthorityState, type CapitalGrantGeneration } from '../execution/contracts'
import type { ExecutionPrepareOutput, ExecutionPrepareRequest } from '../execution-prepare'
import { paperEpisodeCloseExpiresAt, paperEpisodeReceiptFinalizationExpiresAt } from '../paper-episode'
import type { RuntimeEvidence } from '../runtime-state'

export type ReadOnlyExecutionPolicy = Extract<ExecutionPolicy, { readonly brokerAccess: BrokerAccess.ReadOnly }>

export interface ConfiguredPaperActivation {
  readonly request: PaperActivationRequest
  readonly buildContinuation: ResearchPaperBuildContinuation | null
}

export interface PaperActivationStrategyFacts {
  readonly name: string
  readonly behaviorHash: string
  readonly parameterHash: string
  readonly parameterSchemaVersion: string
}

export interface PaperActivationBrokerFacts {
  readonly expectedAccountId: string
  readonly identityHash: string
}

export interface PaperActivationRuntimeFacts {
  readonly sourceAuthorityGenerationHash: string
  readonly build: PaperActivationRevisionBinding
  readonly strategy: PaperActivationStrategyFacts
  readonly strategyProtocolHash: string
  readonly broker: PaperActivationBrokerFacts
  readonly evidence: RuntimeEvidence | null
}

export interface CurrentPaperActivation<Request extends PaperActivationRequest = PaperActivationRequest> {
  readonly request: Request
  readonly observedAt: string
}

export interface BoundQualifiedPaperGeneration {
  readonly request: QualifiedPaperActivationRequest
  readonly generation: CapitalGrantGeneration
}

export interface PreparedQualifiedPaperActivation {
  readonly request: QualifiedPaperActivationRequest
  readonly generation: CapitalGrantGeneration
  readonly prepared: ExecutionPrepareOutput
}

export interface ResearchPaperPreflight {
  readonly request: ResearchPaperActivationRequest
  readonly preflight: ReadPreflight
}

export interface ActivatedResearchPaperAuthority {
  readonly authority: AuthorityState
}

export const readOnlyExecutionPolicy = (plan: ApplicationPlanFor<'AutonomousService'>): ReadOnlyExecutionPolicy => ({
  brokerIdentity: plan.config.alpaca.identity,
  brokerAccess: BrokerAccess.ReadOnly,
  capitalAuthority: noCapitalAuthority,
})

export const paperActivationRuntimeFacts = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  evidence: RuntimeEvidence | null,
): PaperActivationRuntimeFacts => ({
  sourceAuthorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
  build: plan.config.build,
  strategy: plan.strategy.provenance.strategy,
  strategyProtocolHash: plan.strategyProtocolHash,
  broker: {
    expectedAccountId: plan.config.alpaca.expectedAccountId,
    identityHash: plan.config.alpaca.identity.identityHash,
  },
  evidence,
})

export const parseConfiguredPaperActivation = (
  serialized: string,
): Result.Result<ConfiguredPaperActivation, string> => {
  let value: unknown
  try {
    value = JSON.parse(serialized) as unknown
  } catch {
    return Result.fail('configured PAPER activation is not valid JSON')
  }
  const decoded = decodePaperActivationConfigurationResult(value)
  return Result.isFailure(decoded)
    ? Result.fail('configured PAPER activation failed its canonical schema and hash validation')
    : isResearchPaperBuildContinuation(decoded.success)
      ? Result.succeed({ request: decoded.success.request, buildContinuation: decoded.success })
      : Result.succeed({ request: decoded.success, buildContinuation: null })
}

export const parseCurrentPaperActivation = <Request extends PaperActivationRequest>(input: {
  readonly request: Request
  readonly facts: PaperActivationRuntimeFacts
  readonly observedAt: string
  readonly allowCloseRecovery?: boolean
  readonly buildContinuation?: ResearchPaperBuildContinuation | null
}): Result.Result<CurrentPaperActivation<Request>, string> => {
  const { request, facts, observedAt } = input
  if (input.allowCloseRecovery !== true && (request.expiresAt <= observedAt || request.cutoffAt <= observedAt)) {
    return Result.fail('paper activation request is expired or past its immutable cutoff')
  }
  if (request.strategy.protocolHash !== facts.strategyProtocolHash) {
    return Result.fail('paper activation request strategy protocol does not match the current strategy')
  }
  if (
    request.strategy.name !== facts.strategy.name ||
    request.strategy.behaviorHash !== facts.strategy.behaviorHash ||
    request.strategy.parameterHash !== facts.strategy.parameterHash ||
    request.strategy.parameterSchemaVersion !== facts.strategy.parameterSchemaVersion
  ) {
    return Result.fail('paper activation request strategy identity does not match the current strategy')
  }
  const requestBuildIsCurrent =
    request.activation.sourceRevision === facts.build.sourceRevision &&
    request.activation.imageRepository === facts.build.imageRepository &&
    request.activation.imageDigest === facts.build.imageDigest
  const continuation = input.buildContinuation
  const continuationBuildIsCurrent =
    isResearchPaperActivationRequest(request) &&
    continuation !== null &&
    continuation !== undefined &&
    continuation.request.requestHash === request.requestHash &&
    continuation.activation.sourceRevision === facts.build.sourceRevision &&
    continuation.activation.imageRepository === facts.build.imageRepository &&
    continuation.activation.imageDigest === facts.build.imageDigest
  if (!requestBuildIsCurrent && !continuationBuildIsCurrent) {
    return Result.fail('paper activation request is not bound to the current activation build')
  }
  if (isResearchPaperActivationRequest(request)) {
    if (
      request.broker.environment !== BrokerEnvironment.Sandbox ||
      request.broker.accountId !== facts.broker.expectedAccountId ||
      request.broker.identityHash !== facts.broker.identityHash
    ) {
      return Result.fail('research PAPER request broker identity does not match the configured sandbox account')
    }
    return Result.succeed({ request, observedAt })
  }
  const evidence = facts.evidence
  if (evidence === null) return Result.fail('pinned qualification evidence was not published by startup')
  if (
    evidence.evaluation.runId !== request.qualification.runId ||
    evidence.qualification.runId !== request.qualification.runId ||
    evidence.qualification.lockId !== request.qualification.lockId ||
    evidence.qualification.resultHash !== request.qualification.resultHash
  ) {
    return Result.fail('paper activation request does not match the recovered qualification result')
  }
  if (evidence.qualification.verdict !== 'QUALIFIED' || evidence.qualification.evaluationVerdict.status !== 'PASS') {
    return Result.fail('paper activation request requires a qualified economic result')
  }
  if (
    evidence.provenance.sourceRevision !== request.qualification.sourceRevision ||
    evidence.provenance.image.repository !== request.qualification.imageRepository ||
    evidence.provenance.image.digest !== request.qualification.imageDigest
  ) {
    return Result.fail('paper activation request does not match the durable qualification provenance')
  }
  return Result.succeed({ request, observedAt })
}

export const buildPaperActivationPrepareRequest = (input: {
  readonly current: CurrentPaperActivation<QualifiedPaperActivationRequest>
  readonly evidence: RuntimeEvidence
  readonly discoveryReceipt: ExecutionCandidateDiscoveryReceipt
}): Result.Result<ExecutionPrepareRequest, string> => {
  const { current, evidence, discoveryReceipt } = input
  if (evidence.qualification.analysis.candidateOrdinal < 0) {
    return Result.fail('recovered qualification candidate ordinal is invalid')
  }
  return Result.succeed({
    schemaVersion: 'bayn.execution-prepare-request.v1',
    qualification: {
      runId: current.request.qualification.runId,
      lockId: current.request.qualification.lockId,
      resultHash: current.request.qualification.resultHash,
      verdict: 'QUALIFIED',
      sourceRevision: current.request.qualification.sourceRevision,
      imageRepository: current.request.qualification.imageRepository,
      imageDigest: current.request.qualification.imageDigest,
      candidateOrdinal: evidence.qualification.analysis.candidateOrdinal,
    },
    discoveryReceipt,
  })
}

export const bindQualifiedPaperGeneration = (input: {
  readonly request: QualifiedPaperActivationRequest
  readonly facts: Pick<
    PaperActivationRuntimeFacts,
    'sourceAuthorityGenerationHash' | 'build' | 'strategy' | 'strategyProtocolHash'
  >
  readonly generation: CapitalGrantGeneration
}): Result.Result<BoundQualifiedPaperGeneration, string> => {
  const { request, facts, generation } = input
  if (generation.maximum !== 'PAPER') return Result.fail('execution PREPARE did not return PAPER generation')
  if (generation.previousGenerationHash !== facts.sourceAuthorityGenerationHash) {
    return Result.fail('execution PREPARE did not chain from the configured OBSERVE generation')
  }
  if (
    generation.qualificationRunId !== request.qualification.runId ||
    generation.qualificationLockId !== request.qualification.lockId ||
    generation.qualificationResultHash !== request.qualification.resultHash ||
    generation.qualificationSourceRevision !== request.qualification.sourceRevision ||
    generation.qualificationImageRepository !== request.qualification.imageRepository ||
    generation.qualificationImageDigest !== request.qualification.imageDigest
  ) {
    return Result.fail('prepared generation is not bound to the requested qualification')
  }
  if (
    generation.activationSourceRevision !== facts.build.sourceRevision ||
    generation.activationImageRepository !== facts.build.imageRepository ||
    generation.activationImageDigest !== facts.build.imageDigest ||
    generation.strategyName !== facts.strategy.name ||
    generation.strategyBehaviorHash !== facts.strategy.behaviorHash ||
    generation.strategyParameterHash !== facts.strategy.parameterHash ||
    generation.strategyParameterSchemaVersion !== facts.strategy.parameterSchemaVersion ||
    generation.protocolHash !== facts.strategyProtocolHash
  ) {
    return Result.fail('prepared generation is not bound to the requested current strategy and build')
  }
  return Result.succeed({ request, generation })
}

export const bindPreparedQualifiedPaperActivation = (input: {
  readonly request: QualifiedPaperActivationRequest
  readonly facts: PaperActivationRuntimeFacts
  readonly prepared: ExecutionPrepareOutput
}): Result.Result<PreparedQualifiedPaperActivation, string> => {
  const { request, facts, prepared } = input
  const bound = bindQualifiedPaperGeneration({ request, facts, generation: prepared.generation })
  if (Result.isFailure(bound)) return Result.fail(bound.failure)
  const { preflight } = prepared
  if (preflight.environment !== BrokerEnvironment.Sandbox) return Result.fail('paper PREPARE broker is not sandbox')
  if (preflight.accountId !== facts.broker.expectedAccountId) {
    return Result.fail('paper PREPARE broker account does not match the configured account')
  }
  if (
    preflight.openOrderCount !== request.limits.maxOpenOrders ||
    preflight.positionCount !== request.limits.maxPositions
  ) {
    return Result.fail('paper PREPARE broker preflight is not an empty order book and position set')
  }
  return Result.succeed({ request, generation: bound.success.generation, prepared })
}

export const parseResearchPaperPreflight = (input: {
  readonly request: ResearchPaperActivationRequest
  readonly preflight: ReadPreflight
}): Result.Result<ResearchPaperPreflight, string> =>
  input.preflight.environment === BrokerEnvironment.Sandbox &&
  input.preflight.accountId === input.request.broker.accountId &&
  input.preflight.openOrderCount === input.request.limits.maxOpenOrders &&
  input.preflight.positionCount === input.request.limits.maxPositions
    ? Result.succeed(input)
    : Result.fail('research PAPER preflight requires the exact empty sandbox account')

export const parseActivatedResearchPaperAuthority = (
  authority: AuthorityState,
): Result.Result<ActivatedResearchPaperAuthority, string> =>
  authority.maximum === Authority.Paper && authority.effective === Authority.Paper && authority.kill === KillState.Clear
    ? Result.succeed({ authority })
    : Result.fail('research PAPER activation did not return clear effective PAPER authority')

export const closedCycleReceiptEmissionAllowed = (input: {
  readonly cutoffAt: string
  readonly observedAt: string
}): boolean => Date.parse(input.observedAt) >= Date.parse(input.cutoffAt)

export const paperReceiptFinalizationWindowOpen = (input: {
  readonly authorityExpiresAt: string
  readonly observedAt: string
}): boolean => {
  const observedMs = Date.parse(input.observedAt)
  const closeExpiresMs = Date.parse(paperEpisodeCloseExpiresAt(input.authorityExpiresAt))
  const finalizationExpiresMs = Date.parse(paperEpisodeReceiptFinalizationExpiresAt(input.authorityExpiresAt))
  return Number.isFinite(observedMs) && observedMs >= closeExpiresMs && observedMs < finalizationExpiresMs
}

export type AutonomousExecutionPrepareConfig = Extract<
  LoadedRuntimeConfig,
  { readonly runtimeMode: 'ExecutionPrepare' }
>
export type AutonomousNoCapitalAuthority = CapitalAuthorityKind.None
