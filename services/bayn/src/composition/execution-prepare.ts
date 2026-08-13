import { Effect, Option, pipe, Result, Schema, Stdio, Stream } from 'effect'

import type { ApplicationPlanFor } from '../app'
import { BrokerSession } from '../broker/alpaca'
import { EvidenceStore } from '../db/evidence-store'
import { OperationalError, operationalError } from '../errors'
import {
  discoverExecutionCandidates as discoverExecutionCandidatesHistoricalCodec,
  renderExecutionCandidateDiscoveryError,
  type ExecutionCandidateDiscoveryReceipt,
} from '../execution-candidate-discovery'
import {
  authenticateValidatedExecutionPrepare,
  buildExecutionPrepareProofPlanRequest,
  prepareValidatedExecutionWithGeneration,
  renderExecutionPrepareFailure,
  validateExecutionPrepareInput,
  type ExecutionPrepareFailure,
  type ExecutionPrepareOutput,
  type ExecutionPrepareRuntimeBinding,
  type PrevalidatedExecutionPrepareInput,
} from '../execution-prepare'
import { canonicalHashV1Result } from '../hash'
import { loadObserveRiskPolicy } from '../observe-composition'
import { strategyApplication } from '../strategy'
import {
  ApplicationPlatformLive,
  ExecutionPrepareExecutionResourcesLive,
  ExecutionPrepareValidationResourcesLive,
} from './resources'

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const writeDiscoveryReceipt = (receipt: ExecutionCandidateDiscoveryReceipt) =>
  pipe(
    encodeJson(receipt),
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'execution-candidate-output',
        message: 'execution candidate receipt encoding failed',
        cause,
      }),
    ),
    Effect.flatMap((output) =>
      pipe(
        Stdio.Stdio,
        Effect.flatMap((stdio) => Stream.run(Stream.make(`${output}\n`), stdio.stdout())),
      ),
    ),
  )

const writeExecutionPrepareOutput = (output: ExecutionPrepareOutput) =>
  pipe(
    encodeJson(output),
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'execution-prepare-output',
        message: 'EXECUTION_PREPARE output encoding failed',
        cause,
      }),
    ),
    Effect.flatMap((output) =>
      pipe(
        Stdio.Stdio,
        Effect.flatMap((stdio) => Stream.run(Stream.make(`${output}\n`), stdio.stdout())),
      ),
    ),
  )

export const policyHash = (
  policy: unknown,
  operation: 'execution-candidate-policy' | 'execution-prepare-policy',
): Effect.Effect<string, ReturnType<typeof operationalError>> =>
  pipe(
    canonicalHashV1Result(policy),
    Result.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation,
        message: 'source-controlled OBSERVE risk policy content hashing failed',
        cause,
      }),
    ),
    Effect.fromResult,
  )

const executionCandidateIdentity = (
  plan: ApplicationPlanFor<'ExecutionCandidateDiscovery'>,
  riskPolicyHash: string,
) => ({
  sourceRevision: plan.config.build.sourceRevision,
  image: {
    repository: plan.config.build.imageRepository,
    digest: plan.config.build.imageDigest,
  },
  strategy: plan.strategy.provenance.strategy,
  strategyProtocolHash: plan.strategyProtocolHash,
  qualificationRunId: plan.config.qualificationRunId,
  accountId: plan.config.alpaca.expectedAccountId,
  authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
  policyHash: riskPolicyHash,
})

export const discoverExecutionCandidate = (
  plan: ApplicationPlanFor<'ExecutionCandidateDiscovery'>,
  riskPolicyHash: string,
) =>
  discoverExecutionCandidatesHistoricalCodec(executionCandidateIdentity(plan, riskPolicyHash)).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'execution-candidate-discovery',
        message: renderExecutionCandidateDiscoveryError(cause),
        cause,
      }),
    ),
  )

export const runExecutionCandidateDiscovery = (plan: ApplicationPlanFor<'ExecutionCandidateDiscovery'>) =>
  pipe(
    loadObserveRiskPolicy(plan.config.alpaca.expectedAccountId, plan.strategy.definition.parameters.universe),
    Effect.mapError((cause) =>
      operationalError({
        component: 'config',
        operation: 'execution-candidate-discovery',
        message: 'source-controlled OBSERVE risk policy is invalid',
        cause,
      }),
    ),
    Effect.flatMap((policy) => policyHash(policy, 'execution-candidate-policy')),
    Effect.flatMap((riskPolicyHash) => discoverExecutionCandidate(plan, riskPolicyHash)),
    Effect.flatMap(writeDiscoveryReceipt),
  )

const executionPrepareRuntimeBinding = (
  plan: ApplicationPlanFor<'ExecutionPrepare'>,
  riskPolicyHash: string,
  strategy: ExecutionPrepareRuntimeBinding['strategy'],
): ExecutionPrepareRuntimeBinding => ({
  sourceRevision: plan.config.build.sourceRevision,
  imageRepository: plan.config.build.imageRepository,
  imageDigest: plan.config.build.imageDigest,
  strategy,
  strategyProtocolHash: plan.strategyProtocolHash,
  qualificationRunId: plan.config.qualificationRunId,
  accountId: plan.config.alpaca.expectedAccountId,
  brokerIdentityHash: plan.config.alpaca.identity.identityHash,
  brokerProvider: plan.config.alpaca.identity.provider,
  brokerEnvironment: plan.config.alpaca.identity.environment,
  brokerAccess: plan.config.execution.brokerAccess,
  capitalAuthority: plan.config.execution.capitalAuthority._tag,
  authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
  riskPolicyHash,
})

const executionPrepareOperationalCause = (cause: ExecutionPrepareFailure) => {
  if (cause._tag !== 'ExecutionPrepareStoreRejected') return { _tag: cause._tag }
  const nested = cause.cause.cause
  return {
    _tag: cause._tag,
    operation: cause.operation,
    failure: cause.failure,
    nested:
      typeof nested === 'object' && nested !== null && '_tag' in nested && typeof nested._tag === 'string'
        ? nested._tag
        : null,
  }
}

export const executionPrepareOperationalError = (cause: ExecutionPrepareFailure) =>
  new OperationalError({
    component: 'strategy',
    operation: 'execution-prepare',
    message: renderExecutionPrepareFailure(cause),
    retryable: false,
    cause: executionPrepareOperationalCause(cause),
  })

export const validateExecutionPreparePlan = (plan: ApplicationPlanFor<'ExecutionPrepare'>) =>
  Effect.gen(function* () {
    const riskPolicy = yield* loadObserveRiskPolicy(
      plan.config.alpaca.expectedAccountId,
      plan.strategy.definition.parameters.universe,
    ).pipe(
      Effect.mapError((cause) =>
        operationalError({
          component: 'config',
          operation: 'execution-prepare',
          message: 'source-controlled OBSERVE risk policy is invalid',
          cause,
        }),
      ),
    )
    const riskPolicyHash = yield* policyHash(riskPolicy, 'execution-prepare-policy')
    const configuredStrategy = plan.strategy.provenance.strategy
    const application = strategyApplication(plan.strategy)
    if (
      configuredStrategy.name !== application.definition.name ||
      configuredStrategy.parameterSchemaVersion !== application.definition.parameters.schemaVersion
    ) {
      return yield* new OperationalError({
        component: 'strategy',
        operation: 'execution-prepare',
        message: 'EXECUTION_PREPARE strategy identity does not match the composed application',
        retryable: false,
        cause: { _tag: 'StrategyProtocolVersionMismatch' },
      })
    }
    const strategy: ExecutionPrepareRuntimeBinding['strategy'] = {
      name: configuredStrategy.name,
      behaviorHash: configuredStrategy.behaviorHash,
      parameterHash: configuredStrategy.parameterHash,
      parameterSchemaVersion: configuredStrategy.parameterSchemaVersion,
    }
    const evidenceStore = yield* EvidenceStore
    const qualification = yield* evidenceStore.readQualification(
      plan.config.executionPrepareRequest.qualification.runId,
    )
    if (Option.isNone(qualification)) {
      return yield* new OperationalError({
        component: 'strategy',
        operation: 'execution-prepare',
        message: 'EXECUTION_PREPARE qualification evidence is unavailable',
        retryable: false,
        cause: { _tag: 'QualificationEvidenceUnavailable' },
      })
    }
    const runtime = executionPrepareRuntimeBinding(plan, riskPolicyHash, strategy)
    const proofPlanRequest = yield* Effect.fromResult(
      buildExecutionPrepareProofPlanRequest({
        request: plan.config.executionPrepareRequest,
        qualification: qualification.value,
        runtime,
      }),
    ).pipe(Effect.mapError(executionPrepareOperationalError))
    return yield* Effect.fromResult(validateExecutionPrepareInput(proofPlanRequest, runtime)).pipe(
      Effect.mapError(executionPrepareOperationalError),
    )
  })

export const prepareExecutionPrepareOutput = (prevalidated: PrevalidatedExecutionPrepareInput) =>
  Effect.gen(function* () {
    const session = yield* BrokerSession
    const validated = yield* authenticateValidatedExecutionPrepare(
      prevalidated,
      prevalidated.request.discoveryReceipt,
    ).pipe(Effect.mapError(executionPrepareOperationalError))
    const prepared = yield* prepareValidatedExecutionWithGeneration(validated).pipe(
      Effect.mapError(executionPrepareOperationalError),
    )
    return { ...prepared, preflight: session.preflight }
  })

export const prepareExecutionPreparePlan = (plan: ApplicationPlanFor<'ExecutionPrepare'>) =>
  validateExecutionPreparePlan(plan).pipe(
    Effect.flatMap((prevalidated) => prepareExecutionPrepareOutput(prevalidated)),
    Effect.mapError(executionPrepareBoundaryError),
  )

export const runExecutionPreparePlan = (plan: ApplicationPlanFor<'ExecutionPrepare'>) =>
  validateExecutionPreparePlan(plan).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- ExecutionPrepare plan boundary owns validation resources
    Effect.provide(ExecutionPrepareValidationResourcesLive(plan)),
    Effect.flatMap((prevalidated) =>
      prepareExecutionPrepareOutput(prevalidated).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- ExecutionPrepare plan boundary owns execution resources
        Effect.provide(ExecutionPrepareExecutionResourcesLive(plan)),
        Effect.flatMap(writeExecutionPrepareOutput),
        // @effect-diagnostics-next-line strictEffectProvide:off -- ExecutionPrepare plan boundary owns platform resources
        Effect.provide(ApplicationPlatformLive),
      ),
    ),
    Effect.mapError(executionPrepareBoundaryError),
  )

export const executionPrepareBoundaryError = (cause: unknown): OperationalError =>
  cause instanceof OperationalError
    ? cause
    : new OperationalError({
        component: 'strategy',
        operation: 'execution-prepare-resource',
        message: 'EXECUTION_PREPARE resource acquisition failed closed',
        retryable: false,
        cause:
          typeof cause === 'object' && cause !== null && '_tag' in cause && typeof cause._tag === 'string'
            ? { _tag: cause._tag }
            : { _tag: 'UnknownResourceFailure' },
      })
