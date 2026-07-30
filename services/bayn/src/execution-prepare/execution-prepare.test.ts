import { describe, expect, test } from 'bun:test'

import { Effect, Result } from 'effect'

import { BrokerEnvironment, BrokerProvider } from '../broker/identity'
import {
  CapitalGrantLifecycleStore,
  ExecutionStoreError,
  type CapitalGrantLifecycleStoreShape,
} from '../db/execution-store'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import { Authority, makeCapitalGrantGenerationResult, type CapitalGrantGeneration } from '../execution/contracts'
import { WriterFence, type WriterFenceService } from '../execution/writer-fence'
import { canonicalHashV1OrThrow, sha256 } from '../hash'
import { renderExecutionPrepareFailure } from './failure'
import type { ExecutionPrepareGenerationField } from './failure'
import type { ExecutionPrepareRequest, ExecutionPrepareRuntimeBinding } from './model'
import { prepareExecution } from './program'
import { makeExecutionPrepareReceipt, validateExecutionPrepareInput } from './validation'

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

const proofPlan = {
  schemaVersion: 'bayn.execution-prepare-proof-plan.v1' as const,
  candidate: {
    discoveryReceiptHash: hash('discovery-receipt'),
    immutableBindingHash: hash('immutable-binding'),
    candidateFactsHash: hash('candidate-facts'),
    candidateOrdinal: 2,
    observedPlanIntentId: hash('observed-plan-intent'),
    cycleId: hash('cycle'),
    decisionHash: hash('decision'),
  },
  binding: {
    activationSourceRevision: sourceRevision,
    activationImageRepository: imageRepository,
    activationImageDigest: imageDigest,
    qualificationSourceRevision,
    qualificationImageRepository: imageRepository,
    qualificationImageDigest,
    strategy,
    strategyProtocolHash: hash('strategy-protocol'),
    qualificationRunId: hash('qualification-run'),
    qualificationLockId: hash('qualification-lock'),
    qualificationResultHash: hash('qualification-result'),
    protocolHash: hash('protocol'),
    qualificationExecutionPolicyHash: hash('qualification-execution-policy'),
    accountId,
    brokerIdentityHash: hash('broker-identity'),
    authorityGenerationHash: hash('observe-generation'),
    riskPolicyHash: hash('risk-policy'),
    reconciliationId: hash('reconciliation'),
    reconciliationContentHash: hash('reconciliation-content'),
  },
}

const request: ExecutionPrepareRequest = {
  schemaVersion: 'bayn.execution-prepare-request.v1',
  proofPlan,
  proofPlanHash: canonicalHashV1OrThrow(proofPlan),
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

const validated = () => Result.getOrThrow(validateExecutionPrepareInput(request, runtime))

describe('EXECUTION_PREPARE pure validation', () => {
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

const runProgram = (lifecycle: CapitalGrantLifecycleStoreShape) =>
  prepareExecution(request, runtime).pipe(
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

  test('sanitizes durable failures without account or store-message leakage', async () => {
    const lifecycle: CapitalGrantLifecycleStoreShape = {
      prepareCapitalGrant: () =>
        Effect.fail(
          new ExecutionStoreError({
            operation: 'authority',
            failure: 'invariant',
            message: `sensitive account ${accountId} failed`,
          }),
        ),
      activateCapitalGrant: () => Effect.die(new Error('activation must remain unreachable')),
    }

    const failure = await Effect.runPromise(Effect.flip(runProgram(lifecycle)))
    expect(failure).toEqual({
      _tag: 'ExecutionPrepareStoreRejected',
      operation: 'authority',
      failure: 'invariant',
    })
    const rendered = renderExecutionPrepareFailure(failure)
    expect(rendered).not.toContain(accountId)
    expect(rendered).not.toContain('sensitive account')
  })
})
