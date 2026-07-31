import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import { BrokerEnvironment, BrokerProvider } from '../broker/identity'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import { MutationEventType, type MutationEvent } from '../execution/mutations'
import {
  protectedEntryToken,
  runPaperProof,
  type PaperProofCommand,
  type PaperProofDependencies,
  type PaperProofRuntimeBinding,
  type PaperProofSourcePlan,
} from './index'

const hash = (character: string) => character.repeat(64)
const accountId = 'paper-account'
const intentId = hash('a')
const strategy = {
  name: 'risk-balanced-trend',
  behaviorHash: hash('b'),
  parameterHash: hash('c'),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
} as const

const sourcePlan: PaperProofSourcePlan = {
  schemaVersion: 'bayn.paper-proof-plan.v1',
  proofPlanHash: hash('d'),
  riskPolicyHash: hash('e'),
  qualificationRunId: hash('f'),
  qualificationResult: 'QUALIFIED',
  qualificationPinned: true,
  sourceRevision: hash('1'),
  imageRepository: 'ghcr.io/proompteng/bayn',
  imageDigest: `sha256:${hash('2')}`,
  brokerProvider: BrokerProvider.Alpaca,
  brokerEnvironment: BrokerEnvironment.Sandbox,
  accountId,
  authorityGenerationHash: hash('3'),
  strategy,
  intentId,
}

const runtime = (mutation: boolean): PaperProofRuntimeBinding => ({
  sourceRevision: sourcePlan.sourceRevision,
  imageRepository: sourcePlan.imageRepository,
  imageDigest: sourcePlan.imageDigest,
  brokerProvider: BrokerProvider.Alpaca,
  brokerEnvironment: BrokerEnvironment.Sandbox,
  accountId,
  authorityGenerationHash: sourcePlan.authorityGenerationHash,
  brokerAccess: mutation ? BrokerAccess.Mutation : BrokerAccess.ReadOnly,
  capitalAuthority: mutation ? CapitalAuthorityKind.Sandbox : CapitalAuthorityKind.None,
  strategy,
})

const command = (operation: PaperProofCommand['operation']): PaperProofCommand => ({
  schemaVersion: 'bayn.paper-proof-command.v1',
  operation,
  timeoutMs: 1_000,
  consistencyDelayMs: 1,
  proofPlanHash: sourcePlan.proofPlanHash,
  riskPolicyHash: sourcePlan.riskPolicyHash,
  qualificationRunId: sourcePlan.qualificationRunId,
  sourceRevision: sourcePlan.sourceRevision,
  imageRepository: sourcePlan.imageRepository,
  imageDigest: sourcePlan.imageDigest,
})

const event = (eventType: MutationEventType, operation = MutationOperation.Submit): MutationEvent => ({
  schemaVersion: 'bayn.paper-mutation-event.v1',
  eventId: hash(eventType === MutationEventType.SubmitAccepted ? '4' : '5'),
  mutationId: hash('6'),
  intentId,
  sequence: 1,
  operation,
  eventType,
  requestHash: hash('7'),
  consistencyDelayMs: 1,
  ...(eventType === MutationEventType.SubmitAccepted ||
  eventType === MutationEventType.CancelAccepted ||
  eventType === MutationEventType.RecoveryFound
    ? { brokerOrderId: 'broker-order' }
    : {}),
  occurredAt: '2026-07-31T08:00:00.000Z',
})

const generation = {
  schemaVersion: 'bayn.paper-authority-generation.v2',
  maximum: 'PAPER',
  previousGenerationHash: hash('8'),
  qualificationRunId: sourcePlan.qualificationRunId,
  qualificationLockId: hash('9'),
  qualificationResultHash: hash('a'),
  protocolHash: hash('b'),
  qualificationExecutionPolicyHash: hash('c'),
  qualificationSourceRevision: sourcePlan.sourceRevision,
  qualificationImageRepository: sourcePlan.imageRepository,
  qualificationImageDigest: sourcePlan.imageDigest,
  activationSourceRevision: sourcePlan.sourceRevision,
  activationImageRepository: sourcePlan.imageRepository,
  activationImageDigest: sourcePlan.imageDigest,
  strategyName: 'risk-balanced-trend',
  strategyBehaviorHash: strategy.behaviorHash,
  strategyParameterHash: strategy.parameterHash,
  strategyParameterSchemaVersion: strategy.parameterSchemaVersion,
  accountId,
  riskPolicyHash: sourcePlan.riskPolicyHash,
  proofPlanHash: sourcePlan.proofPlanHash,
  reconciliationId: hash('d'),
  reconciliationContentHash: hash('e'),
  generationHash: sourcePlan.authorityGenerationHash,
} as const

interface FixtureOptions {
  readonly operation: PaperProofCommand['operation']
  readonly latestSubmit?: MutationEvent
  readonly latestCancel?: MutationEvent
  readonly submitEvent?: MutationEvent
  readonly cancelEvent?: MutationEvent
  readonly recoverEvent?: MutationEvent
  readonly reconciliationUnknownCounts?: readonly number[]
  readonly neverReconcileAt?: number
}

const fixture = (options: FixtureOptions) => {
  const sequence: string[] = []
  const calls = { prepare: 0, activate: 0, submit: 0, cancel: 0, recover: 0, restrict: 0, reconcile: 0 }
  const dependencies: PaperProofDependencies = {
    sourcePlan,
    runtime: runtime(options.operation !== 'PREPARE'),
    protectedEntryToken: protectedEntryToken(sourcePlan),
    prepareCapitalGrant: () => {
      calls.prepare += 1
      sequence.push('prepare')
      return Effect.succeed(generation)
    },
    activateCapitalGrant: () => {
      calls.activate += 1
      sequence.push('activate')
      return Effect.succeed(undefined)
    },
    restrictAuthority: () => {
      calls.restrict += 1
      sequence.push('restrict')
      return Effect.void
    },
    mutations: {
      latest: (_intentId, operation) =>
        Effect.succeed(operation === MutationOperation.Submit ? options.latestSubmit : options.latestCancel),
    },
    execution: {
      submit: () => {
        calls.submit += 1
        sequence.push('submit')
        return Effect.succeed(options.submitEvent ?? event(MutationEventType.SubmitAccepted))
      },
      cancel: () => {
        calls.cancel += 1
        sequence.push('cancel')
        return Effect.succeed(
          options.cancelEvent ?? event(MutationEventType.CancelAccepted, MutationOperation.Cancel),
        )
      },
      recover: (_intentId, operation) => {
        calls.recover += 1
        sequence.push(`recover:${operation}`)
        return Effect.succeed(options.recoverEvent ?? event(MutationEventType.RecoveryFound, operation))
      },
    },
    prepareIntent: () =>
      Effect.succeed({ intentId, clientOrderId: `b1_${'A'.repeat(43)}`, deduplicated: false }),
    reconcile: () => {
      calls.reconcile += 1
      sequence.push(`reconcile:${calls.reconcile.toString()}`)
      if (options.neverReconcileAt === calls.reconcile) return Effect.never
      return Effect.succeed({
        reconciliationId: hash(String(Math.min(calls.reconcile, 9))),
        contentHash: hash('f'),
        accountId,
        status: 'EXACT',
        unknownMutationCount: options.reconciliationUnknownCounts?.[calls.reconcile - 1] ?? 0,
        reconciledAt: '2026-07-31T08:00:00.000Z',
      })
    },
    currentUtcInstant: Effect.succeed('2026-07-31T08:00:01.000Z'),
  }
  return { calls, dependencies, sequence }
}

describe('bounded PAPER proof command', () => {
  test('PREPARE reconciles and derives a generation without mutation services', async () => {
    const { calls, dependencies } = fixture({ operation: 'PREPARE' })
    const receipt = await Effect.runPromise(runPaperProof(command('PREPARE'), dependencies))

    expect(receipt.generation?.generationHash).toBe(sourcePlan.authorityGenerationHash)
    expect(calls).toMatchObject({
      prepare: 1,
      activate: 0,
      submit: 0,
      cancel: 0,
      recover: 0,
      reconcile: 1,
    })
  })

  test('SUBMIT performs at most one POST and reconciles around activation', async () => {
    const { calls, dependencies } = fixture({ operation: 'SUBMIT' })
    const receipt = await Effect.runPromise(runPaperProof(command('SUBMIT'), dependencies))

    expect(receipt.mutation?.eventType).toBe(MutationEventType.SubmitAccepted)
    expect(receipt.reconciliations).toHaveLength(3)
    expect(calls).toMatchObject({ activate: 1, submit: 1, recover: 0, reconcile: 3 })
  })

  test('duplicate accepted SUBMIT reuses durable evidence without activation or POST', async () => {
    const accepted = event(MutationEventType.SubmitAccepted)
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', latestSubmit: accepted })
    const receipt = await Effect.runPromise(runPaperProof(command('SUBMIT'), dependencies))

    expect(receipt.mutation).toEqual(accepted)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.recover).toBe(0)
  })

  test('crash restart recovers an unresolved SUBMIT before exact reconciliation', async () => {
    const started = event(MutationEventType.SubmitStarted)
    const recovered = event(MutationEventType.RecoveryFound)
    const { calls, dependencies, sequence } = fixture({
      operation: 'SUBMIT',
      latestSubmit: started,
      recoverEvent: recovered,
      reconciliationUnknownCounts: [1, 0],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('SUBMIT'), dependencies))

    expect(receipt.mutation).toEqual(recovered)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.recover).toBe(1)
    expect(sequence).toEqual([
      'reconcile:1',
      `recover:${MutationOperation.Submit}`,
      'reconcile:2',
    ])
  })

  test('unknown SUBMIT is durably contained by restricting authority', async () => {
    const unknown = event(MutationEventType.SubmitUnknown)
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', submitEvent: unknown })
    const receipt = await Effect.runPromise(runPaperProof(command('SUBMIT'), dependencies))

    expect(receipt.restricted).toBe(true)
    expect(receipt.mutation?.eventType).toBe(MutationEventType.SubmitUnknown)
    expect(calls.restrict).toBe(1)
  })

  test('accepted cancellation is lookup-recovered before the zero-unknown gate', async () => {
    const accepted = event(MutationEventType.CancelAccepted, MutationOperation.Cancel)
    const recovered = event(MutationEventType.RecoveryFound, MutationOperation.Cancel)
    const { calls, dependencies, sequence } = fixture({
      operation: 'CANCEL',
      cancelEvent: accepted,
      recoverEvent: recovered,
      reconciliationUnknownCounts: [1, 0],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('CANCEL'), dependencies))

    expect(receipt.mutation).toEqual(recovered)
    expect(calls.cancel).toBe(1)
    expect(calls.recover).toBe(1)
    expect(sequence).toEqual([
      'reconcile:1',
      'cancel',
      `recover:${MutationOperation.Cancel}`,
      'reconcile:2',
    ])
  })

  test('cancel race recovers durable cancellation without another DELETE', async () => {
    const started = event(MutationEventType.CancelStarted, MutationOperation.Cancel)
    const { calls, dependencies } = fixture({ operation: 'CANCEL', latestCancel: started })
    const receipt = await Effect.runPromise(runPaperProof(command('CANCEL'), dependencies))

    expect(receipt.mutation?.eventType).toBe(MutationEventType.RecoveryFound)
    expect(calls.cancel).toBe(0)
    expect(calls.recover).toBe(1)
  })

  test('RECOVER performs durable lookup before final exact reconciliation', async () => {
    const recovered = event(MutationEventType.RecoveryFound)
    const { calls, dependencies, sequence } = fixture({
      operation: 'RECOVER',
      recoverEvent: recovered,
      reconciliationUnknownCounts: [1, 0],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('RECOVER'), dependencies))

    expect(receipt.mutation).toEqual(recovered)
    expect(calls.submit).toBe(0)
    expect(calls.recover).toBe(1)
    expect(sequence).toEqual([
      'reconcile:1',
      `recover:${MutationOperation.Submit}`,
      'reconcile:2',
    ])
  })

  test('post-activation timeout restricts authority and reconciles uninterruptibly', async () => {
    const { calls, dependencies, sequence } = fixture({
      operation: 'SUBMIT',
      neverReconcileAt: 2,
    })
    const bounded = { ...command('SUBMIT'), timeoutMs: 5 }
    const exit = await Effect.runPromiseExit(runPaperProof(bounded, dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain('TIMEOUT')
    expect(calls.activate).toBe(1)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
    expect(calls.reconcile).toBe(3)
    expect(sequence).toEqual([
      'reconcile:1',
      'activate',
      'reconcile:2',
      'restrict',
      'reconcile:3',
    ])
  })

  test('cooperative PREPARE termination enforces the command deadline', async () => {
    const { dependencies } = fixture({ operation: 'PREPARE', neverReconcileAt: 1 })
    const bounded = { ...command('PREPARE'), timeoutMs: 1 }
    const exit = await Effect.runPromiseExit(runPaperProof(bounded, dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain('TIMEOUT')
  })
})
