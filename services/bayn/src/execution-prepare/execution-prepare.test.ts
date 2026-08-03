import { describe, expect, test } from 'bun:test'

import { Effect, Result } from 'effect'

import { pinnedLock, pinnedQualification } from '../app-test-support'
import { BrokerEnvironment, BrokerProvider } from '../broker/identity'
import {
  CapitalGrantLifecycleStore,
  ExecutionStoreError,
  type CapitalGrantLifecycleStoreShape,
} from '../db/execution-store'
import { validateDerivedPaperGeneration } from '../db/capital-grant-algebra'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import { Authority, makeCapitalGrantGenerationResult, type CapitalGrantGeneration } from '../execution/contracts'
import { WriterFence, type WriterFenceService } from '../execution/writer-fence'
import { canonicalHashV1OrThrow, sha256 } from '../hash'
import { renderExecutionPrepareFailure } from './failure'
import type { ExecutionPrepareGenerationField } from './failure'
import {
  PaperCandidateIneligibility,
  type ExecutionCandidateDiscoveryReceipt,
} from '../execution-candidate-discovery/model'
import type { ExecutionPrepareProofPlanRequest, ExecutionPrepareRuntimeBinding } from './model'
import {
  buildExecutionPrepareProofPlanRequest,
  prepareExecution,
  prepareValidatedExecutionWithGeneration,
} from './program'
import { makeExecutionPrepareDiscoveryReceiptFixture } from './test-fixture'
import {
  authenticateExecutionPrepareDiscovery,
  makeExecutionPrepareReceipt,
  validateExecutionPrepareInput,
} from './validation'

type ExecutionPrepareRequest = ExecutionPrepareProofPlanRequest

const hash = (label: string): string => sha256(`execution-prepare:${label}`)
const sourceRevision = 'a'.repeat(40)
const qualificationSourceRevision = 'b'.repeat(40)
const imageRepository = 'registry.test/lab/bayn'
const imageDigest = `sha256:${'c'.repeat(64)}`
const qualificationImageDigest = `sha256:${'d'.repeat(64)}`
const accountId = 'acct-sensitive-0011223344'

const strategy = {
  name: 'risk-balanced-trend' as const,
  behaviorHash: hash('behavior'),
  parameterHash: hash('parameters'),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4' as const,
}
const strategyProtocolHash = hash('strategy-protocol')
const qualificationRunId = hash('qualification-run')
const authorityGenerationHash = hash('observe-generation')
const riskPolicyHash = hash('risk-policy')
const reconciliationId = hash('reconciliation')
const reconciliationContentHash = hash('reconciliation-content')
const discoveryReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
  sourceRevision,
  imageRepository,
  imageDigest,
  strategy,
  strategyProtocolHash,
  qualificationRunId,
  accountId,
  authorityGenerationHash,
  policyHash: riskPolicyHash,
  reconciliationId,
  reconciliationContentHash,
})
const discoveredCandidate = discoveryReceipt.candidateFacts.candidates[0]!

const receiptWithCandidates = (
  receipt: ExecutionCandidateDiscoveryReceipt,
  candidates: readonly ExecutionCandidateDiscoveryReceipt['candidateFacts']['candidates'][number][],
): ExecutionCandidateDiscoveryReceipt => {
  const candidateFacts = { ...receipt.candidateFacts, candidates }
  const candidateFactsHash = canonicalHashV1OrThrow(candidateFacts)
  const material = { ...receipt, candidateFacts, candidateFactsHash }
  const { observationReceiptHash: _observationReceiptHash, ...withoutObservationHash } = material
  return { ...material, observationReceiptHash: canonicalHashV1OrThrow(withoutObservationHash) }
}

const proofPlan = {
  schemaVersion: 'bayn.execution-prepare-proof-plan.v1' as const,
  candidateSet: {
    discoveryReceiptHash: discoveryReceipt.observationReceiptHash,
    immutableBindingHash: discoveryReceipt.immutableBindingHash,
    candidateFactsHash: discoveryReceipt.candidateFactsHash,
    candidateCount: discoveryReceipt.candidateFacts.candidates.length,
    cycleId: discoveryReceipt.binding.cycle.cycleId,
    decisionHash: discoveryReceipt.binding.cycle.decisionHash,
  },
  binding: {
    activationSourceRevision: sourceRevision,
    activationImageRepository: imageRepository,
    activationImageDigest: imageDigest,
    qualificationSourceRevision,
    qualificationImageRepository: imageRepository,
    qualificationImageDigest,
    strategy,
    strategyProtocolHash,
    qualificationRunId,
    qualificationLockId: hash('qualification-lock'),
    qualificationResultHash: hash('qualification-result'),
    protocolHash: hash('protocol'),
    qualificationExecutionPolicyHash: hash('qualification-execution-policy'),
    accountId,
    brokerIdentityHash: hash('broker-identity'),
    authorityGenerationHash,
    riskPolicyHash,
    reconciliationId,
    reconciliationContentHash,
  },
}

const request: ExecutionPrepareRequest = {
  schemaVersion: 'bayn.execution-prepare-request.v1',
  discoveryReceipt,
  proofPlan,
  proofPlanHash: canonicalHashV1OrThrow(proofPlan),
}

const requestForDiscoveryReceipt = (receipt: ExecutionPrepareRequest['discoveryReceipt']): ExecutionPrepareRequest => {
  const changedProofPlan = {
    ...proofPlan,
    candidateSet: {
      discoveryReceiptHash: receipt.observationReceiptHash,
      immutableBindingHash: receipt.immutableBindingHash,
      candidateFactsHash: receipt.candidateFactsHash,
      candidateCount: receipt.candidateFacts.candidates.length,
      cycleId: receipt.binding.cycle.cycleId,
      decisionHash: receipt.binding.cycle.decisionHash,
    },
  }
  return {
    schemaVersion: 'bayn.execution-prepare-request.v1',
    discoveryReceipt: receipt,
    proofPlan: changedProofPlan,
    proofPlanHash: canonicalHashV1OrThrow(changedProofPlan),
  }
}

const runtime: ExecutionPrepareRuntimeBinding = {
  sourceRevision,
  imageRepository,
  imageDigest,
  strategy,
  strategyProtocolHash: proofPlan.binding.strategyProtocolHash,
  qualificationRunId: proofPlan.binding.qualificationRunId,
  accountId,
  brokerIdentityHash: proofPlan.binding.brokerIdentityHash,
  brokerProvider: BrokerProvider.Alpaca,
  brokerEnvironment: BrokerEnvironment.Sandbox,
  brokerAccess: BrokerAccess.ReadOnly,
  capitalAuthority: CapitalAuthorityKind.None,
  authorityGenerationHash: proofPlan.binding.authorityGenerationHash,
  riskPolicyHash: proofPlan.binding.riskPolicyHash,
}

const generation = (): CapitalGrantGeneration =>
  Result.getOrThrow(
    makeCapitalGrantGenerationResult({
      schemaVersion: 'bayn.paper-authority-generation.v2',
      maximum: Authority.Paper,
      previousGenerationHash: proofPlan.binding.authorityGenerationHash,
      qualificationRunId: proofPlan.binding.qualificationRunId,
      qualificationLockId: proofPlan.binding.qualificationLockId,
      qualificationResultHash: proofPlan.binding.qualificationResultHash,
      protocolHash: proofPlan.binding.protocolHash,
      qualificationExecutionPolicyHash: proofPlan.binding.qualificationExecutionPolicyHash,
      qualificationSourceRevision: proofPlan.binding.qualificationSourceRevision,
      qualificationImageRepository: proofPlan.binding.qualificationImageRepository,
      qualificationImageDigest: proofPlan.binding.qualificationImageDigest,
      activationSourceRevision: proofPlan.binding.activationSourceRevision,
      activationImageRepository: proofPlan.binding.activationImageRepository,
      activationImageDigest: proofPlan.binding.activationImageDigest,
      strategyName: strategy.name,
      strategyBehaviorHash: strategy.behaviorHash,
      strategyParameterHash: strategy.parameterHash,
      strategyParameterSchemaVersion: strategy.parameterSchemaVersion,
      accountId,
      riskPolicyHash: proofPlan.binding.riskPolicyHash,
      proofPlanHash: request.proofPlanHash,
      reconciliationId: proofPlan.binding.reconciliationId,
      reconciliationContentHash: proofPlan.binding.reconciliationContentHash,
    }),
  )

const validated = () =>
  Result.getOrThrow(
    authenticateExecutionPrepareDiscovery(
      Result.getOrThrow(validateExecutionPrepareInput(request, runtime)),
      discoveryReceipt,
    ),
  )

describe('EXECUTION_PREPARE pure validation', () => {
  test('builds the existing proof plan from the terminal binding, captured receipt, and durable qualification', () => {
    const durableQualification = {
      state: 'TERMINAL' as const,
      lock: pinnedLock,
      // The constructor consumes the store's already-audited terminal. The
      // store integration tests cover the canonical result hash and verdict;
      // this unit test supplies the qualified branch to exercise projection.
      result: { ...pinnedQualification, verdict: 'QUALIFIED' as const },
    }
    const riskPolicyHash = pinnedLock.policies.execution.contentHash
    const durableDiscoveryReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
      sourceRevision,
      imageRepository,
      imageDigest,
      strategy,
      strategyProtocolHash,
      qualificationRunId: pinnedQualification.runId,
      accountId,
      authorityGenerationHash,
      policyHash: riskPolicyHash,
      reconciliationId,
      reconciliationContentHash,
    })
    const terminalBinding = {
      runId: pinnedQualification.runId,
      lockId: pinnedLock.lockId,
      resultHash: pinnedQualification.resultHash,
      verdict: 'QUALIFIED' as const,
      sourceRevision: pinnedLock.sourceRevision,
      imageRepository: pinnedLock.image.repository,
      imageDigest: pinnedLock.image.digest,
      candidateOrdinal: 21,
    }
    const runtimeBinding: ExecutionPrepareRuntimeBinding = {
      ...runtime,
      qualificationRunId: pinnedQualification.runId,
      riskPolicyHash,
    }
    const requestInput = {
      schemaVersion: 'bayn.execution-prepare-request.v1' as const,
      qualification: terminalBinding,
      discoveryReceipt: durableDiscoveryReceipt,
    }

    const prepared = Result.getOrThrow(
      buildExecutionPrepareProofPlanRequest({
        request: requestInput,
        qualification: durableQualification,
        runtime: runtimeBinding,
      }),
    )

    expect(prepared.proofPlan.binding).toMatchObject({
      qualificationRunId: pinnedQualification.runId,
      qualificationLockId: pinnedLock.lockId,
      qualificationResultHash: pinnedQualification.resultHash,
      protocolHash: pinnedLock.protocolHash,
      qualificationExecutionPolicyHash: riskPolicyHash,
      qualificationSourceRevision: pinnedLock.sourceRevision,
      qualificationImageRepository: pinnedLock.image.repository,
      qualificationImageDigest: pinnedLock.image.digest,
    })
    expect(prepared.proofPlanHash).toBe(canonicalHashV1OrThrow(prepared.proofPlan))
    expect(
      buildExecutionPrepareProofPlanRequest({
        request: { ...requestInput, qualification: { ...terminalBinding, resultHash: hash('tampered-result') } },
        qualification: durableQualification,
        runtime: runtimeBinding,
      }),
    ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ExecutionPrepareRuntimeMismatch' } })
  })

  test('binds the complete execution candidate set independently of qualification ordinal', () => {
    const pinnedDiscoveryReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
      sourceRevision,
      imageRepository,
      imageDigest,
      strategy,
      strategyProtocolHash,
      qualificationRunId: pinnedQualification.runId,
      accountId,
      authorityGenerationHash,
      policyHash: pinnedLock.policies.execution.contentHash,
      reconciliationId,
      reconciliationContentHash,
    })
    const pinnedCandidate = pinnedDiscoveryReceipt.candidateFacts.candidates[0]
    if (pinnedCandidate === undefined) throw new Error('execution prepare test fixture requires one candidate')
    const secondCandidate = {
      ...pinnedCandidate,
      ordinal: 1,
      observedPlanIntentId: hash('second-execution'),
      symbol: 'QQQ' as const,
      asset: {
        ...pinnedCandidate.asset,
        requestedSymbol: 'QQQ' as const,
        symbol: 'QQQ' as const,
        assetId: 'fixture-qqq-asset',
      },
    }
    const executionCandidateSet = receiptWithCandidates(pinnedDiscoveryReceipt, [pinnedCandidate, secondCandidate])
    const terminalBinding = {
      runId: pinnedQualification.runId,
      lockId: pinnedLock.lockId,
      resultHash: pinnedQualification.resultHash,
      verdict: 'QUALIFIED' as const,
      sourceRevision: pinnedLock.sourceRevision,
      imageRepository: pinnedLock.image.repository,
      imageDigest: pinnedLock.image.digest,
      candidateOrdinal: 21,
    }
    const preparedRuntime = {
      ...runtime,
      qualificationRunId: pinnedQualification.runId,
      riskPolicyHash: pinnedLock.policies.execution.contentHash,
    }
    const build = (discoveryReceipt: ExecutionCandidateDiscoveryReceipt) =>
      buildExecutionPrepareProofPlanRequest({
        request: {
          schemaVersion: 'bayn.execution-prepare-request.v1',
          qualification: terminalBinding,
          discoveryReceipt,
        },
        qualification: {
          state: 'TERMINAL' as const,
          lock: pinnedLock,
          result: { ...pinnedQualification, verdict: 'QUALIFIED' as const },
        },
        runtime: preparedRuntime,
      })

    const prepared = Result.getOrThrow(build(executionCandidateSet))
    expect(prepared.proofPlan.candidateSet).toMatchObject({
      candidateCount: 2,
      candidateFactsHash: executionCandidateSet.candidateFactsHash,
    })
    expect(prepared.proofPlanHash).toBe(canonicalHashV1OrThrow(prepared.proofPlan))

    const empty = receiptWithCandidates(pinnedDiscoveryReceipt, [])
    expect(build(empty)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ExecutionPrepareDiscoveryMismatch', field: 'candidateSet' },
    })

    const ineligibleCandidate = {
      ...pinnedCandidate,
      ordinal: 0,
      observedPlanIntentId: hash('ineligible-execution'),
      assetEligibility: { eligible: false, reasons: [PaperCandidateIneligibility.NotTradable] },
      fractionalTradingEligible: false,
    }
    expect(build(receiptWithCandidates(pinnedDiscoveryReceipt, [ineligibleCandidate, secondCandidate]))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ExecutionPrepareDiscoveryMismatch', field: 'candidateSetEligibility' },
    })

    const reordered = receiptWithCandidates(pinnedDiscoveryReceipt, [secondCandidate, pinnedCandidate])
    const prevalidated = Result.getOrThrow(validateExecutionPrepareInput(prepared, preparedRuntime))
    expect(authenticateExecutionPrepareDiscovery(prevalidated, executionCandidateSet)).toMatchObject({
      _tag: 'Success',
    })
    expect(authenticateExecutionPrepareDiscovery(prevalidated, reordered)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ExecutionPrepareDiscoveryMismatch', field: 'candidateFactsHash' },
    })

    const extraCandidate = { ...secondCandidate, ordinal: 2, observedPlanIntentId: hash('extra-execution') }
    expect(
      authenticateExecutionPrepareDiscovery(
        prevalidated,
        receiptWithCandidates(pinnedDiscoveryReceipt, [pinnedCandidate, secondCandidate, extraCandidate]),
      ),
    ).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ExecutionPrepareDiscoveryMismatch', field: 'candidateFactsHash' },
    })
  })

  test('derives the exact proof binding and deterministic redacted non-dispatchable receipt', () => {
    const input = validated()
    const first = Result.getOrThrow(makeExecutionPrepareReceipt(input, generation()))
    const second = Result.getOrThrow(makeExecutionPrepareReceipt(input, generation()))

    expect(input.proof).toEqual({
      schemaVersion: 'bayn.paper-authority-proof-binding.v1',
      riskPolicyHash: proofPlan.binding.riskPolicyHash,
      proofPlanHash: request.proofPlanHash,
    })
    expect(second).toEqual(first)
    expect(first).toMatchObject({
      operation: 'EXECUTION_PREPARE',
      dispatchable: false,
      authority: { maximum: Authority.Observe, effective: Authority.Observe, activated: false },
      dryRunSubmit: { included: false, reason: 'MUTATION_AUTHORITY_REQUIRED' },
      broker: {
        identityHash: proofPlan.binding.brokerIdentityHash,
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        access: BrokerAccess.ReadOnly,
      },
    })
    const output = JSON.stringify(first)
    expect(output).not.toContain(accountId)
    expect(output).not.toContain('credential')
    expect(output).not.toContain('secret')
  })

  test('fails total decoding for malformed or excess input', () => {
    for (const candidate of [undefined, { ...request, unexpected: true }]) {
      const malformed = validateExecutionPrepareInput(candidate, runtime)
      expect(malformed).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ExecutionPrepareRequestInvalid' },
      })
    }
  })

  test('rejects proof hash drift before durable access', () => {
    const drifted = validateExecutionPrepareInput({ ...request, proofPlanHash: hash('changed-proof') }, runtime)
    expect(drifted).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ExecutionPrepareProofPlanHashMismatch' },
    })
  })

  test('rejects every discovery-derived proof field and tampered receipt material', () => {
    const withCandidateSet = (
      candidateSet: ExecutionPrepareRequest['proofPlan']['candidateSet'],
    ): ExecutionPrepareRequest => {
      const changedProofPlan = { ...proofPlan, candidateSet }
      return { ...request, proofPlan: changedProofPlan, proofPlanHash: canonicalHashV1OrThrow(changedProofPlan) }
    }
    const withBinding = (binding: ExecutionPrepareRequest['proofPlan']['binding']): ExecutionPrepareRequest => {
      const changedProofPlan = { ...proofPlan, binding }
      return { ...request, proofPlan: changedProofPlan, proofPlanHash: canonicalHashV1OrThrow(changedProofPlan) }
    }
    const cases = [
      {
        request: withCandidateSet({ ...proofPlan.candidateSet, discoveryReceiptHash: hash('foreign-receipt') }),
        field: 'observationReceiptHash',
      },
      {
        request: withCandidateSet({ ...proofPlan.candidateSet, immutableBindingHash: hash('foreign-binding') }),
        field: 'immutableBindingHash',
      },
      {
        request: withCandidateSet({ ...proofPlan.candidateSet, candidateFactsHash: hash('foreign-candidate-facts') }),
        field: 'candidateFactsHash',
      },
      { request: withCandidateSet({ ...proofPlan.candidateSet, candidateCount: 2 }), field: 'candidateSetCount' },
      { request: withCandidateSet({ ...proofPlan.candidateSet, cycleId: hash('foreign-cycle') }), field: 'cycleId' },
      {
        request: withCandidateSet({ ...proofPlan.candidateSet, decisionHash: hash('foreign-decision') }),
        field: 'decisionHash',
      },
      {
        request: withBinding({ ...proofPlan.binding, activationSourceRevision: '0'.repeat(40) }),
        field: 'sourceRevision',
      },
      {
        request: withBinding({ ...proofPlan.binding, activationImageRepository: 'registry.test/foreign/bayn' }),
        field: 'imageRepository',
      },
      {
        request: withBinding({ ...proofPlan.binding, activationImageDigest: `sha256:${'0'.repeat(64)}` }),
        field: 'imageDigest',
      },
      {
        request: withBinding({
          ...proofPlan.binding,
          strategy: { ...proofPlan.binding.strategy, behaviorHash: hash('foreign-strategy') },
        }),
        field: 'strategyBehaviorHash',
      },
      {
        request: withBinding({ ...proofPlan.binding, strategyProtocolHash: hash('foreign-strategy-protocol') }),
        field: 'strategyProtocolHash',
      },
      {
        request: withBinding({ ...proofPlan.binding, qualificationRunId: hash('foreign-qualification') }),
        field: 'qualificationRunId',
      },
      { request: withBinding({ ...proofPlan.binding, accountId: 'foreign-account' }), field: 'accountId' },
      {
        request: withBinding({ ...proofPlan.binding, authorityGenerationHash: hash('foreign-generation') }),
        field: 'authorityGenerationHash',
      },
      {
        request: withBinding({ ...proofPlan.binding, riskPolicyHash: hash('foreign-policy') }),
        field: 'riskPolicyHash',
      },
      {
        request: withBinding({ ...proofPlan.binding, reconciliationId: hash('foreign-reconciliation') }),
        field: 'reconciliationId',
      },
      {
        request: withBinding({
          ...proofPlan.binding,
          reconciliationContentHash: hash('foreign-reconciliation-content'),
        }),
        field: 'reconciliationContentHash',
      },
    ] as const

    for (const testCase of cases) {
      expect(validateExecutionPrepareInput(testCase.request, runtime)).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ExecutionPrepareDiscoveryMismatch', field: testCase.field },
      })
    }

    const tamperedReceipt = {
      ...discoveryReceipt,
      candidateFacts: {
        ...discoveryReceipt.candidateFacts,
        candidates: [{ ...discoveredCandidate, observedPlanIntentId: hash('tampered-intent') }],
      },
    }
    const tampered = validateExecutionPrepareInput({ ...request, discoveryReceipt: tamperedReceipt }, runtime)
    expect(tampered).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ExecutionPrepareDiscoveryMismatch', field: 'observationReceiptHash' },
    })
  })

  test('requires a verified discovery anchor instead of accepting a self-hashed fabricated receipt', () => {
    const fabricatedReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
      sourceRevision,
      imageRepository,
      imageDigest,
      strategy,
      strategyProtocolHash,
      qualificationRunId,
      accountId,
      authorityGenerationHash,
      policyHash: riskPolicyHash,
      reconciliationId,
      reconciliationContentHash,
      observedPlanIntentId: hash('fabricated-intent'),
    })
    const fabricatedRequest = requestForDiscoveryReceipt(fabricatedReceipt)
    const prevalidated = Result.getOrThrow(validateExecutionPrepareInput(fabricatedRequest, runtime))

    expect(authenticateExecutionPrepareDiscovery(prevalidated, discoveryReceipt)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ExecutionPrepareDiscoveryMismatch', field: 'candidateFactsHash' },
    })
  })

  test('keeps the proof hash stable across fresh verified receipts with identical durable candidate facts', () => {
    const firstRefreshedReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
      sourceRevision,
      imageRepository,
      imageDigest,
      strategy,
      strategyProtocolHash,
      qualificationRunId,
      accountId,
      authorityGenerationHash,
      policyHash: riskPolicyHash,
      reconciliationId,
      reconciliationContentHash,
      observedAt: '2099-07-24T12:00:01.000Z',
    })
    const secondRefreshedReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
      sourceRevision,
      imageRepository,
      imageDigest,
      strategy,
      strategyProtocolHash,
      qualificationRunId,
      accountId,
      authorityGenerationHash,
      policyHash: riskPolicyHash,
      reconciliationId,
      reconciliationContentHash,
      observedAt: '2099-07-24T12:00:02.000Z',
    })
    const prevalidated = Result.getOrThrow(validateExecutionPrepareInput(request, runtime))
    const first = Result.getOrThrow(authenticateExecutionPrepareDiscovery(prevalidated, firstRefreshedReceipt))
    const second = Result.getOrThrow(authenticateExecutionPrepareDiscovery(prevalidated, secondRefreshedReceipt))

    expect(firstRefreshedReceipt.immutableBindingHash).toBe(discoveryReceipt.immutableBindingHash)
    expect(firstRefreshedReceipt.candidateFactsHash).toBe(discoveryReceipt.candidateFactsHash)
    expect(firstRefreshedReceipt.observationReceiptHash).not.toBe(discoveryReceipt.observationReceiptHash)
    expect(secondRefreshedReceipt.observationReceiptHash).not.toBe(firstRefreshedReceipt.observationReceiptHash)
    expect(first.proofPlan).toEqual(request.proofPlan)
    expect(second.proofPlan).toEqual(request.proofPlan)
    expect(first.proofPlanHash).toBe(request.proofPlanHash)
    expect(second.proofPlanHash).toBe(request.proofPlanHash)
    expect(first.proof).toEqual(second.proof)
  })

  test('rejects ineligible assets and missing required fractional eligibility', () => {
    const ineligibleReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
      sourceRevision,
      imageRepository,
      imageDigest,
      strategy,
      strategyProtocolHash,
      qualificationRunId,
      accountId,
      authorityGenerationHash,
      policyHash: riskPolicyHash,
      reconciliationId,
      reconciliationContentHash,
      assetEligible: false,
    })
    const fractionalIneligibleReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
      sourceRevision,
      imageRepository,
      imageDigest,
      strategy,
      strategyProtocolHash,
      qualificationRunId,
      accountId,
      authorityGenerationHash,
      policyHash: riskPolicyHash,
      reconciliationId,
      reconciliationContentHash,
      plannedQuantityMicros: '1250000',
      fractionalTradingEligible: false,
    })
    const integerWithoutFractionalEligibility = makeExecutionPrepareDiscoveryReceiptFixture({
      sourceRevision,
      imageRepository,
      imageDigest,
      strategy,
      strategyProtocolHash,
      qualificationRunId,
      accountId,
      authorityGenerationHash,
      policyHash: riskPolicyHash,
      reconciliationId,
      reconciliationContentHash,
      plannedQuantityMicros: '1000000',
      fractionalTradingEligible: false,
    })

    expect(validateExecutionPrepareInput(requestForDiscoveryReceipt(ineligibleReceipt), runtime)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ExecutionPrepareDiscoveryMismatch', field: 'candidateSetEligibility' },
    })
    expect(
      validateExecutionPrepareInput(requestForDiscoveryReceipt(fractionalIneligibleReceipt), runtime),
    ).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ExecutionPrepareDiscoveryMismatch', field: 'candidateSetEligibility' },
    })
    expect(
      validateExecutionPrepareInput(requestForDiscoveryReceipt(integerWithoutFractionalEligibility), runtime),
    ).toMatchObject({ _tag: 'Success' })
  })

  test('rejects runtime account, generation, strategy, policy, and authority drift', () => {
    const cases: ReadonlyArray<{
      readonly runtime: unknown
      readonly field: string
    }> = [
      { runtime: { ...runtime, accountId: 'another-account' }, field: 'accountId' },
      {
        runtime: { ...runtime, authorityGenerationHash: hash('changed-generation') },
        field: 'authorityGenerationHash',
      },
      {
        runtime: { ...runtime, strategy: { ...strategy, behaviorHash: hash('changed-behavior') } },
        field: 'strategyBehaviorHash',
      },
      { runtime: { ...runtime, riskPolicyHash: hash('changed-policy') }, field: 'riskPolicyHash' },
      { runtime: { ...runtime, brokerEnvironment: BrokerEnvironment.Live }, field: 'brokerEnvironment' },
      { runtime: { ...runtime, brokerAccess: BrokerAccess.Mutation }, field: 'brokerAccess' },
      { runtime: { ...runtime, capitalAuthority: CapitalAuthorityKind.Sandbox }, field: 'capitalAuthority' },
    ]

    for (const entry of cases) {
      const result = validateExecutionPrepareInput(request, entry.runtime)
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ExecutionPrepareRuntimeMismatch', field: entry.field },
      })
    }
  })

  test('rejects returned account, generation, strategy, policy, proof, and reconciliation drift', () => {
    const base = generation()
    const cases: ReadonlyArray<{
      readonly generation: CapitalGrantGeneration
      readonly field: ExecutionPrepareGenerationField
    }> = [
      { generation: { ...base, accountId: 'another-account' }, field: 'accountId' },
      { generation: { ...base, previousGenerationHash: hash('changed-generation') }, field: 'previousGenerationHash' },
      { generation: { ...base, strategyBehaviorHash: hash('changed-behavior') }, field: 'strategyBehaviorHash' },
      { generation: { ...base, riskPolicyHash: hash('changed-policy') }, field: 'riskPolicyHash' },
      { generation: { ...base, proofPlanHash: hash('changed-proof') }, field: 'proofPlanHash' },
      { generation: { ...base, reconciliationId: hash('changed-reconciliation') }, field: 'reconciliationId' },
      {
        generation: { ...base, reconciliationContentHash: hash('changed-reconciliation-content') },
        field: 'reconciliationContentHash',
      },
    ]

    for (const entry of cases) {
      const result = makeExecutionPrepareReceipt(validated(), entry.generation)
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ExecutionPrepareGenerationMismatch', field: entry.field },
      })
    }
  })
})

const writerFence: WriterFenceService = {
  backendPid: 1,
  check: Effect.void,
  transaction: (effect) => effect,
}

const runProgram = (
  lifecycle: CapitalGrantLifecycleStoreShape,
  candidateRequest: ExecutionPrepareRequest = request,
  trustedReceipt: ExecutionPrepareRequest['discoveryReceipt'] = discoveryReceipt,
) =>
  prepareExecution(candidateRequest, runtime, trustedReceipt).pipe(
    Effect.provideService(CapitalGrantLifecycleStore, lifecycle),
    Effect.provideService(WriterFence, writerFence),
  )

describe('EXECUTION_PREPARE program boundary', () => {
  test('calls only prepareCapitalGrant and returns the redacted receipt', async () => {
    let prepareCalls = 0
    let activateCalls = 0
    const lifecycle: CapitalGrantLifecycleStoreShape = {
      prepareCapitalGrant: () =>
        Effect.sync(() => {
          prepareCalls += 1
          return generation()
        }),
      activateCapitalGrant: () =>
        Effect.sync(() => {
          activateCalls += 1
          throw new Error('activation must remain unreachable')
        }),
    }

    const receipt = await Effect.runPromise(runProgram(lifecycle))
    expect(receipt.dispatchable).toBe(false)
    expect(prepareCalls).toBe(1)
    expect(activateCalls).toBe(0)
  })

  test('carries the store-derived v2 generation through the PREPARE output and runtime binding', async () => {
    const preparedGeneration = generation()
    const lifecycle: CapitalGrantLifecycleStoreShape = {
      prepareCapitalGrant: () => Effect.succeed(preparedGeneration),
      activateCapitalGrant: () => Effect.die(new Error('activation must remain unreachable')),
    }
    const output = await Effect.runPromise(
      prepareValidatedExecutionWithGeneration(validated()).pipe(
        Effect.provideService(CapitalGrantLifecycleStore, lifecycle),
        Effect.provideService(WriterFence, writerFence),
      ),
    )

    expect(output.generation.generationHash).toBe(preparedGeneration.generationHash)
    expect(
      validateDerivedPaperGeneration(output.generation, {
        accountId,
        configuredGenerationHash: preparedGeneration.generationHash,
        qualificationRunId,
      }),
    ).toMatchObject({ _tag: 'Success' })
  })

  test('does not call the store when self-hashed discovery material lacks the verified anchor', async () => {
    let prepareCalls = 0
    const fabricatedReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
      sourceRevision,
      imageRepository,
      imageDigest,
      strategy,
      strategyProtocolHash,
      qualificationRunId,
      accountId,
      authorityGenerationHash,
      policyHash: riskPolicyHash,
      reconciliationId,
      reconciliationContentHash,
      observedPlanIntentId: hash('fabricated-program-intent'),
    })
    const lifecycle: CapitalGrantLifecycleStoreShape = {
      prepareCapitalGrant: () =>
        Effect.sync(() => {
          prepareCalls += 1
          return generation()
        }),
      activateCapitalGrant: () => Effect.die(new Error('activation must remain unreachable')),
    }

    const failure = await Effect.runPromise(
      Effect.flip(runProgram(lifecycle, requestForDiscoveryReceipt(fabricatedReceipt), discoveryReceipt)),
    )
    expect(failure).toMatchObject({
      _tag: 'ExecutionPrepareDiscoveryMismatch',
      field: 'candidateFactsHash',
    })
    expect(prepareCalls).toBe(0)
  })

  test('sanitizes durable failures without account or store-message leakage', async () => {
    const lifecycleFailure = new ExecutionStoreError({
      operation: 'authority',
      failure: 'invariant',
      message: `sensitive account ${accountId} failed`,
      cause: new Error('underlying schema failure'),
    })
    const lifecycle: CapitalGrantLifecycleStoreShape = {
      prepareCapitalGrant: () => Effect.fail(lifecycleFailure),
      activateCapitalGrant: () => Effect.die(new Error('activation must remain unreachable')),
    }

    const failure = await Effect.runPromise(Effect.flip(runProgram(lifecycle)))
    expect(failure).toMatchObject({
      _tag: 'ExecutionPrepareStoreRejected',
      operation: 'authority',
      failure: 'invariant',
      cause: lifecycleFailure,
    })
    if (failure._tag !== 'ExecutionPrepareStoreRejected') return expect.unreachable(failure._tag)
    expect(failure.cause).toBe(lifecycleFailure)
    const rendered = renderExecutionPrepareFailure(failure)
    expect(rendered).not.toContain(accountId)
    expect(rendered).not.toContain('sensitive account')
  })
})
