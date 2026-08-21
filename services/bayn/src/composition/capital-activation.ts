import { PgClient } from '@effect/sql-pg'
import { Effect, Option, Ref, Result } from 'effect'
import { makeApplicationPlan, type ApplicationPlan, type ApplicationPlanFor } from '../app'
import { executionObserveSuccessorGenerationHash } from '../blocked-generation-recovery'
import { type BrokerSessionShape, type ReadPreflight } from '../broker/alpaca'
import { BrokerEnvironment } from '../broker/identity'
import type { LoadedRuntimeConfig } from '../config'
import {
  AuthorityRestrictionStore,
  CapitalGrantLifecycleStore,
  type AuthorityGenerationStoreShape,
  type AuthorityRestrictionStoreShape,
  type CapitalGrantLifecycleStoreShape,
  type PreparedCapitalGrantActivation,
} from '../db/execution-store'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import {
  Authority,
  KillState,
  type AuthorityState,
  type CapitalGrantGeneration,
  type CapitalGrantProofBinding,
  type ResearchCapitalGrantGeneration,
} from '../execution/contracts'
import {
  CapitalAuthoritySelection,
  decodeCapitalActivationConfigurationResult,
  decodeResearchCapitalBuildLineageResult,
  isResearchCapitalActivationRequest,
  isResearchCapitalBuildContinuation,
  researchCapitalGrantProof,
  researchCapitalBuildLineageIsCurrent,
  researchCapitalBuildContinuationIsBound,
  researchCapitalGenerationIsBoundToBuildLineage,
  researchCapitalGenerationIsBoundToRequest,
  resolveExecutionPolicy,
  type ExecutionPolicy,
  type CapitalActivationRequest,
  type QualifiedCapitalActivationRequest,
  type ResearchCapitalActivationRequest,
  type ResearchCapitalBuildContinuation,
  type ResearchCapitalBuildLineage,
} from '../execution/configuration'
import { WriterFence, type WriterFenceService } from '../execution/writer-fence'
import { OperationalError } from '../errors'
import {
  decideExecutionMandateAuthority,
  executionActivationRestrictionSubject,
  validateExecutionMandateCloseWindow,
} from '../execution/mandate'
import { legacyAuthorityGenerationV3SchemaVersion } from '../execution/legacy-wire'
import {
  loadObserveRiskPolicy,
  executionMandateCloseExpiresAt,
  loadStrategyExecutionRiskPolicy,
} from '../observe-composition'
import { restrictMutationAuthority } from '../observe-composition/mutation-interpreter'
import { type ReconciliationPassError } from '../reconciler'
import { type ExecutionCandidateDiscoveryReceipt } from '../execution-candidate-discovery'
import {
  authenticateValidatedExecutionPrepare,
  type ExecutionPrepareRequest,
  type ExecutionPrepareOutput,
} from '../execution-prepare'
import { currentUtcInstant } from '../time'
import type { RuntimeEvidence, RuntimeState } from '../runtime-state'
import { Pipeable } from '../pipeable'
import {
  ExecutionCandidateDiscoveryResourcesLive,
  ExecutionPrepareExecutionResourcesLive,
  ExecutionPrepareValidationResourcesLive,
  QualifiedCapitalActivationStoreLive,
} from './resources'
import {
  discoverExecutionCandidate,
  executionPrepareOperationalError,
  policyHash,
  prepareExecutionPrepareOutput,
  validateExecutionPreparePlan,
} from './execution-prepare'

export type ReadOnlyExecutionPolicy = Extract<ExecutionPolicy, { readonly brokerAccess: BrokerAccess.ReadOnly }>

export const capitalActivationOperationalError = (message: string, cause?: unknown): OperationalError =>
  new OperationalError({
    component: 'strategy',
    operation: 'capital-activation',
    message,
    retryable: false,
    cause: cause === undefined ? { _tag: 'CapitalActivationPreparationRejected' } : cause,
  })

export const activatePreparedQualifiedCapitalGeneration = (
  lifecycle: Pick<CapitalGrantLifecycleStoreShape, 'activatePreparedCapitalGrant'>,
  proof: CapitalGrantProofBinding,
  prepared: PreparedCapitalGrantActivation,
): Effect.Effect<AuthorityState, OperationalError> =>
  Effect.gen(function* () {
    const activated = yield* lifecycle
      .activatePreparedCapitalGrant(proof, prepared)
      .pipe(
        Effect.mapError((cause) =>
          capitalActivationOperationalError('qualified capital generation activation failed', cause),
        ),
      )
    if (
      activated.generationHash !== prepared.generationHash ||
      activated.maximum !== Authority.Execution ||
      (activated.kill === KillState.Clear && activated.effective !== Authority.Execution) ||
      (activated.kill === KillState.Active && activated.effective !== Authority.Observe)
    ) {
      return yield* capitalActivationOperationalError(
        'qualified capital authority does not match the prepared generation',
      )
    }
    return activated
  })

export interface ConfiguredCapitalActivation {
  readonly request: CapitalActivationRequest
  readonly buildContinuation: ResearchCapitalBuildContinuation | null
  readonly buildLineage: ResearchCapitalBuildLineage | null
}

export const decodeConfiguredCapitalActivation = (
  serialized: string,
  serializedBuildLineage?: string,
): Result.Result<ConfiguredCapitalActivation, string> => {
  let value: unknown
  try {
    value = JSON.parse(serialized) as unknown
  } catch {
    return Result.fail('configured capital activation is not valid JSON')
  }
  const decoded = decodeCapitalActivationConfigurationResult(value)
  if (Result.isFailure(decoded)) {
    return Result.fail('configured capital activation failed its canonical schema and hash validation')
  }
  let buildLineage: ResearchCapitalBuildLineage | null = null
  if (serializedBuildLineage !== undefined) {
    let lineageValue: unknown
    try {
      lineageValue = JSON.parse(serializedBuildLineage) as unknown
    } catch {
      return Result.fail('configured research capital build lineage is not valid JSON')
    }
    const decodedLineage = decodeResearchCapitalBuildLineageResult(lineageValue)
    if (Result.isFailure(decodedLineage)) {
      return Result.fail('configured research capital build lineage failed its strict schema validation')
    }
    buildLineage = decodedLineage.success
  }
  if (isResearchCapitalBuildContinuation(decoded.success)) {
    return buildLineage === null
      ? Result.succeed({ request: decoded.success.request, buildContinuation: decoded.success, buildLineage: null })
      : Result.fail('research capital build continuation cannot be combined with build lineage')
  }
  if (buildLineage !== null && !isResearchCapitalActivationRequest(decoded.success)) {
    return Result.fail('research capital build lineage requires a research activation request')
  }
  return Result.succeed({ request: decoded.success, buildContinuation: null, buildLineage })
}

export const readOnlyExecutionPolicy = (plan: ApplicationPlanFor<'AutonomousService'>): ReadOnlyExecutionPolicy => ({
  brokerIdentity: plan.config.alpaca.identity,
  brokerAccess: BrokerAccess.ReadOnly,
  capitalAuthority: noCapitalAuthority,
})

const capitalActivationRequestIdentityIsCurrent = (
  request: CapitalActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  observedAt: string,
  allowCloseRecovery: boolean,
): Result.Result<void, string> => {
  if (!allowCloseRecovery && (request.expiresAt <= observedAt || request.cutoffAt <= observedAt)) {
    return Result.fail('capital activation request is expired or past its immutable cutoff')
  }
  if (request.strategy.protocolHash !== plan.strategyProtocolHash) {
    return Result.fail('capital activation request strategy protocol does not match the current strategy')
  }
  const strategy = plan.strategy.provenance.strategy
  return request.strategy.name === strategy.name &&
    request.strategy.behaviorHash === strategy.behaviorHash &&
    request.strategy.parameterHash === strategy.parameterHash &&
    request.strategy.parameterSchemaVersion === strategy.parameterSchemaVersion
    ? Result.succeed(undefined)
    : Result.fail('capital activation request strategy identity does not match the current strategy')
}

const researchCapitalBrokerBindingIsCurrent = (
  request: ResearchCapitalActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
): Result.Result<void, string> => {
  if (request.activation.imageRepository !== plan.config.build.imageRepository) {
    return Result.fail('research capital request image repository does not match the current runtime')
  }
  return request.broker.environment === BrokerEnvironment.Sandbox &&
    request.broker.accountId === plan.config.alpaca.expectedAccountId &&
    request.broker.identityHash === plan.config.alpaca.identity.identityHash
    ? Result.succeed(undefined)
    : Result.fail('research capital request broker identity does not match the configured sandbox account')
}

/**
 * Validates the non-build identity needed before durable recovery. This does not authorize fresh activation: callers
 * must immediately prove an existing generation bound to the request, while fresh activation uses the strict build
 * validator below.
 */
export const researchCapitalRecoveryRequestIsCompatible = (
  request: ResearchCapitalActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  observedAt: string,
  allowCloseRecovery = false,
): Result.Result<void, string> => {
  const identity = capitalActivationRequestIdentityIsCurrent(request, plan, observedAt, allowCloseRecovery)
  return Result.isFailure(identity) ? identity : researchCapitalBrokerBindingIsCurrent(request, plan)
}

export const capitalActivationRequestIsCurrent = (
  request: CapitalActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  evidence: RuntimeEvidence | null,
  observedAt: string,
  options: {
    readonly allowCloseRecovery?: boolean
    readonly buildContinuation?: ResearchCapitalBuildContinuation | null
    readonly buildLineage?: ResearchCapitalBuildLineage | null
  } = {},
): Result.Result<void, string> => {
  const identity = capitalActivationRequestIdentityIsCurrent(
    request,
    plan,
    observedAt,
    options.allowCloseRecovery === true,
  )
  if (Result.isFailure(identity)) return identity
  const requestBuildIsCurrent =
    request.activation.sourceRevision === plan.config.build.sourceRevision &&
    request.activation.imageRepository === plan.config.build.imageRepository &&
    request.activation.imageDigest === plan.config.build.imageDigest
  const continuationAuthorizesCurrentWorker =
    isResearchCapitalActivationRequest(request) &&
    options.buildContinuation !== null &&
    options.buildContinuation !== undefined &&
    options.buildContinuation.request.requestHash === request.requestHash &&
    options.buildContinuation.activation.sourceRevision === plan.config.build.sourceRevision &&
    options.buildContinuation.activation.imageRepository === plan.config.build.imageRepository &&
    options.buildContinuation.activation.imageDigest === plan.config.build.imageDigest
  const buildLineage = options.buildLineage
  if (buildLineage !== null && buildLineage !== undefined && !isResearchCapitalActivationRequest(request)) {
    return Result.fail('research capital build lineage requires a research activation request')
  }
  const lineageBinding =
    isResearchCapitalActivationRequest(request) && buildLineage !== null && buildLineage !== undefined
      ? researchCapitalBuildLineageIsCurrent(buildLineage, request, {
          sourceRevision: plan.config.build.sourceRevision,
          imageRepository: plan.config.build.imageRepository,
          imageDigest: plan.config.build.imageDigest,
        })
      : null
  if (lineageBinding !== null && Result.isFailure(lineageBinding)) return lineageBinding
  const lineageAuthorizesCurrentWorker = lineageBinding !== null
  if (!requestBuildIsCurrent && !continuationAuthorizesCurrentWorker && !lineageAuthorizesCurrentWorker) {
    return Result.fail('capital activation request is not bound to the current activation build')
  }
  if (isResearchCapitalActivationRequest(request)) {
    return researchCapitalBrokerBindingIsCurrent(request, plan)
  }
  if (evidence === null) return Result.fail('pinned qualification evidence was not published by startup')
  if (
    evidence.evaluation.runId !== request.qualification.runId ||
    evidence.qualification.runId !== request.qualification.runId ||
    evidence.qualification.lockId !== request.qualification.lockId ||
    evidence.qualification.resultHash !== request.qualification.resultHash
  ) {
    return Result.fail('capital activation request does not match the recovered qualification result')
  }
  if (evidence.qualification.verdict !== 'QUALIFIED' || evidence.qualification.evaluationVerdict.status !== 'PASS') {
    return Result.fail('capital activation request requires a qualified economic result')
  }
  if (
    evidence.provenance.sourceRevision !== request.qualification.sourceRevision ||
    evidence.provenance.image.repository !== request.qualification.imageRepository ||
    evidence.provenance.image.digest !== request.qualification.imageDigest
  ) {
    return Result.fail('capital activation request does not match the durable qualification provenance')
  }
  return Result.succeed(undefined)
}

export const internalExecutionPlan = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  mode: 'ExecutionCandidateDiscovery' | 'ExecutionPrepare',
  request: QualifiedCapitalActivationRequest,
  execution: ReadOnlyExecutionPolicy,
  executionPrepareRequest?: ExecutionPrepareRequest,
) => {
  const config = {
    ...plan.config,
    runtimeMode: mode,
    qualificationRunId: request.qualification.runId,
    execution,
    ...(executionPrepareRequest === undefined ? {} : { executionPrepareRequest }),
  } as Extract<LoadedRuntimeConfig, { readonly runtimeMode: typeof mode }>
  return makeApplicationPlan({
    config,
    protocol: plan.protocol,
    parameterHash: plan.parameterHash,
    strategy: plan.strategy,
    strategyProtocolHash: plan.strategyProtocolHash,
  }) as ApplicationPlan
}

export const buildCapitalActivationPrepareRequest = (
  request: QualifiedCapitalActivationRequest,
  evidence: RuntimeEvidence,
  discoveryReceipt: ExecutionCandidateDiscoveryReceipt,
): Result.Result<ExecutionPrepareRequest, string> => {
  if (evidence.qualification.analysis.candidateOrdinal < 0) {
    return Result.fail('recovered qualification candidate ordinal is invalid')
  }
  return Result.succeed({
    schemaVersion: 'bayn.execution-prepare-request.v1',
    qualification: {
      runId: request.qualification.runId,
      lockId: request.qualification.lockId,
      resultHash: request.qualification.resultHash,
      verdict: 'QUALIFIED',
      sourceRevision: request.qualification.sourceRevision,
      imageRepository: request.qualification.imageRepository,
      imageDigest: request.qualification.imageDigest,
      candidateOrdinal: evidence.qualification.analysis.candidateOrdinal,
    },
    discoveryReceipt,
  })
}

export const capitalGenerationIsBoundToRequest = (
  request: QualifiedCapitalActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  generation: CapitalGrantGeneration,
): Result.Result<void, string> => {
  if (generation.maximum !== Authority.Execution) {
    return Result.fail('execution PREPARE did not return a mutation generation')
  }
  if (generation.previousGenerationHash !== plan.config.alpaca.authorityGenerationHash) {
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
    generation.activationSourceRevision !== request.activation.sourceRevision ||
    generation.activationImageRepository !== request.activation.imageRepository ||
    generation.activationImageDigest !== request.activation.imageDigest ||
    generation.strategyName !== request.strategy.name ||
    generation.strategyBehaviorHash !== request.strategy.behaviorHash ||
    generation.strategyParameterHash !== request.strategy.parameterHash ||
    generation.strategyParameterSchemaVersion !== request.strategy.parameterSchemaVersion ||
    generation.protocolHash !== request.strategy.protocolHash
  ) {
    return Result.fail('prepared generation is not bound to the requested current strategy and build')
  }
  return Result.succeed(undefined)
}

export type CapitalAuthorityGeneration = CapitalGrantGeneration | ResearchCapitalGrantGeneration

const currentActivationBinding = (
  plan: ApplicationPlanFor<'AutonomousService'>,
): ResearchCapitalBuildLineage['activation'] => ({
  sourceRevision: plan.config.build.sourceRevision,
  imageRepository: plan.config.build.imageRepository,
  imageDigest: plan.config.build.imageDigest,
})

const researchCapitalGenerationBinding = (
  request: ResearchCapitalActivationRequest,
  activation: ResearchCapitalBuildLineage['activation'],
  sourceGenerationHash: string,
  generation: ResearchCapitalGrantGeneration,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  buildLineage: ResearchCapitalBuildLineage | null,
): Result.Result<void, string> => {
  if (buildContinuation !== null) {
    return researchCapitalBuildContinuationIsBound(buildContinuation, sourceGenerationHash, generation)
  }
  if (buildLineage !== null) {
    return researchCapitalGenerationIsBoundToBuildLineage(
      buildLineage,
      request,
      activation,
      sourceGenerationHash,
      generation,
    )
  }
  return researchCapitalGenerationIsBoundToRequest(request, sourceGenerationHash, generation)
}

export const preparedCapitalActivationIsBound = (
  request: QualifiedCapitalActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  prepared: ExecutionPrepareOutput,
): Result.Result<void, string> => {
  const { generation, preflight } = prepared
  const binding = capitalGenerationIsBoundToRequest(request, plan, generation)
  if (Result.isFailure(binding)) return binding
  if (preflight.environment !== BrokerEnvironment.Sandbox) return Result.fail('execution PREPARE broker is not sandbox')
  if (preflight.accountId !== plan.config.alpaca.expectedAccountId) {
    return Result.fail('execution PREPARE broker account does not match the configured account')
  }
  if (
    preflight.openOrderCount !== request.limits.maxOpenOrders ||
    preflight.positionCount !== request.limits.maxPositions
  ) {
    return Result.fail('execution PREPARE broker preflight is not an empty order book and position set')
  }
  return Result.succeed(undefined)
}

export const readBoundCapitalActivationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: CapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  buildLineage: ResearchCapitalBuildLineage | null,
  authorityStore: AuthorityGenerationStoreShape,
): Effect.Effect<CapitalAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    if (authorityStore.readAuthorityState === undefined) {
      return yield* capitalActivationOperationalError(
        'durable capital recovery requires authority history read capabilities',
      )
    }
    const authority = yield* authorityStore.readAuthorityState.pipe(
      Effect.mapError((cause) => capitalActivationOperationalError('durable capital authority read failed', cause)),
    )
    if (authority.maximum !== Authority.Execution) {
      return yield* capitalActivationOperationalError('durable capital recovery requires mutation-capable authority')
    }
    const closeAuthorityIsBound =
      (authority.effective === Authority.Execution && authority.kill === KillState.Clear) ||
      (authority.effective === Authority.Observe && authority.kill === KillState.Active)
    if (!closeAuthorityIsBound) {
      return yield* capitalActivationOperationalError(
        'durable capital recovery requires clear mutation or active OBSERVE close authority',
      )
    }
    if (isResearchCapitalActivationRequest(request)) {
      if (authorityStore.readResearchAuthorityGeneration === undefined) {
        return yield* capitalActivationOperationalError(
          'durable research capital recovery requires v3 authority history reads',
        )
      }
      const generation = yield* authorityStore
        .readResearchAuthorityGeneration(authority.generationHash)
        .pipe(
          Effect.mapError((cause) =>
            capitalActivationOperationalError('durable capital generation read failed', cause),
          ),
        )
      if (generation === undefined) {
        return yield* capitalActivationOperationalError('durable research capital history is missing')
      }
      const binding = researchCapitalGenerationBinding(
        request,
        currentActivationBinding(plan),
        generation.previousGenerationHash,
        generation,
        buildContinuation,
        buildLineage,
      )
      yield* Effect.fromResult(binding).pipe(Effect.mapError((message) => capitalActivationOperationalError(message)))
      return generation
    }
    if (authorityStore.readAuthorityGeneration === undefined) {
      return yield* capitalActivationOperationalError(
        'durable qualified capital recovery requires v2 authority history reads',
      )
    }
    const generation = yield* authorityStore
      .readAuthorityGeneration(authority.generationHash)
      .pipe(
        Effect.mapError((cause) => capitalActivationOperationalError('durable capital generation read failed', cause)),
      )
    if (generation === undefined) {
      return yield* capitalActivationOperationalError('durable qualified capital history is missing')
    }
    yield* Effect.fromResult(capitalGenerationIsBoundToRequest(request, plan, generation)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    return generation
  })

export interface CompletedExecutionLifecycle {
  readonly authorityGenerationHash: string
  readonly receiptHash: string
}

export const readCompletedExecutionLifecycle = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: CapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  buildLineage: ResearchCapitalBuildLineage | null,
  authorityStore: AuthorityGenerationStoreShape,
  readReceiptHash: (authorityGenerationHash: string) => Effect.Effect<Option.Option<string>, OperationalError>,
): Effect.Effect<CompletedExecutionLifecycle | undefined, OperationalError> =>
  Effect.gen(function* () {
    if (
      authorityStore.readAuthorityState === undefined ||
      authorityStore.readAuthorityGenerationLineage === undefined
    ) {
      return undefined
    }
    const authority = yield* authorityStore.readAuthorityState.pipe(
      Effect.mapError((cause) =>
        capitalActivationOperationalError('completed execution lifecycle authority read failed', cause),
      ),
    )
    if (
      authority.maximum !== Authority.Observe ||
      authority.effective !== Authority.Observe ||
      authority.kill !== KillState.Clear
    ) {
      return undefined
    }
    const lineage = yield* authorityStore
      .readAuthorityGenerationLineage(authority.generationHash)
      .pipe(
        Effect.mapError((cause) =>
          capitalActivationOperationalError('completed execution lifecycle lineage read failed', cause),
        ),
      )
    if (
      lineage === undefined ||
      lineage.generationHash !== authority.generationHash ||
      lineage.maximum !== Authority.Observe ||
      lineage.previousGenerationHash === null
    ) {
      return undefined
    }

    const previousGenerationHash = lineage.previousGenerationHash
    let generation: CapitalAuthorityGeneration | undefined
    let binding: Result.Result<void, string>
    if (isResearchCapitalActivationRequest(request)) {
      if (authorityStore.readResearchAuthorityGeneration === undefined) return undefined
      generation = yield* authorityStore
        .readResearchAuthorityGeneration(previousGenerationHash)
        .pipe(
          Effect.mapError((cause) =>
            capitalActivationOperationalError('completed research capital generation read failed', cause),
          ),
        )
      if (generation === undefined) return undefined
      binding =
        buildLineage === null
          ? researchCapitalGenerationBinding(
              request,
              currentActivationBinding(plan),
              generation.previousGenerationHash,
              generation,
              buildContinuation,
              null,
            )
          : researchCapitalGenerationIsBoundToBuildLineage(
              buildLineage,
              request,
              currentActivationBinding(plan),
              generation.previousGenerationHash,
              generation,
            )
    } else {
      if (authorityStore.readAuthorityGeneration === undefined) return undefined
      generation = yield* authorityStore
        .readAuthorityGeneration(previousGenerationHash)
        .pipe(
          Effect.mapError((cause) =>
            capitalActivationOperationalError('completed qualified capital generation read failed', cause),
          ),
        )
      if (generation === undefined) return undefined
      binding = capitalGenerationIsBoundToRequest(request, plan, generation)
    }
    if (Result.isFailure(binding)) return undefined

    const expectedSuccessorHash = yield* Effect.fromResult(
      executionObserveSuccessorGenerationHash({ previousExecutionGenerationHash: generation.generationHash }),
    ).pipe(
      Effect.mapError((cause) =>
        capitalActivationOperationalError('completed execution lifecycle successor hashing failed', cause),
      ),
    )
    if (expectedSuccessorHash !== authority.generationHash) {
      return yield* capitalActivationOperationalError(
        'completed execution lifecycle OBSERVE successor does not match the terminal capital generation',
      )
    }
    const receiptHash = yield* readReceiptHash(generation.generationHash)
    return Option.match(receiptHash, {
      onNone: () => undefined,
      onSome: (hash) => ({ authorityGenerationHash: generation.generationHash, receiptHash: hash }),
    })
  })

export const recoverCapitalActivationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: CapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  buildLineage: ResearchCapitalBuildLineage | null,
  evidence: RuntimeEvidence | null,
  authorityStore: AuthorityGenerationStoreShape,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<CapitalAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    const requestValidation = isResearchCapitalActivationRequest(request)
      ? researchCapitalRecoveryRequestIsCompatible(request, plan, observedAt, true)
      : capitalActivationRequestIsCurrent(request, plan, evidence, observedAt, {
          allowCloseRecovery: true,
          buildContinuation,
        })
    yield* Effect.fromResult(requestValidation).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    const closeExpiresAt = executionMandateCloseExpiresAt(request.expiresAt)
    if (observedAt >= closeExpiresAt) {
      yield* restrictExpiredCapitalActivation(authorityRestrictionStore, writerFence)
      return yield* capitalActivationOperationalError(
        'durable capital close recovery is outside its immutable close lease',
      )
    }
    if (observedAt < request.cutoffAt) {
      return yield* capitalActivationOperationalError(
        'durable capital close recovery is outside its immutable close lease',
      )
    }
    return yield* readBoundCapitalActivationGeneration(plan, request, buildContinuation, buildLineage, authorityStore)
  })

export const recoverCapitalReceiptFinalizationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: CapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  buildLineage: ResearchCapitalBuildLineage | null,
  evidence: RuntimeEvidence | null,
  authorityStore: AuthorityGenerationStoreShape,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<CapitalAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    const requestValidation = isResearchCapitalActivationRequest(request)
      ? researchCapitalRecoveryRequestIsCompatible(request, plan, observedAt, true)
      : capitalActivationRequestIsCurrent(request, plan, evidence, observedAt, {
          allowCloseRecovery: true,
          buildContinuation,
        })
    yield* Effect.fromResult(requestValidation).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    if (observedAt < executionMandateCloseExpiresAt(request.expiresAt)) {
      return yield* capitalActivationOperationalError(
        'durable capital receipt finalization is outside its bounded lease',
      )
    }
    yield* restrictExpiredCapitalActivation(authorityRestrictionStore, writerFence)
    return yield* readBoundCapitalActivationGeneration(plan, request, buildContinuation, buildLineage, authorityStore)
  })

export type CapitalActivationStartupResolution =
  | { readonly _tag: 'ReceiptFinalization'; readonly generation: CapitalAuthorityGeneration }
  | { readonly _tag: 'Mutation'; readonly generation: CapitalAuthorityGeneration }

export const prepareCapitalActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  evidence: RuntimeEvidence,
  request: QualifiedCapitalActivationRequest,
  runtimeSql: PgClient.PgClient,
  runtimeWriterFence: WriterFenceService,
): Effect.Effect<ExecutionPrepareOutput, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(capitalActivationRequestIsCurrent(request, plan, evidence, observedAt)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    const discoveryConfig = internalExecutionPlan(
      plan,
      'ExecutionCandidateDiscovery',
      request,
      readOnlyExecutionPolicy(plan),
    )
    const riskPolicy = yield* loadObserveRiskPolicy(
      plan.config.alpaca.expectedAccountId,
      plan.strategy.definition.parameters.universe,
    ).pipe(
      Effect.mapError((cause) =>
        capitalActivationOperationalError('source-controlled OBSERVE risk policy is invalid', cause),
      ),
    )
    const riskPolicyHash = yield* policyHash(riskPolicy, 'execution-candidate-policy').pipe(
      Effect.mapError((cause) => capitalActivationOperationalError(cause.message, cause)),
    )
    const discoveryReceipt = yield* discoverExecutionCandidate(
      discoveryConfig as ApplicationPlanFor<'ExecutionCandidateDiscovery'>,
      riskPolicyHash,
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- dynamic discovery subprogram boundary owns this layer
      Effect.provide(
        ExecutionCandidateDiscoveryResourcesLive(discoveryConfig as ApplicationPlanFor<'ExecutionCandidateDiscovery'>),
      ),
      Effect.mapError((cause) =>
        capitalActivationOperationalError('execution candidate discovery resource failed', cause),
      ),
    )
    const prepareRequest = yield* Effect.fromResult(
      buildCapitalActivationPrepareRequest(request, evidence, discoveryReceipt),
    ).pipe(Effect.mapError((message) => capitalActivationOperationalError(message)))
    const prepareConfig = internalExecutionPlan(
      plan,
      'ExecutionPrepare',
      request,
      readOnlyExecutionPolicy(plan),
      prepareRequest,
    )
    const validated = yield* validateExecutionPreparePlan(prepareConfig as ApplicationPlanFor<'ExecutionPrepare'>).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- dynamic PREPARE validation boundary owns this layer
      Effect.provide(ExecutionPrepareValidationResourcesLive(prepareConfig as ApplicationPlanFor<'ExecutionPrepare'>)),
      Effect.mapError((cause) => capitalActivationOperationalError('execution PREPARE validation failed', cause)),
    )
    const prepared = yield* prepareExecutionPrepareOutput(validated).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- dynamic PREPARE execution boundary owns this layer
      Effect.provide(ExecutionPrepareExecutionResourcesLive(prepareConfig as ApplicationPlanFor<'ExecutionPrepare'>)),
      Effect.mapError((cause) => capitalActivationOperationalError('execution PREPARE resource failed', cause)),
    )
    yield* Effect.fromResult(preparedCapitalActivationIsBound(request, plan, prepared)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    const authenticated = yield* authenticateValidatedExecutionPrepare(
      validated,
      validated.request.discoveryReceipt,
    ).pipe(
      Effect.mapError(executionPrepareOperationalError),
      Effect.mapError((cause) =>
        capitalActivationOperationalError('execution activation proof validation failed', cause),
      ),
    )
    const activationPolicy = yield* Effect.fromResult(
      resolveExecutionPolicy({
        brokerIdentity: plan.config.alpaca.identity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Granted,
        authorityGenerationHash: prepared.generation.generationHash,
        persistedCapitalGrantHash: undefined,
      }),
    ).pipe(
      Effect.mapError((cause) =>
        capitalActivationOperationalError('qualified capital activation policy is invalid', cause),
      ),
    )
    const activationConfig = {
      ...prepareConfig.config,
      execution: activationPolicy,
      alpaca: {
        ...prepareConfig.config.alpaca,
        authorityGenerationHash: prepared.generation.generationHash,
      },
    } as LoadedRuntimeConfig
    yield* Effect.flatMap(CapitalGrantLifecycleStore, (lifecycle) =>
      activatePreparedQualifiedCapitalGeneration(lifecycle, authenticated.proof, {
        generationHash: prepared.generation.generationHash,
        sourceGenerationHash: plan.config.alpaca.authorityGenerationHash,
      }),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- dynamic qualified activation boundary owns this layer
      Effect.provide(QualifiedCapitalActivationStoreLive(activationConfig, runtimeSql, runtimeWriterFence)),
      Effect.mapError((cause) =>
        cause instanceof OperationalError
          ? cause
          : capitalActivationOperationalError('qualified capital activation resource failed', cause),
      ),
    )
    return prepared
  })

export const prepareOrRecoverQualifiedCapitalActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  evidence: RuntimeEvidence,
  request: QualifiedCapitalActivationRequest,
  authorityStore: AuthorityGenerationStoreShape,
  prepare: Effect.Effect<ExecutionPrepareOutput, OperationalError>,
): Effect.Effect<CapitalAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(capitalActivationRequestIsCurrent(request, plan, evidence, observedAt)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    if (authorityStore.readAuthorityState === undefined) {
      return yield* capitalActivationOperationalError(
        'qualified capital startup requires durable authority state reads',
      )
    }
    const authority = yield* authorityStore.readAuthorityState.pipe(
      Effect.mapError((cause) => capitalActivationOperationalError('qualified capital authority read failed', cause)),
    )
    if (authority.maximum === Authority.Execution) {
      return yield* readBoundCapitalActivationGeneration(plan, request, null, null, authorityStore)
    }
    return (yield* prepare).generation
  })

export const validateResearchCapitalPreflight = (
  request: ResearchCapitalActivationRequest,
  preflight: ReadPreflight,
): Result.Result<void, string> =>
  preflight.environment === BrokerEnvironment.Sandbox &&
  preflight.accountId === request.broker.accountId &&
  preflight.openOrderCount === request.limits.maxOpenOrders &&
  preflight.positionCount === request.limits.maxPositions
    ? Result.succeed(undefined)
    : Result.fail('research capital preflight requires the exact empty sandbox account')

export const validateResearchCapitalRiskPolicy = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchCapitalActivationRequest,
): Effect.Effect<void, OperationalError> =>
  loadStrategyExecutionRiskPolicy(request.broker.accountId, plan.strategy).pipe(
    Effect.mapError((cause) =>
      capitalActivationOperationalError('source-controlled capital risk policy is invalid', cause),
    ),
    Effect.flatMap((riskPolicy) => policyHash(riskPolicy, 'execution-candidate-policy')),
    Effect.mapError((cause) => capitalActivationOperationalError(cause.message, cause)),
    Effect.flatMap((currentRiskPolicyHash) =>
      currentRiskPolicyHash === request.riskPolicyHash
        ? Effect.void
        : Effect.fail(
            capitalActivationOperationalError('research capital request is not bound to the current risk policy'),
          ),
    ),
  )

export const validateResearchCapitalCloseLease = (
  request: ResearchCapitalActivationRequest,
  session: BrokerSessionShape,
): Effect.Effect<void, OperationalError> => {
  const requestedRange = { start: request.cutoffAt.slice(0, 10), end: request.expiresAt.slice(0, 10) }
  return session.read.marketCalendar(requestedRange).pipe(
    Effect.mapError((cause) => capitalActivationOperationalError('research capital close calendar read failed', cause)),
    Effect.flatMap((calendar) =>
      calendar.value.requestedRange.start === requestedRange.start &&
      calendar.value.requestedRange.end === requestedRange.end
        ? Effect.succeed(calendar.value.sessions)
        : Effect.fail(
            capitalActivationOperationalError('research capital close calendar did not cover the requested lease'),
          ),
    ),
    Effect.flatMap((sessions) =>
      Effect.fromResult(
        validateExecutionMandateCloseWindow({
          cutoffAt: request.cutoffAt,
          expiresAt: request.expiresAt,
          maximumCloseSessions: request.maximumCloseSessions,
          sessions,
        }),
      ),
    ),
    Effect.mapError((cause) =>
      cause instanceof OperationalError
        ? cause
        : capitalActivationOperationalError(`research capital close lease is invalid: ${cause._tag}`, cause),
    ),
    Effect.asVoid,
  )
}

export const validateActivatedResearchAuthority = (authority: AuthorityState): Result.Result<void, string> =>
  authority.maximum === Authority.Execution &&
  authority.effective === Authority.Execution &&
  authority.kill === KillState.Clear
    ? Result.succeed(undefined)
    : Result.fail('research capital activation did not return clear effective mutation authority')

export const readCurrentResearchCapitalGeneration = (
  authority: AuthorityState,
  authorityStore: AuthorityGenerationStoreShape,
): Effect.Effect<ResearchCapitalGrantGeneration | undefined, OperationalError> => {
  if (authority.maximum !== Authority.Execution) return Effect.as(Effect.void, undefined)
  if (authorityStore.readResearchAuthorityGeneration === undefined) {
    return Effect.fail(
      capitalActivationOperationalError('research capital startup requires v3 authority history reads'),
    )
  }
  return authorityStore.readResearchAuthorityGeneration(authority.generationHash).pipe(
    Effect.mapError((cause) => capitalActivationOperationalError('research capital generation read failed', cause)),
    Effect.flatMap((generation) =>
      generation === undefined
        ? Effect.fail(capitalActivationOperationalError('durable research capital history is missing'))
        : Effect.succeed(generation),
    ),
  )
}

export const prepareResearchCapitalActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchCapitalActivationRequest,
  buildLineage: ResearchCapitalBuildLineage | null,
  sourceGenerationHash: string,
  session: BrokerSessionShape,
  authorityStore: AuthorityGenerationStoreShape,
  lifecycle: CapitalGrantLifecycleStoreShape,
): Effect.Effect<ResearchCapitalGrantGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(capitalActivationRequestIsCurrent(request, plan, null, observedAt, { buildLineage })).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    yield* Effect.fromResult(validateResearchCapitalPreflight(request, session.preflight)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    yield* validateResearchCapitalRiskPolicy(plan, request)
    yield* validateResearchCapitalCloseLease(request, session)

    const proof = researchCapitalGrantProof(request, buildLineage?.activation)
    const authority = yield* lifecycle
      .activateResearchCapitalGrant(proof, sourceGenerationHash, request.cutoffAt)
      .pipe(
        Effect.mapError((cause) =>
          capitalActivationOperationalError('research capital generation activation failed', cause),
        ),
      )
    yield* Effect.fromResult(validateActivatedResearchAuthority(authority)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    return yield* readBoundCapitalActivationGeneration(plan, request, null, buildLineage, authorityStore).pipe(
      Effect.flatMap((generation) =>
        generation.schemaVersion === legacyAuthorityGenerationV3SchemaVersion
          ? Effect.succeed(generation)
          : Effect.fail(capitalActivationOperationalError('research capital activation loaded qualified history')),
      ),
    )
  })

export const refreshResearchCapitalActivationReconciliationDataFirst = <E, R>(
  reconcile: Effect.Effect<unknown, E, R>,
  operationTimeoutMs: number,
): Effect.Effect<void, OperationalError, R> =>
  reconcile.pipe(
    Effect.timeoutOrElse({
      duration: operationTimeoutMs,
      orElse: () =>
        Effect.fail(capitalActivationOperationalError('research capital pre-activation reconciliation timed out')),
    }),
    Effect.mapError((cause) =>
      capitalActivationOperationalError('research capital pre-activation reconciliation failed', cause),
    ),
    Effect.asVoid,
  )

export const refreshResearchCapitalActivationReconciliation = Pipeable.generic<
  <E, R>(
    operationTimeoutMs: number,
  ) => (reconcile: Effect.Effect<unknown, E, R>) => Effect.Effect<void, OperationalError, R>,
  typeof refreshResearchCapitalActivationReconciliationDataFirst
>(2, refreshResearchCapitalActivationReconciliationDataFirst)

export const prepareOrRecoverResearchCapitalActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchCapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  buildLineage: ResearchCapitalBuildLineage | null,
  session: BrokerSessionShape,
  authorityStore: AuthorityGenerationStoreShape,
  lifecycle: CapitalGrantLifecycleStoreShape,
  reconcile: Effect.Effect<unknown, ReconciliationPassError | OperationalError>,
  operationTimeoutMs: number,
): Effect.Effect<ResearchCapitalGrantGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(researchCapitalRecoveryRequestIsCompatible(request, plan, observedAt)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    if (authorityStore.readAuthorityState === undefined) {
      return yield* capitalActivationOperationalError('research capital startup requires durable authority state reads')
    }
    const authority = yield* authorityStore.readAuthorityState.pipe(
      Effect.mapError((cause) => capitalActivationOperationalError('research capital authority read failed', cause)),
    )
    const currentGeneration = yield* readCurrentResearchCapitalGeneration(authority, authorityStore)
    const currentSourceGenerationHash = currentGeneration?.previousGenerationHash ?? authority.generationHash
    if (authority.maximum === Authority.Observe) {
      const replayed = yield* authorityStore
        .ensureAuthorityGeneration({ generationHash: authority.generationHash, maximum: Authority.Observe })
        .pipe(
          Effect.mapError((cause) =>
            capitalActivationOperationalError('research capital current OBSERVE generation validation failed', cause),
          ),
        )
      if (
        replayed.generationHash !== authority.generationHash ||
        replayed.maximum !== authority.maximum ||
        replayed.effective !== authority.effective ||
        replayed.kill !== authority.kill ||
        replayed.version !== authority.version
      ) {
        return yield* capitalActivationOperationalError(
          'research capital current OBSERVE generation changed during validation',
        )
      }
    }
    const currentGenerationMatchesRequest =
      currentGeneration !== undefined &&
      Result.isSuccess(
        researchCapitalGenerationBinding(
          request,
          currentActivationBinding(plan),
          currentSourceGenerationHash,
          currentGeneration,
          buildContinuation,
          buildLineage,
        ),
      )
    const decision = yield* Effect.fromResult(
      decideExecutionMandateAuthority({
        generationHash: authority.generationHash,
        sourceGenerationHash: currentSourceGenerationHash,
        currentGenerationMatchesRequest,
        maximum: authority.maximum,
        effective: authority.effective,
        kill: authority.kill,
        ...(authority.reason === undefined ? {} : { reason: authority.reason }),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        capitalActivationOperationalError('research capital authority does not match this mandate', cause),
      ),
    )
    if (buildContinuation !== null && decision._tag !== 'Resume' && decision._tag !== 'ResumeRestricted') {
      return yield* capitalActivationOperationalError(
        'research capital build continuation requires the exact active generation',
      )
    }
    const activationRequired = decision._tag === 'Activate' || decision._tag === 'Rearm'
    if (activationRequired) {
      yield* Effect.fromResult(
        capitalActivationRequestIsCurrent(request, plan, null, observedAt, { buildLineage }),
      ).pipe(Effect.mapError((message) => capitalActivationOperationalError(message)))
    }
    const activationSourceGenerationHash =
      decision._tag === 'Rearm'
        ? yield* Effect.fromResult(
            executionObserveSuccessorGenerationHash({
              previousExecutionGenerationHash: authority.generationHash,
            }),
          ).pipe(
            Effect.mapError((cause) =>
              capitalActivationOperationalError('research capital OBSERVE successor hashing failed', cause),
            ),
          )
        : currentSourceGenerationHash
    if (activationRequired) {
      // PostgreSQL requires broker evidence observed after the previous authority update. It must exist before a
      // completed capital generation is rearmed, and the same observation then binds the new activation.
      yield* refreshResearchCapitalActivationReconciliation(reconcile, operationTimeoutMs)
    }
    if (decision._tag === 'Rearm') {
      const rearmed = yield* authorityStore
        .ensureAuthorityGeneration({
          generationHash: activationSourceGenerationHash,
          maximum: Authority.Observe,
        })
        .pipe(
          Effect.mapError((cause) =>
            capitalActivationOperationalError('research capital source authority rearm failed', cause),
          ),
        )
      if (
        rearmed.generationHash !== activationSourceGenerationHash ||
        rearmed.maximum !== Authority.Observe ||
        rearmed.effective !== Authority.Observe ||
        rearmed.kill !== KillState.Clear
      ) {
        return yield* capitalActivationOperationalError(
          'research capital source authority rearm did not return clear OBSERVE',
        )
      }
    }
    if (activationRequired) {
      return yield* prepareResearchCapitalActivation(
        plan,
        request,
        buildLineage,
        activationSourceGenerationHash,
        session,
        authorityStore,
        lifecycle,
      )
    }
    const generation =
      currentGeneration ?? (yield* capitalActivationOperationalError('research capital recovery lost durable history'))
    if (buildContinuation !== null) {
      const restricted = decision._tag === 'ResumeRestricted'
      yield* Effect.logInfo(
        restricted
          ? 'Bayn capital build continuation resumed a restricted active generation for recovery'
          : 'Bayn capital build continuation resumed the active generation',
      ).pipe(
        Effect.annotateLogs({
          service: 'bayn',
          activationMode: restricted ? 'RECOVERY_ONLY' : 'ACTIVE',
          continuationHash: buildContinuation.continuationHash,
          generationHash: generation.generationHash,
          sourceRevision: plan.config.build.sourceRevision,
          imageDigest: plan.config.build.imageDigest,
          ...(restricted ? { authorityReason: authority.reason ?? 'unknown' } : {}),
        }),
      )
    }
    return generation
  })

export const pendingCapitalActivation = (
  state: Ref.Ref<RuntimeState>,
  request: CapitalActivationRequest | null,
  reason: Extract<NonNullable<RuntimeState['capitalActivation']>, { readonly _tag: 'Pending' }>['reason'],
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    capitalActivation: { _tag: 'Pending' as const, requestHash: request?.requestHash ?? null, reason },
    broker:
      current.broker === null
        ? null
        : {
            ...current.broker,
            executionEligible: false,
            executionDisabledReason: 'CAPITAL_ACTIVATION_NOT_PREPARED',
          },
    error: null,
  }))

export const realizedCapitalActivation = (
  state: Ref.Ref<RuntimeState>,
  request: CapitalActivationRequest,
  generationHash: string,
  grant: 'Qualified' | 'Research',
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    capitalActivation: {
      _tag: 'Realized' as const,
      requestHash: request.requestHash,
      generationHash,
      grant,
      cutoffAt: request.cutoffAt,
      expiresAt: request.expiresAt,
      maximumCloseSessions: isResearchCapitalActivationRequest(request) ? request.maximumCloseSessions : null,
    },
    broker:
      current.broker === null ? null : { ...current.broker, executionEligible: true, executionDisabledReason: null },
    error: null,
  }))

export const completedCapitalActivation = (
  state: Ref.Ref<RuntimeState>,
  request: CapitalActivationRequest,
  generationHash: string,
  receiptHash: string,
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    capitalActivation: {
      _tag: 'Completed' as const,
      requestHash: request.requestHash,
      generationHash,
      grant: isResearchCapitalActivationRequest(request) ? ('Research' as const) : ('Qualified' as const),
      receiptHash,
    },
    broker:
      current.broker === null
        ? null
        : {
            ...current.broker,
            executionEligible: false,
            executionDisabledReason: 'EXECUTION_EPISODE_COMPLETED',
          },
    error: null,
  }))

export const restrictExpiredCapitalActivationDataFirst = (
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<void, OperationalError> =>
  restrictMutationAuthority(executionActivationRestrictionSubject, 'immutable activation request expired').pipe(
    Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
    Effect.provideService(WriterFence, writerFence),
    Effect.mapError((cause) => capitalActivationOperationalError('expired capital restriction failed', cause)),
  )

export const restrictExpiredCapitalActivation = Pipeable.dual(2, restrictExpiredCapitalActivationDataFirst)
