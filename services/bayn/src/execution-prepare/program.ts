import { Effect, Result } from 'effect'

import type { QualificationRecord } from '../db/evidence-store'
import { CapitalGrantLifecycleStore } from '../db/execution-store'
import type { ExecutionCandidateDiscoveryReceipt } from '../execution-candidate-discovery'
import { canonicalHashV1Result } from '../hash'
import type { CapitalGrantGeneration } from '../execution/contracts'
import type { ExecutionPrepareFailure } from './failure'
import type {
  ExecutionPrepareProofPlanRequest,
  ExecutionPrepareReceipt,
  ExecutionPrepareRequest,
  ExecutionPrepareRuntimeBinding,
} from './model'
import {
  authenticateExecutionPrepareDiscovery,
  makeExecutionPrepareReceipt,
  validateExecutionCandidateSet,
  validateExecutionPrepareInput,
  type PrevalidatedExecutionPrepareInput,
  type ValidatedExecutionPrepareInput,
} from './validation'

const fail = <A>(failure: ExecutionPrepareFailure): Result.Result<A, ExecutionPrepareFailure> => Result.fail(failure)

const runtimeMismatch = <A>(
  field: Extract<ExecutionPrepareFailure, { readonly _tag: 'ExecutionPrepareRuntimeMismatch' }>['field'],
) => fail<A>({ _tag: 'ExecutionPrepareRuntimeMismatch', field })

const discoveryMismatch = <A>(
  field: Extract<ExecutionPrepareFailure, { readonly _tag: 'ExecutionPrepareDiscoveryMismatch' }>['field'],
) => fail<A>({ _tag: 'ExecutionPrepareDiscoveryMismatch', field })

export interface ExecutionPrepareProofPlanRequestInput {
  readonly request: ExecutionPrepareRequest
  readonly qualification: QualificationRecord
  readonly runtime: ExecutionPrepareRuntimeBinding
}

const matchesStrategy = (
  left: ExecutionPrepareRuntimeBinding['strategy'],
  right: ExecutionPrepareRuntimeBinding['strategy'],
): boolean =>
  left.name === right.name &&
  left.behaviorHash === right.behaviorHash &&
  left.parameterHash === right.parameterHash &&
  left.parameterSchemaVersion === right.parameterSchemaVersion

export const buildExecutionPrepareProofPlanRequest = (
  input: ExecutionPrepareProofPlanRequestInput,
): Result.Result<ExecutionPrepareProofPlanRequest, ExecutionPrepareFailure> => {
  const { request, qualification, runtime } = input
  if (qualification.state !== 'TERMINAL') return runtimeMismatch('qualificationRunId')

  const terminal = request.qualification
  const { lock, result } = qualification
  if (
    terminal.runId !== lock.candidateRunId ||
    terminal.lockId !== lock.lockId ||
    terminal.resultHash !== result.resultHash ||
    result.runId !== terminal.runId ||
    result.lockId !== terminal.lockId ||
    result.verdict !== 'QUALIFIED'
  ) {
    return runtimeMismatch('qualificationRunId')
  }
  if (terminal.sourceRevision !== lock.sourceRevision) return runtimeMismatch('activationSourceRevision')
  if (terminal.imageRepository !== lock.image.repository || terminal.imageDigest !== lock.image.digest) {
    return runtimeMismatch('activationImageDigest')
  }
  if (runtime.qualificationRunId !== terminal.runId) return runtimeMismatch('qualificationRunId')

  const discovery = request.discoveryReceipt
  const discoveryRuntime = discovery.binding.runtime
  if (runtime.sourceRevision !== discoveryRuntime.sourceRevision) return discoveryMismatch('sourceRevision')
  if (runtime.imageRepository !== discoveryRuntime.image.repository) return discoveryMismatch('imageRepository')
  if (runtime.imageDigest !== discoveryRuntime.image.digest) return discoveryMismatch('imageDigest')
  const strategy = {
    name: discoveryRuntime.strategy.name,
    behaviorHash: discoveryRuntime.strategy.behaviorHash,
    parameterHash: discoveryRuntime.strategy.parameterHash,
    parameterSchemaVersion: discoveryRuntime.strategy.parameterSchemaVersion,
  }
  if (!matchesStrategy(runtime.strategy, strategy)) return discoveryMismatch('strategyBehaviorHash')
  if (runtime.strategyProtocolHash !== discoveryRuntime.strategyProtocolHash) {
    return discoveryMismatch('strategyProtocolHash')
  }
  if (runtime.qualificationRunId !== discoveryRuntime.qualificationRunId) {
    return discoveryMismatch('qualificationRunId')
  }
  if (runtime.accountId !== discoveryRuntime.accountId || runtime.accountId !== discovery.candidateFacts.account.id) {
    return discoveryMismatch('accountId')
  }
  if (runtime.authorityGenerationHash !== discoveryRuntime.authorityGenerationHash) {
    return discoveryMismatch('authorityGenerationHash')
  }
  if (
    runtime.riskPolicyHash !== discoveryRuntime.policyHash ||
    runtime.riskPolicyHash !== discovery.binding.document.policyHash
  ) {
    return discoveryMismatch('riskPolicyHash')
  }
  if (discovery.binding.document.reconciliationId.length === 0) return discoveryMismatch('reconciliationId')
  if (discovery.binding.document.reconciliationHash.length === 0) return discoveryMismatch('reconciliationContentHash')

  const candidateSetValidation = validateExecutionCandidateSet(discovery)
  if (Result.isFailure(candidateSetValidation)) return Result.fail(candidateSetValidation.failure)

  const proofPlan = {
    schemaVersion: 'bayn.execution-prepare-proof-plan.v1' as const,
    candidateSet: {
      discoveryReceiptHash: discovery.observationReceiptHash,
      immutableBindingHash: discovery.immutableBindingHash,
      candidateFactsHash: discovery.candidateFactsHash,
      candidateCount: discovery.candidateFacts.candidates.length,
      cycleId: discovery.binding.cycle.cycleId,
      decisionHash: discovery.binding.cycle.decisionHash,
    },
    binding: {
      activationSourceRevision: runtime.sourceRevision,
      activationImageRepository: runtime.imageRepository,
      activationImageDigest: runtime.imageDigest,
      qualificationSourceRevision: lock.sourceRevision,
      qualificationImageRepository: lock.image.repository,
      qualificationImageDigest: lock.image.digest,
      strategy,
      strategyProtocolHash: discoveryRuntime.strategyProtocolHash,
      qualificationRunId: terminal.runId,
      qualificationLockId: terminal.lockId,
      qualificationResultHash: terminal.resultHash,
      protocolHash: lock.protocolHash,
      qualificationExecutionPolicyHash: lock.policies.execution.contentHash,
      accountId: runtime.accountId,
      brokerIdentityHash: runtime.brokerIdentityHash,
      authorityGenerationHash: runtime.authorityGenerationHash,
      riskPolicyHash: runtime.riskPolicyHash,
      reconciliationId: discovery.binding.document.reconciliationId,
      reconciliationContentHash: discovery.binding.document.reconciliationHash,
    },
  }
  const proofPlanHash = canonicalHashV1Result(proofPlan)
  if (Result.isFailure(proofPlanHash)) {
    return fail({ _tag: 'ExecutionPrepareProofPlanHashFailed', cause: proofPlanHash.failure })
  }
  return Result.succeed({
    schemaVersion: 'bayn.execution-prepare-request.v1',
    discoveryReceipt: discovery,
    proofPlan,
    proofPlanHash: proofPlanHash.success,
  })
}

export const prepareValidatedExecutionWithGeneration = (
  validated: ValidatedExecutionPrepareInput,
): Effect.Effect<
  {
    readonly generation: CapitalGrantGeneration
    readonly receipt: ExecutionPrepareReceipt
  },
  ExecutionPrepareFailure,
  CapitalGrantLifecycleStore
> =>
  Effect.gen(function* () {
    const lifecycle = yield* CapitalGrantLifecycleStore
    const generation = yield* lifecycle.prepareCapitalGrant(validated.proof).pipe(
      Effect.mapError(
        (cause): ExecutionPrepareFailure => ({
          _tag: 'ExecutionPrepareStoreRejected',
          operation: cause.operation,
          failure: cause.failure,
          cause,
        }),
      ),
    )
    const receipt = makeExecutionPrepareReceipt(validated, generation)
    if (Result.isFailure(receipt)) return yield* Effect.fail(receipt.failure)
    return { generation, receipt: receipt.success }
  })

export const prepareValidatedExecution = (
  validated: ValidatedExecutionPrepareInput,
): Effect.Effect<ExecutionPrepareReceipt, ExecutionPrepareFailure, CapitalGrantLifecycleStore> =>
  prepareValidatedExecutionWithGeneration(validated).pipe(Effect.map(({ receipt }) => receipt))

export const prepareExecution = (
  request: unknown,
  runtime: unknown,
  trustedDiscoveryReceipt: ExecutionCandidateDiscoveryReceipt,
): Effect.Effect<ExecutionPrepareReceipt, ExecutionPrepareFailure, CapitalGrantLifecycleStore> =>
  Effect.gen(function* () {
    const prevalidated = yield* Effect.fromResult(validateExecutionPrepareInput(request, runtime))
    const validated = yield* Effect.fromResult(
      authenticateExecutionPrepareDiscovery(prevalidated, trustedDiscoveryReceipt),
    )
    return yield* prepareValidatedExecution(validated)
  })

export const authenticateValidatedExecutionPrepare = (
  prevalidated: PrevalidatedExecutionPrepareInput,
  trustedDiscoveryReceipt: ExecutionCandidateDiscoveryReceipt,
): Effect.Effect<ValidatedExecutionPrepareInput, ExecutionPrepareFailure> =>
  Effect.fromResult(authenticateExecutionPrepareDiscovery(prevalidated, trustedDiscoveryReceipt))
