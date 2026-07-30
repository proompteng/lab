import { pipe, Result, Schema } from 'effect'

import { BrokerEnvironment, BrokerProvider } from '../broker/identity'
import type { CapitalGrantGeneration, CapitalGrantProofBinding } from '../execution/contracts'
import { Authority } from '../execution/contracts'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import { canonicalHashV1Result } from '../hash'
import {
  decodeExecutionPrepareReceiptResult,
  decodeExecutionPrepareRequestResult,
  ExecutionPrepareRuntimeBindingSchema,
  type ExecutionPrepareReceipt,
  type ExecutionPrepareRequest,
  type ExecutionPrepareRuntimeBinding,
} from './model'
import type { ExecutionPrepareFailure, ExecutionPrepareGenerationField, ExecutionPrepareRuntimeField } from './failure'

export interface ValidatedExecutionPrepareInput {
  readonly request: ExecutionPrepareRequest
  readonly runtime: ExecutionPrepareRuntimeBinding
  readonly proof: CapitalGrantProofBinding
}

const fail = <A>(failure: ExecutionPrepareFailure): Result.Result<A, ExecutionPrepareFailure> => Result.fail(failure)

const runtimeMismatch = <A>(field: ExecutionPrepareRuntimeField): Result.Result<A, ExecutionPrepareFailure> =>
  fail({ _tag: 'ExecutionPrepareRuntimeMismatch', field })

const generationMismatch = <A>(field: ExecutionPrepareGenerationField): Result.Result<A, ExecutionPrepareFailure> =>
  fail({ _tag: 'ExecutionPrepareGenerationMismatch', field })

const validateRuntimeAgainstProof = (
  request: ExecutionPrepareRequest,
  runtime: ExecutionPrepareRuntimeBinding,
): Result.Result<void, ExecutionPrepareFailure> => {
  const binding = request.proofPlan.binding
  if (runtime.brokerProvider !== BrokerProvider.Alpaca) return runtimeMismatch('brokerProvider')
  if (runtime.brokerEnvironment !== BrokerEnvironment.Sandbox) return runtimeMismatch('brokerEnvironment')
  if (runtime.brokerAccess !== BrokerAccess.ReadOnly) return runtimeMismatch('brokerAccess')
  if (runtime.capitalAuthority !== CapitalAuthorityKind.None) return runtimeMismatch('capitalAuthority')
  if (binding.activationSourceRevision !== runtime.sourceRevision) return runtimeMismatch('activationSourceRevision')
  if (binding.activationImageRepository !== runtime.imageRepository) return runtimeMismatch('activationImageRepository')
  if (binding.activationImageDigest !== runtime.imageDigest) return runtimeMismatch('activationImageDigest')
  if (binding.strategy.name !== runtime.strategy.name) return runtimeMismatch('strategyName')
  if (binding.strategy.behaviorHash !== runtime.strategy.behaviorHash) return runtimeMismatch('strategyBehaviorHash')
  if (binding.strategy.parameterHash !== runtime.strategy.parameterHash) return runtimeMismatch('strategyParameterHash')
  if (binding.strategy.parameterSchemaVersion !== runtime.strategy.parameterSchemaVersion) {
    return runtimeMismatch('strategyParameterSchemaVersion')
  }
  if (binding.strategyProtocolHash !== runtime.strategyProtocolHash) return runtimeMismatch('strategyProtocolHash')
  if (binding.qualificationRunId !== runtime.qualificationRunId) return runtimeMismatch('qualificationRunId')
  if (binding.accountId !== runtime.accountId) return runtimeMismatch('accountId')
  if (binding.brokerIdentityHash !== runtime.brokerIdentityHash) return runtimeMismatch('brokerIdentity')
  if (binding.authorityGenerationHash !== runtime.authorityGenerationHash) {
    return runtimeMismatch('authorityGenerationHash')
  }
  return binding.riskPolicyHash === runtime.riskPolicyHash
    ? Result.succeed(undefined)
    : runtimeMismatch('riskPolicyHash')
}

export const validateExecutionPrepareInput = (
  candidate: unknown,
  runtimeCandidate: unknown,
): Result.Result<ValidatedExecutionPrepareInput, ExecutionPrepareFailure> => {
  const decodedRequest = decodeExecutionPrepareRequestResult(candidate)
  if (Result.isFailure(decodedRequest)) {
    return fail({ _tag: 'ExecutionPrepareRequestInvalid', cause: decodedRequest.failure })
  }
  const decodedRuntime = Schema.decodeUnknownResult(ExecutionPrepareRuntimeBindingSchema, {
    onExcessProperty: 'error',
  })(runtimeCandidate)
  if (Result.isFailure(decodedRuntime)) {
    return fail({ _tag: 'ExecutionPrepareRuntimeBindingInvalid', cause: decodedRuntime.failure })
  }
  const request = decodedRequest.success
  const runtime = decodedRuntime.success
  const runtimeValidation = validateRuntimeAgainstProof(request, runtime)
  if (Result.isFailure(runtimeValidation)) return Result.fail(runtimeValidation.failure)
  const proofPlanHash = canonicalHashV1Result(request.proofPlan)
  if (Result.isFailure(proofPlanHash)) {
    return fail({ _tag: 'ExecutionPrepareProofPlanHashFailed', cause: proofPlanHash.failure })
  }
  if (proofPlanHash.success !== request.proofPlanHash) {
    return fail({ _tag: 'ExecutionPrepareProofPlanHashMismatch' })
  }
  return Result.succeed({
    request,
    runtime,
    proof: {
      schemaVersion: 'bayn.paper-authority-proof-binding.v1',
      riskPolicyHash: runtime.riskPolicyHash,
      proofPlanHash: request.proofPlanHash,
    },
  })
}

const equalGenerationBinding = (
  generation: CapitalGrantGeneration,
  input: ValidatedExecutionPrepareInput,
): Result.Result<void, ExecutionPrepareFailure> => {
  const binding = input.request.proofPlan.binding
  if (generation.maximum !== Authority.Paper) return generationMismatch('maximum')
  if (generation.previousGenerationHash !== binding.authorityGenerationHash) {
    return generationMismatch('previousGenerationHash')
  }
  if (generation.qualificationRunId !== binding.qualificationRunId) return generationMismatch('qualificationRunId')
  if (generation.qualificationLockId !== binding.qualificationLockId) return generationMismatch('qualificationLockId')
  if (generation.qualificationResultHash !== binding.qualificationResultHash) {
    return generationMismatch('qualificationResultHash')
  }
  if (generation.protocolHash !== binding.protocolHash) return generationMismatch('protocolHash')
  if (generation.qualificationExecutionPolicyHash !== binding.qualificationExecutionPolicyHash) {
    return generationMismatch('qualificationExecutionPolicyHash')
  }
  if (generation.qualificationSourceRevision !== binding.qualificationSourceRevision) {
    return generationMismatch('qualificationSourceRevision')
  }
  if (generation.qualificationImageRepository !== binding.qualificationImageRepository) {
    return generationMismatch('qualificationImageRepository')
  }
  if (generation.qualificationImageDigest !== binding.qualificationImageDigest) {
    return generationMismatch('qualificationImageDigest')
  }
  if (generation.activationSourceRevision !== binding.activationSourceRevision) {
    return generationMismatch('activationSourceRevision')
  }
  if (generation.activationImageRepository !== binding.activationImageRepository) {
    return generationMismatch('activationImageRepository')
  }
  if (generation.activationImageDigest !== binding.activationImageDigest) {
    return generationMismatch('activationImageDigest')
  }
  if (generation.strategyName !== binding.strategy.name) return generationMismatch('strategyName')
  if (generation.strategyBehaviorHash !== binding.strategy.behaviorHash) {
    return generationMismatch('strategyBehaviorHash')
  }
  if (generation.strategyParameterHash !== binding.strategy.parameterHash) {
    return generationMismatch('strategyParameterHash')
  }
  if (generation.strategyParameterSchemaVersion !== binding.strategy.parameterSchemaVersion) {
    return generationMismatch('strategyParameterSchemaVersion')
  }
  if (generation.accountId !== binding.accountId) return generationMismatch('accountId')
  if (generation.riskPolicyHash !== binding.riskPolicyHash) return generationMismatch('riskPolicyHash')
  if (generation.proofPlanHash !== input.request.proofPlanHash) return generationMismatch('proofPlanHash')
  if (generation.reconciliationId !== binding.reconciliationId) return generationMismatch('reconciliationId')
  return generation.reconciliationContentHash === binding.reconciliationContentHash
    ? Result.succeed(undefined)
    : generationMismatch('reconciliationContentHash')
}

export const makeExecutionPrepareReceipt = (
  input: ValidatedExecutionPrepareInput,
  generation: CapitalGrantGeneration,
): Result.Result<ExecutionPrepareReceipt, ExecutionPrepareFailure> => {
  const exact = equalGenerationBinding(generation, input)
  if (Result.isFailure(exact)) return Result.fail(exact.failure)
  const binding = input.request.proofPlan.binding
  const material = {
    schemaVersion: 'bayn.execution-prepare-receipt.v1' as const,
    operation: 'EXECUTION_PREPARE' as const,
    dispatchable: false as const,
    authority: { maximum: Authority.Observe, effective: Authority.Observe, activated: false as const },
    broker: {
      identityHash: input.runtime.brokerIdentityHash,
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      access: BrokerAccess.ReadOnly,
    },
    candidate: input.request.proofPlan.candidate,
    qualification: {
      runId: generation.qualificationRunId,
      lockId: generation.qualificationLockId,
      resultHash: generation.qualificationResultHash,
      protocolHash: generation.protocolHash,
      executionPolicyHash: generation.qualificationExecutionPolicyHash,
    },
    strategy: binding.strategy,
    generation: {
      generationHash: generation.generationHash,
      previousGenerationHash: generation.previousGenerationHash,
      riskPolicyHash: generation.riskPolicyHash,
      proofPlanHash: generation.proofPlanHash,
    },
    reconciliation: {
      reconciliationId: generation.reconciliationId,
      contentHash: generation.reconciliationContentHash,
    },
    dryRunSubmit: { included: false as const, reason: 'MUTATION_AUTHORITY_REQUIRED' as const },
  }
  const receiptHash = canonicalHashV1Result(material)
  if (Result.isFailure(receiptHash)) {
    return fail({ _tag: 'ExecutionPrepareReceiptHashFailed', cause: receiptHash.failure })
  }
  return pipe(
    decodeExecutionPrepareReceiptResult({ ...material, receiptHash: receiptHash.success }),
    Result.mapError((cause): ExecutionPrepareFailure => ({ _tag: 'ExecutionPrepareReceiptInvalid', cause })),
  )
}
