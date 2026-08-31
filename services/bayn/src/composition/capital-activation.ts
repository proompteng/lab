import { Effect, Option, Ref, Result } from 'effect'
import type { ApplicationPlanFor } from '../app'
import { executionObserveSuccessorGenerationHash } from '../blocked-generation-recovery'
import { type BrokerSessionShape, type ReadPreflight } from '../broker/alpaca'
import { BrokerEnvironment } from '../broker/identity'
import {
  AuthorityRestrictionStore,
  type AuthorityGenerationStoreShape,
  type AuthorityRestrictionStoreShape,
  type CapitalGrantLifecycleStoreShape,
} from '../db/execution-store'
import { BrokerAccess, noCapitalAuthority, reconciliationIncompleteRestrictionReason } from '../execution/authority'
import {
  Authority,
  KillState,
  ReconciliationStatus,
  type AuthorityState,
  type ResearchCapitalGrantGeneration,
} from '../execution/contracts'
import {
  decodeCapitalActivationConfigurationResult,
  decodeResearchCapitalBuildLineageResult,
  isResearchCapitalActivationRequest,
  isResearchCapitalBuildContinuation,
  researchCapitalGrantProof,
  researchCapitalBuildLineageIsCurrent,
  researchCapitalBuildContinuationIsBound,
  researchCapitalGenerationIsBoundToBuildLineage,
  researchCapitalGenerationIsBoundToRequest,
  type ExecutionPolicy,
  type ResearchCapitalActivationRequest,
  type ResearchCapitalBuildContinuation,
  type ResearchCapitalBuildLineage,
} from '../execution/configuration'
import { WriterFence, type WriterFenceService } from '../execution/writer-fence'
import { OperationalError } from '../errors'
import {
  decideExecutionMandateAuthority,
  executionActivationRestrictionSubject,
  isExecutionCyclePreflightStoreRestriction,
  validateExecutionMandateCloseWindow,
} from '../execution/mandate'
import { legacyAuthorityGenerationV3SchemaVersion } from '../execution/legacy-wire'
import { canonicalHashV1Result } from '../hash'
import { executionMandateCloseExpiresAt, loadStrategyExecutionRiskPolicy } from '../observe-composition'
import { restrictMutationAuthority } from '../observe-composition/mutation-interpreter'
import { type ReconciliationPassError } from '../reconciler'
import { currentUtcInstant } from '../time'
import type { RuntimeState } from '../runtime-state'
import { Pipeable } from '../pipeable'

export type ReadOnlyExecutionPolicy = Extract<ExecutionPolicy, { readonly brokerAccess: BrokerAccess.ReadOnly }>

export const capitalActivationOperationalError = (message: string, cause?: unknown): OperationalError =>
  new OperationalError({
    component: 'strategy',
    operation: 'capital-activation',
    message,
    retryable: false,
    cause: cause === undefined ? { _tag: 'CapitalActivationPreparationRejected' } : cause,
  })

export interface ConfiguredCapitalActivation {
  readonly request: ResearchCapitalActivationRequest
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
  if (!isResearchCapitalActivationRequest(decoded.success)) {
    return Result.fail('qualified capital activation is retired')
  }
  return Result.succeed({ request: decoded.success, buildContinuation: null, buildLineage })
}

export const readOnlyExecutionPolicy = (plan: ApplicationPlanFor<'AutonomousService'>): ReadOnlyExecutionPolicy => ({
  brokerIdentity: plan.config.alpaca.identity,
  brokerAccess: BrokerAccess.ReadOnly,
  capitalAuthority: noCapitalAuthority,
})

const capitalActivationRequestIdentityIsCurrent = (
  request: ResearchCapitalActivationRequest,
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

export const researchCapitalActivationRequestIsCurrent = (
  request: ResearchCapitalActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
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
  const lineageBinding =
    buildLineage !== null && buildLineage !== undefined
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
  return researchCapitalBrokerBindingIsCurrent(request, plan)
}

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

export const readBoundCapitalActivationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchCapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  buildLineage: ResearchCapitalBuildLineage | null,
  authorityStore: AuthorityGenerationStoreShape,
): Effect.Effect<ResearchCapitalGrantGeneration, OperationalError> =>
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
    if (authorityStore.readResearchAuthorityGeneration === undefined) {
      return yield* capitalActivationOperationalError(
        'durable research capital recovery requires v3 authority history reads',
      )
    }
    const generation = yield* authorityStore
      .readResearchAuthorityGeneration(authority.generationHash)
      .pipe(
        Effect.mapError((cause) => capitalActivationOperationalError('durable capital generation read failed', cause)),
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
  })

export interface CompletedExecutionLifecycle {
  readonly authorityGenerationHash: string
  readonly receiptHash: string
}

export const readCompletedExecutionLifecycle = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchCapitalActivationRequest,
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
    if (authorityStore.readResearchAuthorityGeneration === undefined) return undefined
    const generation = yield* authorityStore
      .readResearchAuthorityGeneration(previousGenerationHash)
      .pipe(
        Effect.mapError((cause) =>
          capitalActivationOperationalError('completed research capital generation read failed', cause),
        ),
      )
    if (generation === undefined) return undefined
    const binding =
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
  request: ResearchCapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  buildLineage: ResearchCapitalBuildLineage | null,
  authorityStore: AuthorityGenerationStoreShape,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<ResearchCapitalGrantGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    const requestValidation = researchCapitalRecoveryRequestIsCompatible(request, plan, observedAt, true)
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
  request: ResearchCapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  buildLineage: ResearchCapitalBuildLineage | null,
  authorityStore: AuthorityGenerationStoreShape,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<ResearchCapitalGrantGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    const requestValidation = researchCapitalRecoveryRequestIsCompatible(request, plan, observedAt, true)
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
  | { readonly _tag: 'ReceiptFinalization'; readonly generation: ResearchCapitalGrantGeneration }
  | { readonly _tag: 'Mutation'; readonly generation: ResearchCapitalGrantGeneration }

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
    Effect.flatMap((riskPolicy) => Effect.fromResult(canonicalHashV1Result(riskPolicy))),
    Effect.mapError((cause) =>
      capitalActivationOperationalError('source-controlled capital risk policy hashing failed', cause),
    ),
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
    yield* Effect.fromResult(
      researchCapitalActivationRequestIsCurrent(request, plan, observedAt, { buildLineage }),
    ).pipe(Effect.mapError((message) => capitalActivationOperationalError(message)))
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

interface CapitalActivationReconciliationObservation {
  readonly report: {
    readonly reconciliation: {
      readonly status: ReconciliationStatus
    }
  }
}

export const refreshResearchCapitalActivationReconciliationDataFirst = <E, R>(
  reconcile: Effect.Effect<CapitalActivationReconciliationObservation, E, R>,
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
    Effect.flatMap((result) =>
      result.report.reconciliation.status === ReconciliationStatus.Exact
        ? Effect.void
        : Effect.fail(
            capitalActivationOperationalError('research capital pre-activation reconciliation was not exact'),
          ),
    ),
  )

export const refreshResearchCapitalActivationReconciliation = Pipeable.generic<
  <E, R>(
    operationTimeoutMs: number,
  ) => (
    reconcile: Effect.Effect<CapitalActivationReconciliationObservation, E, R>,
  ) => Effect.Effect<void, OperationalError, R>,
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
  reconcile: Effect.Effect<CapitalActivationReconciliationObservation, ReconciliationPassError | OperationalError>,
  operationTimeoutMs: number,
): Effect.Effect<ResearchCapitalGrantGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(researchCapitalRecoveryRequestIsCompatible(request, plan, observedAt)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    const readAuthorityState = authorityStore.readAuthorityState
    if (readAuthorityState === undefined) {
      return yield* capitalActivationOperationalError('research capital startup requires durable authority state reads')
    }
    const authority = yield* readAuthorityState.pipe(
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
    const currentReconciliationRecovery =
      decision._tag === 'Rearm' &&
      authority.reason === reconciliationIncompleteRestrictionReason &&
      currentGenerationMatchesRequest &&
      currentGeneration !== undefined
    const currentPreflightStoreRecovery =
      decision._tag === 'Rearm' &&
      isExecutionCyclePreflightStoreRestriction(authority.reason) &&
      currentGenerationMatchesRequest &&
      currentGeneration !== undefined
    const currentRestrictedSourceRecovery = currentReconciliationRecovery || currentPreflightStoreRecovery
    if (
      buildContinuation !== null &&
      decision._tag !== 'Resume' &&
      decision._tag !== 'ResumeRestricted' &&
      !currentRestrictedSourceRecovery
    ) {
      return yield* capitalActivationOperationalError(
        'research capital build continuation requires the exact active generation',
      )
    }
    if (buildContinuation !== null && currentReconciliationRecovery) {
      if (currentGeneration === undefined) {
        return yield* capitalActivationOperationalError('research capital reconciliation recovery lost durable history')
      }
      return currentGeneration
    }
    const activationRequired = decision._tag === 'Activate' || decision._tag === 'Rearm'
    if (activationRequired) {
      yield* Effect.fromResult(
        researchCapitalActivationRequestIsCurrent(request, plan, observedAt, { buildLineage }),
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
      const rearmResolution = yield* authorityStore
        .ensureAuthorityGeneration({
          generationHash: activationSourceGenerationHash,
          maximum: Authority.Observe,
          ...(currentRestrictedSourceRecovery && currentGeneration !== undefined
            ? { preserveCyclePlanHash: currentGeneration.proofPlanHash }
            : {}),
        })
        .pipe(
          Effect.map((rearmed) => ({ _tag: 'Rearmed' as const, rearmed })),
          Effect.catch((cause) => {
            if (!currentRestrictedSourceRecovery || currentGeneration === undefined) {
              return Effect.fail(
                capitalActivationOperationalError('research capital source authority rearm failed', cause),
              )
            }
            return readAuthorityState.pipe(
              Effect.mapError((readCause) =>
                capitalActivationOperationalError(
                  'research capital deferred recovery authority read failed',
                  readCause,
                ),
              ),
              Effect.flatMap((current) =>
                current.generationHash === authority.generationHash &&
                current.maximum === authority.maximum &&
                current.effective === authority.effective &&
                current.kill === authority.kill &&
                current.reason === authority.reason &&
                current.version === authority.version &&
                current.updatedAt === authority.updatedAt
                  ? Effect.logWarning('Bayn deferred reconciliation rearm to the current cycle recovery owner').pipe(
                      Effect.annotateLogs({
                        service: 'bayn',
                        generationHash: authority.generationHash,
                        authorityReason: authority.reason,
                      }),
                      Effect.as({ _tag: 'RecoverCurrent' as const, generation: currentGeneration }),
                    )
                  : Effect.fail(
                      capitalActivationOperationalError(
                        'research capital authority changed while reconciliation rearm was deferred',
                        cause,
                      ),
                    ),
              ),
            )
          }),
        )
      if (rearmResolution._tag === 'RecoverCurrent') return rearmResolution.generation
      const rearmed = rearmResolution.rearmed
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
  request: ResearchCapitalActivationRequest | null,
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
  request: ResearchCapitalActivationRequest,
  generationHash: string,
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    capitalActivation: {
      _tag: 'Realized' as const,
      requestHash: request.requestHash,
      generationHash,
      grant: 'Research' as const,
      cutoffAt: request.cutoffAt,
      expiresAt: request.expiresAt,
      maximumCloseSessions: request.maximumCloseSessions,
    },
    broker:
      current.broker === null ? null : { ...current.broker, executionEligible: true, executionDisabledReason: null },
    error: null,
  }))

export const completedCapitalActivation = (
  state: Ref.Ref<RuntimeState>,
  request: ResearchCapitalActivationRequest,
  generationHash: string,
  receiptHash: string,
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    capitalActivation: {
      _tag: 'Completed' as const,
      requestHash: request.requestHash,
      generationHash,
      grant: 'Research' as const,
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
