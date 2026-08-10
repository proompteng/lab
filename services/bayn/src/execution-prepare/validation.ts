import { pipe, Result, Schema } from 'effect'

import { BrokerEnvironment, BrokerProvider } from '../broker/identity'
import type { CapitalGrantGeneration, CapitalGrantProofBinding } from '../execution/contracts'
import { Authority } from '../execution/contracts'
import type { ExecutionCandidateDiscoveryReceipt } from '../execution-candidate-discovery/model'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import { canonicalHashV1Result } from '../hash'
import {
  decodeExecutionPrepareReceiptResult,
  decodeExecutionPrepareProofPlanRequestResult,
  type ExecutionPrepareProofPlan,
  type ExecutionPrepareProofPlanRequest,
  ExecutionPrepareRuntimeBindingSchema,
  type ExecutionPrepareReceipt,
  type ExecutionPrepareRuntimeBinding,
} from './model'
import type {
  ExecutionPrepareDiscoveryField,
  ExecutionPrepareFailure,
  ExecutionPrepareGenerationField,
  ExecutionPrepareRuntimeField,
} from './failure'
import { Pipeable } from '../pipeable'

export interface PrevalidatedExecutionPrepareInput {
  readonly request: ExecutionPrepareProofPlanRequest
  readonly runtime: ExecutionPrepareRuntimeBinding
}

export interface ValidatedExecutionPrepareInput extends PrevalidatedExecutionPrepareInput {
  readonly proofPlan: ExecutionPrepareProofPlan
  readonly proofPlanHash: string
  readonly proof: CapitalGrantProofBinding
}

const fail = <A>(failure: ExecutionPrepareFailure): Result.Result<A, ExecutionPrepareFailure> => Result.fail(failure)

const runtimeMismatch = <A>(field: ExecutionPrepareRuntimeField): Result.Result<A, ExecutionPrepareFailure> =>
  fail({ _tag: 'ExecutionPrepareRuntimeMismatch', field })

const generationMismatch = <A>(field: ExecutionPrepareGenerationField): Result.Result<A, ExecutionPrepareFailure> =>
  fail({ _tag: 'ExecutionPrepareGenerationMismatch', field })

const discoveryMismatch = <A>(field: ExecutionPrepareDiscoveryField): Result.Result<A, ExecutionPrepareFailure> =>
  fail({ _tag: 'ExecutionPrepareDiscoveryMismatch', field })

const discoveryReceiptMaterial = (receipt: ExecutionCandidateDiscoveryReceipt) => {
  const { observationReceiptHash: _observationReceiptHash, ...material } = receipt
  return material
}

const validateDiscoveryReceiptHashes = (
  receipt: ExecutionCandidateDiscoveryReceipt,
): Result.Result<void, ExecutionPrepareFailure> => {
  const observationReceiptHash = canonicalHashV1Result(discoveryReceiptMaterial(receipt))
  if (Result.isFailure(observationReceiptHash)) {
    return fail({ _tag: 'ExecutionPrepareDiscoveryHashFailed', cause: observationReceiptHash.failure })
  }
  if (observationReceiptHash.success !== receipt.observationReceiptHash) {
    return discoveryMismatch('observationReceiptHash')
  }

  const immutableBindingHash = canonicalHashV1Result(receipt.binding)
  if (Result.isFailure(immutableBindingHash)) {
    return fail({ _tag: 'ExecutionPrepareDiscoveryHashFailed', cause: immutableBindingHash.failure })
  }
  if (
    immutableBindingHash.success !== receipt.immutableBindingHash ||
    immutableBindingHash.success !== receipt.candidateFacts.immutableBindingHash
  ) {
    return discoveryMismatch('immutableBindingHash')
  }

  const candidateFactsHash = canonicalHashV1Result(receipt.candidateFacts)
  if (Result.isFailure(candidateFactsHash)) {
    return fail({ _tag: 'ExecutionPrepareDiscoveryHashFailed', cause: candidateFactsHash.failure })
  }
  if (candidateFactsHash.success !== receipt.candidateFactsHash) return discoveryMismatch('candidateFactsHash')

  return Result.succeed(undefined)
}

const validateReceiptBinding = (
  receipt: ExecutionCandidateDiscoveryReceipt,
  binding: ExecutionPrepareProofPlan['binding'],
): Result.Result<void, ExecutionPrepareFailure> => {
  const runtime = receipt.binding.runtime
  if (runtime.sourceRevision !== binding.activationSourceRevision) return discoveryMismatch('sourceRevision')
  if (runtime.image.repository !== binding.activationImageRepository) return discoveryMismatch('imageRepository')
  if (runtime.image.digest !== binding.activationImageDigest) return discoveryMismatch('imageDigest')
  if (runtime.strategy.name !== binding.strategy.name) return discoveryMismatch('strategyName')
  if (runtime.strategy.behaviorHash !== binding.strategy.behaviorHash) {
    return discoveryMismatch('strategyBehaviorHash')
  }
  if (runtime.strategy.parameterHash !== binding.strategy.parameterHash) {
    return discoveryMismatch('strategyParameterHash')
  }
  if (runtime.strategy.parameterSchemaVersion !== binding.strategy.parameterSchemaVersion) {
    return discoveryMismatch('strategyParameterSchemaVersion')
  }
  if (runtime.strategyProtocolHash !== binding.strategyProtocolHash) return discoveryMismatch('strategyProtocolHash')
  if (runtime.qualificationRunId !== binding.qualificationRunId) return discoveryMismatch('qualificationRunId')
  if (runtime.accountId !== binding.accountId || receipt.candidateFacts.account.id !== binding.accountId) {
    return discoveryMismatch('accountId')
  }
  if (runtime.authorityGenerationHash !== binding.authorityGenerationHash) {
    return discoveryMismatch('authorityGenerationHash')
  }
  if (runtime.policyHash !== binding.riskPolicyHash || receipt.binding.document.policyHash !== binding.riskPolicyHash) {
    return discoveryMismatch('riskPolicyHash')
  }
  if (receipt.binding.document.reconciliationId !== binding.reconciliationId) {
    return discoveryMismatch('reconciliationId')
  }
  return receipt.binding.document.reconciliationHash === binding.reconciliationContentHash
    ? Result.succeed(undefined)
    : discoveryMismatch('reconciliationContentHash')
}

const validateCandidateEligibility = (
  candidate: ExecutionCandidateDiscoveryReceipt['candidateFacts']['candidates'][number],
): Result.Result<void, ExecutionPrepareFailure> => {
  if (!candidate.assetEligibility.eligible) return discoveryMismatch('candidateSetEligibility')
  const fractionalQuantity = !candidate.observedPlannedQuantityMicros.padStart(7, '0').endsWith('000000')
  return fractionalQuantity && !candidate.fractionalTradingEligible
    ? discoveryMismatch('candidateSetEligibility')
    : Result.succeed(undefined)
}

export const validateExecutionCandidateSet = (
  receipt: ExecutionCandidateDiscoveryReceipt,
): Result.Result<void, ExecutionPrepareFailure> => {
  if (receipt.candidateFacts.candidates.length === 0) return discoveryMismatch('candidateSet')
  for (const candidate of receipt.candidateFacts.candidates) {
    const eligibility = validateCandidateEligibility(candidate)
    if (Result.isFailure(eligibility)) return Result.fail(eligibility.failure)
  }
  return Result.succeed(undefined)
}

const validateCandidateSetClaim = (
  receipt: ExecutionCandidateDiscoveryReceipt,
  candidateBinding: ExecutionPrepareProofPlan['candidateSet'],
  requireObservationReceiptHash: boolean,
): Result.Result<void, ExecutionPrepareFailure> => {
  if (receipt.candidateFacts.candidates.length === 0) return discoveryMismatch('candidateSet')
  if (requireObservationReceiptHash && candidateBinding.discoveryReceiptHash !== receipt.observationReceiptHash) {
    return discoveryMismatch('observationReceiptHash')
  }
  if (candidateBinding.immutableBindingHash !== receipt.immutableBindingHash) {
    return discoveryMismatch('immutableBindingHash')
  }
  if (candidateBinding.candidateFactsHash !== receipt.candidateFactsHash) {
    return discoveryMismatch('candidateFactsHash')
  }
  if (candidateBinding.candidateCount !== receipt.candidateFacts.candidates.length)
    return discoveryMismatch('candidateSetCount')
  if (candidateBinding.cycleId !== receipt.binding.cycle.cycleId) return discoveryMismatch('cycleId')
  if (candidateBinding.decisionHash !== receipt.binding.cycle.decisionHash) return discoveryMismatch('decisionHash')

  return Result.succeed(undefined)
}

const authenticateDiscoveryReceipt = (
  request: ExecutionPrepareProofPlanRequest,
): Result.Result<void, ExecutionPrepareFailure> => {
  const hashes = validateDiscoveryReceiptHashes(request.discoveryReceipt)
  if (Result.isFailure(hashes)) return Result.fail(hashes.failure)
  const candidateSet = validateCandidateSetClaim(request.discoveryReceipt, request.proofPlan.candidateSet, true)
  if (Result.isFailure(candidateSet)) return Result.fail(candidateSet.failure)
  const binding = validateReceiptBinding(request.discoveryReceipt, request.proofPlan.binding)
  if (Result.isFailure(binding)) return Result.fail(binding.failure)
  return validateExecutionCandidateSet(request.discoveryReceipt)
}

const validateRuntimeAgainstProof = (
  request: ExecutionPrepareProofPlanRequest,
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

const validateExecutionPrepareInputDataFirst = (
  candidate: unknown,
  runtimeCandidate: unknown,
): Result.Result<PrevalidatedExecutionPrepareInput, ExecutionPrepareFailure> => {
  const decodedRequest = decodeExecutionPrepareProofPlanRequestResult(candidate)
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
  const discoveryValidation = authenticateDiscoveryReceipt(request)
  if (Result.isFailure(discoveryValidation)) return Result.fail(discoveryValidation.failure)
  const runtimeValidation = validateRuntimeAgainstProof(request, runtime)
  if (Result.isFailure(runtimeValidation)) return Result.fail(runtimeValidation.failure)
  const proofPlanHash = canonicalHashV1Result(request.proofPlan)
  if (Result.isFailure(proofPlanHash)) {
    return fail({ _tag: 'ExecutionPrepareProofPlanHashFailed', cause: proofPlanHash.failure })
  }
  if (proofPlanHash.success !== request.proofPlanHash) {
    return fail({ _tag: 'ExecutionPrepareProofPlanHashMismatch' })
  }
  return Result.succeed({ request, runtime })
}

export const validateExecutionPrepareInput = Pipeable.dual(2, validateExecutionPrepareInputDataFirst)

const authenticateExecutionPrepareDiscoveryDataFirst = (
  input: PrevalidatedExecutionPrepareInput,
  trustedReceipt: ExecutionCandidateDiscoveryReceipt,
): Result.Result<ValidatedExecutionPrepareInput, ExecutionPrepareFailure> => {
  const hashes = validateDiscoveryReceiptHashes(trustedReceipt)
  if (Result.isFailure(hashes)) return Result.fail(hashes.failure)
  if (trustedReceipt.immutableBindingHash !== input.request.discoveryReceipt.immutableBindingHash) {
    return discoveryMismatch('immutableBindingHash')
  }
  if (trustedReceipt.candidateFactsHash !== input.request.discoveryReceipt.candidateFactsHash) {
    return discoveryMismatch('candidateFactsHash')
  }
  const binding = validateReceiptBinding(trustedReceipt, input.request.proofPlan.binding)
  if (Result.isFailure(binding)) return Result.fail(binding.failure)
  const requestedCandidateSet = input.request.proofPlan.candidateSet
  const candidateClaim = validateCandidateSetClaim(trustedReceipt, requestedCandidateSet, false)
  if (Result.isFailure(candidateClaim)) return Result.fail(candidateClaim.failure)
  const eligibility = validateExecutionCandidateSet(trustedReceipt)
  if (Result.isFailure(eligibility)) return Result.fail(eligibility.failure)
  return Result.succeed({
    ...input,
    proofPlan: input.request.proofPlan,
    proofPlanHash: input.request.proofPlanHash,
    proof: {
      schemaVersion: 'bayn.paper-authority-proof-binding.v1',
      riskPolicyHash: input.runtime.riskPolicyHash,
      proofPlanHash: input.request.proofPlanHash,
    },
  })
}

export const authenticateExecutionPrepareDiscovery = Pipeable.dual(2, authenticateExecutionPrepareDiscoveryDataFirst)

const equalGenerationBinding = (
  generation: CapitalGrantGeneration,
  input: ValidatedExecutionPrepareInput,
): Result.Result<void, ExecutionPrepareFailure> => {
  const binding = input.proofPlan.binding
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
  if (generation.proofPlanHash !== input.proofPlanHash) return generationMismatch('proofPlanHash')
  if (generation.reconciliationId !== binding.reconciliationId) return generationMismatch('reconciliationId')
  return generation.reconciliationContentHash === binding.reconciliationContentHash
    ? Result.succeed(undefined)
    : generationMismatch('reconciliationContentHash')
}

const makeExecutionPrepareReceiptDataFirst = (
  input: ValidatedExecutionPrepareInput,
  generation: CapitalGrantGeneration,
): Result.Result<ExecutionPrepareReceipt, ExecutionPrepareFailure> => {
  const exact = equalGenerationBinding(generation, input)
  if (Result.isFailure(exact)) return Result.fail(exact.failure)
  const binding = input.proofPlan.binding
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
    candidateSet: input.proofPlan.candidateSet,
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

export const makeExecutionPrepareReceipt = Pipeable.dual(2, makeExecutionPrepareReceiptDataFirst)
