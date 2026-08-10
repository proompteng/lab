import { describe, expect, test } from 'bun:test'

import { Data, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { MutationOperation } from '../broker/alpaca-mutations'
import { BrokerProvider } from '../broker/connection'
import { BrokerEnvironment } from '../broker/identity'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import { Authority, IntentState, TerminalOutcome } from '../execution/contracts'
import { MutationEventType, MutationStoreError, type MutationEvent } from '../execution/mutations'
import { paperProofCommandEntryGate, runPaperProofCommand } from '../paper-proof-command'
import {
  protectedEntryToken,
  runPaperProof,
  type PaperProofCommand,
  type PaperProofCancelDependencies,
  type PaperProofDependencies,
  type PaperProofPrepareDependencies,
  type PaperProofRecoverDependencies,
  type PaperProofSubmitDependencies,
  type PaperProofIntentSnapshot,
  type PaperProofRecoveryCompletion,
  type PaperProofRecoveryRequired,
  type PaperProofRuntimeBinding,
  type PaperProofSourcePlan,
} from './index'
import { runPaperProofPrepare } from './prepare'

type PaperProofPublicExports = typeof import('./index')

class TestFailure extends Data.TaggedError('TestFailure')<{ readonly message: string }> {}

const hash = (character: string): string => character.repeat(64)
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
  sourceRevision: '1'.repeat(40),
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

const command = <Operation extends PaperProofCommand['operation']>(
  operation: Operation,
): Omit<PaperProofCommand, 'operation'> & { readonly operation: Operation } => ({
  schemaVersion: 'bayn.paper-proof-command.v1',
  operation,
  timeoutMs: 1_000,
  containmentIoTimeoutMs: 20,
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
  mutationId: hash(operation === MutationOperation.Submit ? '6' : '7'),
  intentId,
  sequence: 1,
  operation,
  eventType,
  requestHash: hash('8'),
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
  maximum: Authority.Paper,
  previousGenerationHash: hash('9'),
  qualificationRunId: sourcePlan.qualificationRunId,
  qualificationLockId: hash('a'),
  qualificationResultHash: hash('b'),
  protocolHash: hash('c'),
  qualificationExecutionPolicyHash: hash('d'),
  qualificationSourceRevision: sourcePlan.sourceRevision,
  qualificationImageRepository: sourcePlan.imageRepository,
  qualificationImageDigest: sourcePlan.imageDigest,
  activationSourceRevision: sourcePlan.sourceRevision,
  activationImageRepository: sourcePlan.imageRepository,
  activationImageDigest: sourcePlan.imageDigest,
  strategyName: strategy.name,
  strategyBehaviorHash: strategy.behaviorHash,
  strategyParameterHash: strategy.parameterHash,
  strategyParameterSchemaVersion: strategy.parameterSchemaVersion,
  accountId,
  riskPolicyHash: sourcePlan.riskPolicyHash,
  proofPlanHash: sourcePlan.proofPlanHash,
  reconciliationId: hash('e'),
  reconciliationContentHash: hash('f'),
  generationHash: sourcePlan.authorityGenerationHash,
} as const

interface RecoveryState {
  required?: PaperProofRecoveryRequired
  completion?: PaperProofRecoveryCompletion
}

interface MutationState {
  submit?: MutationEvent
  cancel?: MutationEvent
}

interface FixtureOptions {
  readonly operation: PaperProofCommand['operation']
  readonly latestSubmit?: MutationEvent
  readonly latestCancel?: MutationEvent
  readonly submitEvent?: MutationEvent
  readonly cancelAfterSubmitEvent?: MutationEvent
  readonly cancelEvent?: MutationEvent
  readonly recoverEvent?: MutationEvent
  readonly reconciliationUnknownCounts?: readonly number[]
  readonly neverReconcileCalls?: readonly number[]
  readonly neverRestrict?: boolean
  readonly failActivation?: boolean
  readonly neverActivation?: boolean
  readonly failPrepareIntent?: boolean
  readonly neverPrepareIntent?: boolean
  readonly failSubmitPrerequisite?: boolean
  readonly neverSubmitAfterMarker?: boolean
  readonly failSubmit?: boolean
  readonly failCancelPrerequisite?: boolean
  readonly neverCancelAfterMarker?: boolean
  readonly failCancel?: boolean
  readonly failRecoveryLoad?: boolean
  readonly neverRecoveryLoad?: boolean
  readonly failCompletionLoad?: boolean
  readonly neverCompletionLoad?: boolean
  readonly failRecoveryMark?: boolean
  readonly cancelOnRecoveryComplete?: MutationEvent
  readonly neverCompleteAfterCommit?: boolean
  readonly failCompleteAfterCommit?: boolean
  readonly failClockCalls?: readonly number[]
  readonly neverClockCalls?: readonly number[]
  readonly failReconcileCalls?: readonly number[]
  readonly failMutationReadCalls?: readonly number[]
  readonly neverMutationReadCalls?: readonly number[]
  readonly intentSnapshots?: readonly (PaperProofIntentSnapshot | undefined)[]
  readonly recoveryState?: RecoveryState
  readonly mutationState?: MutationState
  readonly cancelStartedEvent?: MutationEvent
}

const recoveryRequired = (operation: 'SUBMIT' | 'CANCEL'): PaperProofRecoveryRequired => ({
  schemaVersion: 'bayn.paper-proof-recovery-required.v1',
  intentId,
  proofPlanHash: sourcePlan.proofPlanHash,
  qualificationRunId: sourcePlan.qualificationRunId,
  operation,
  reason: 'prior-timeout',
  requiredAt: '2026-07-31T08:00:00.000Z',
})

const recoveryCompletion = (
  operation: 'SUBMIT' | 'CANCEL',
  mutation: MutationEvent,
  restricted: boolean,
): PaperProofRecoveryCompletion => ({
  schemaVersion: 'bayn.paper-proof-recovery-completion.v1',
  intentId,
  proofPlanHash: sourcePlan.proofPlanHash,
  qualificationRunId: sourcePlan.qualificationRunId,
  operation,
  mutation,
  reconciliations: [
    {
      reconciliationId: hash('1'),
      contentHash: hash('f'),
      accountId,
      status: 'EXACT',
      unknownMutationCount: 0,
      reconciledAt: '2026-07-31T08:00:00.000Z',
    },
  ],
  restricted,
  completedAt: '2026-07-31T08:00:01.000Z',
})

const acknowledgedIntent: PaperProofIntentSnapshot = {
  state: IntentState.Acknowledged,
}

const canceledIntent: PaperProofIntentSnapshot = {
  state: IntentState.Terminal,
  terminalOutcome: TerminalOutcome.Canceled,
}

const sameMutationEvent = (left: MutationEvent, right: MutationEvent): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.eventId === right.eventId &&
  left.mutationId === right.mutationId &&
  left.intentId === right.intentId &&
  left.sequence === right.sequence &&
  left.operation === right.operation &&
  left.eventType === right.eventType &&
  left.requestHash === right.requestHash &&
  left.consistencyDelayMs === right.consistencyDelayMs &&
  left.brokerOrderId === right.brokerOrderId &&
  left.requestId === right.requestId &&
  left.responseStatus === right.responseStatus &&
  left.responseContentHash === right.responseContentHash &&
  left.occurredAt === right.occurredAt

type PaperProofFixtureCapabilities = Pick<PaperProofDependencies, 'sourcePlan' | 'runtime' | 'protectedEntryToken'> & {
  readonly prepareCapitalGrant: PaperProofDependencies['prepare']['prepareCapitalGrant']
  readonly activateCapitalGrant: PaperProofDependencies['submit']['activateCapitalGrant']
  readonly restrictAuthority: PaperProofDependencies['containment']['restrictAuthority']
  readonly recovery: PaperProofDependencies['recovery']
  readonly mutations: PaperProofDependencies['mutations']
  readonly execution: {
    readonly submit: PaperProofDependencies['submit']['execution']['submit']
    readonly cancel: PaperProofDependencies['cancel']['execution']['cancel']
    readonly recover: (intentId: string, operation: MutationOperation) => Effect.Effect<MutationEvent, Error>
  }
  readonly prepareIntent: PaperProofDependencies['submit']['prepareIntent']
  readonly readIntent: PaperProofDependencies['readIntent']
  readonly reconcile: PaperProofDependencies['containment']['reconcile']
  readonly currentUtcInstant: PaperProofDependencies['containment']['currentUtcInstant']
}

const fixture = (options: FixtureOptions) => {
  const sequence: string[] = []
  const recoveryState = options.recoveryState ?? {}
  const mutationState =
    options.mutationState ??
    ({
      ...(options.latestSubmit === undefined ? {} : { submit: options.latestSubmit }),
      ...(options.latestCancel === undefined ? {} : { cancel: options.latestCancel }),
    } satisfies MutationState)
  const intentSnapshots = options.intentSnapshots ?? [acknowledgedIntent]
  const calls = {
    prepare: 0,
    activate: 0,
    submit: 0,
    cancel: 0,
    recover: 0,
    restrict: 0,
    reconcile: 0,
    readIntent: 0,
    prepareIntent: 0,
    mutationRead: 0,
    recoveryLoad: 0,
    completionLoad: 0,
    recoveryMark: 0,
    recoveryComplete: 0,
    clock: 0,
  }
  const capabilities: PaperProofFixtureCapabilities = {
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
      if (options.neverActivation === true) return Effect.never
      return options.failActivation === true
        ? Effect.fail(new TestFailure({ message: 'activation failed' }))
        : Effect.void
    },
    restrictAuthority: () => {
      calls.restrict += 1
      sequence.push('restrict')
      return options.neverRestrict === true ? Effect.never : Effect.void
    },
    recovery: {
      load: () => {
        calls.recoveryLoad += 1
        sequence.push('recovery:load')
        if (options.neverRecoveryLoad === true) return Effect.never
        if (options.failRecoveryLoad === true) {
          return Effect.fail(new TestFailure({ message: 'recovery load failed' }))
        }
        return Effect.succeed(recoveryState.required)
      },
      loadCompletion: () => {
        calls.completionLoad += 1
        sequence.push('recovery:load-completion')
        if (options.neverCompletionLoad === true) return Effect.never
        if (options.failCompletionLoad === true) {
          return Effect.fail(new TestFailure({ message: 'completion load failed' }))
        }
        return Effect.succeed(recoveryState.completion)
      },
      markRequired: (required) => {
        calls.recoveryMark += 1
        sequence.push(`recovery:mark:${required.operation}`)
        if (options.failRecoveryMark === true) {
          return Effect.fail(new TestFailure({ message: 'recovery mark failed before commit' }))
        }
        recoveryState.required = required
        delete recoveryState.completion
        return Effect.void
      },
      complete: (completion, guard) => {
        calls.recoveryComplete += 1
        sequence.push(`recovery:complete:${completion.operation}`)
        if (options.cancelOnRecoveryComplete !== undefined) {
          mutationState.cancel = options.cancelOnRecoveryComplete
        }
        const latest = completion.operation === 'SUBMIT' ? mutationState.submit : mutationState.cancel
        if (
          latest === undefined ||
          !sameMutationEvent(latest, guard.expectedLatestMutation) ||
          !sameMutationEvent(completion.mutation, guard.expectedLatestMutation) ||
          (guard.rejectAnyCancellation && mutationState.cancel !== undefined)
        ) {
          return Effect.fail(
            new TestFailure({ message: 'recovery completion guard rejected stale authority evidence' }),
          )
        }
        const commit = Effect.sync(() => {
          recoveryState.completion = completion
          delete recoveryState.required
        })
        if (options.neverCompleteAfterCommit === true) return commit.pipe(Effect.andThen(Effect.never))
        if (options.failCompleteAfterCommit === true) {
          return commit.pipe(
            Effect.andThen(Effect.fail(new TestFailure({ message: 'completion response failed after commit' }))),
          )
        }
        return commit
      },
    },
    mutations: {
      latest: (_intentId, operation) =>
        Effect.suspend(() => {
          calls.mutationRead += 1
          sequence.push(`mutation:read:${operation}:${calls.mutationRead.toString()}`)
          if (options.neverMutationReadCalls?.includes(calls.mutationRead) === true) return Effect.never
          if (options.failMutationReadCalls?.includes(calls.mutationRead) === true) {
            return Effect.fail(
              new MutationStoreError({
                operation: 'read',
                failure: 'query',
                message: 'mutation read failed',
              }),
            )
          }
          return Effect.succeed(operation === MutationOperation.Submit ? mutationState.submit : mutationState.cancel)
        }),
    },
    execution: {
      submit: (_intentId, _consistencyDelayMs, beforeBrokerMutation) =>
        Effect.gen(function* () {
          sequence.push('submit:preflight')
          if (options.failSubmitPrerequisite === true) {
            return yield* Effect.fail(new TestFailure({ message: 'submit prerequisite failed before mutation start' }))
          }
          sequence.push('submit:mutation-started')
          yield* beforeBrokerMutation()
          calls.submit += 1
          sequence.push('submit')
          if (options.neverSubmitAfterMarker === true) return yield* Effect.never
          if (options.failSubmit === true) {
            return yield* Effect.fail(new TestFailure({ message: 'submit failed after durable marker' }))
          }
          const submitted = options.submitEvent ?? event(MutationEventType.SubmitAccepted)
          mutationState.submit = submitted
          if (options.cancelAfterSubmitEvent !== undefined) mutationState.cancel = options.cancelAfterSubmitEvent
          return submitted
        }),
      cancel: (_intentId, _consistencyDelayMs, beforeBrokerMutation) =>
        Effect.gen(function* () {
          sequence.push('cancel:preflight')
          if (options.failCancelPrerequisite === true) {
            return yield* Effect.fail(new TestFailure({ message: 'cancel prerequisite failed before mutation start' }))
          }
          sequence.push('cancel:mutation-started')
          if (options.cancelStartedEvent !== undefined) mutationState.cancel = options.cancelStartedEvent
          yield* beforeBrokerMutation()
          calls.cancel += 1
          sequence.push('cancel')
          if (options.neverCancelAfterMarker === true) return yield* Effect.never
          if (options.failCancel === true) {
            return yield* Effect.fail(new TestFailure({ message: 'cancel failed after durable marker' }))
          }
          const canceled = options.cancelEvent ?? event(MutationEventType.CancelAccepted, MutationOperation.Cancel)
          mutationState.cancel = canceled
          return canceled
        }),
      recover: (_intentId, operation) => {
        calls.recover += 1
        sequence.push(`recover:${operation}`)
        const recovered = options.recoverEvent ?? event(MutationEventType.RecoveryFound, operation)
        if (operation === MutationOperation.Submit) mutationState.submit = recovered
        else mutationState.cancel = recovered
        return Effect.succeed(recovered)
      },
    },
    prepareIntent: Effect.suspend(() => {
      calls.prepareIntent += 1
      sequence.push('intent:prepare')
      if (options.neverPrepareIntent === true) return Effect.never
      if (options.failPrepareIntent === true) {
        return Effect.fail(new TestFailure({ message: 'intent preparation failed' }))
      }
      return Effect.succeed({
        intentId,
        clientOrderId: `b1_${'A'.repeat(43)}`,
        deduplicated: false,
      })
    }),
    readIntent: () => {
      calls.readIntent += 1
      sequence.push(`intent:read:${calls.readIntent.toString()}`)
      const index = Math.min(calls.readIntent - 1, intentSnapshots.length - 1)
      return Effect.succeed(intentSnapshots[index])
    },
    reconcile: Effect.suspend(() => {
      calls.reconcile += 1
      sequence.push(`reconcile:${calls.reconcile.toString()}`)
      if (options.neverReconcileCalls?.includes(calls.reconcile) === true) return Effect.never
      if (options.failReconcileCalls?.includes(calls.reconcile) === true) {
        return Effect.fail(new TestFailure({ message: 'reconciliation failed' }))
      }
      return Effect.succeed({
        reconciliationId: hash(String(Math.min(calls.reconcile, 9))),
        contentHash: hash('f'),
        accountId,
        status: 'EXACT',
        unknownMutationCount: options.reconciliationUnknownCounts?.[calls.reconcile - 1] ?? 0,
        reconciledAt: '2026-07-31T08:00:00.000Z',
      })
    }),
    currentUtcInstant: Effect.suspend(() => {
      calls.clock += 1
      if (options.neverClockCalls?.includes(calls.clock) === true) return Effect.never
      return options.failClockCalls?.includes(calls.clock) === true
        ? Effect.fail(new TestFailure({ message: 'clock failed' }))
        : Effect.succeed('2026-07-31T08:00:01.000Z')
    }),
  }
  const dependencies: PaperProofDependencies = {
    sourcePlan: capabilities.sourcePlan,
    runtime: capabilities.runtime,
    protectedEntryToken: capabilities.protectedEntryToken,
    mutations: capabilities.mutations,
    recovery: capabilities.recovery,
    readIntent: capabilities.readIntent,
    recoverMutation: capabilities.execution.recover,
    containment: {
      restrictAuthority: capabilities.restrictAuthority,
      reconcile: capabilities.reconcile,
      currentUtcInstant: capabilities.currentUtcInstant,
    },
    prepare: {
      prepareCapitalGrant: capabilities.prepareCapitalGrant,
    },
    submit: {
      activateCapitalGrant: capabilities.activateCapitalGrant,
      execution: {
        submit: capabilities.execution.submit,
      },
      prepareIntent: capabilities.prepareIntent,
    },
    cancel: {
      execution: {
        cancel: capabilities.execution.cancel,
      },
    },
    recover: {},
  }
  return { calls, dependencies, mutationState, recoveryState, sequence }
}

const boundedCommand = (operation: PaperProofCommand['operation']): PaperProofCommand => ({
  ...command(operation),
  timeoutMs: 60,
  containmentIoTimeoutMs: 5,
})

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E>, advanceMs: number): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.exit(effect).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust(advanceMs)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())),
  )

describe('bounded PAPER proof command', () => {
  test('operation programs expose only their permitted capabilities', async () => {
    const { dependencies } = fixture({ operation: 'PREPARE' })
    const prepare: PaperProofPrepareDependencies = { ...dependencies.prepare, ...dependencies.containment }
    const submit: PaperProofSubmitDependencies = {
      ...dependencies.submit,
      ...dependencies.containment,
      mutations: dependencies.mutations,
      recovery: dependencies.recovery,
      execution: {
        ...dependencies.submit.execution,
        recover: (value) => dependencies.recoverMutation(value, MutationOperation.Submit),
      },
    }
    const cancel: PaperProofCancelDependencies = {
      ...dependencies.cancel,
      ...dependencies.containment,
      mutations: dependencies.mutations,
      recovery: dependencies.recovery,
      readIntent: dependencies.readIntent,
      execution: {
        ...dependencies.cancel.execution,
        recover: (value) => dependencies.recoverMutation(value, MutationOperation.Cancel),
      },
    }
    const recover: PaperProofRecoverDependencies = {
      ...dependencies.recover,
      ...dependencies.containment,
      mutations: dependencies.mutations,
      recovery: dependencies.recovery,
      readIntent: dependencies.readIntent,
      execution: {
        recoverSubmit: (value) => dependencies.recoverMutation(value, MutationOperation.Submit),
        recoverCancel: (value) => dependencies.recoverMutation(value, MutationOperation.Cancel),
      },
    }

    // @ts-expect-error mutation runners stay behind the validated composition boundary.
    void ({} as PaperProofPublicExports).runPaperProofSubmit
    // @ts-expect-error mutation runners stay behind the validated composition boundary.
    void ({} as PaperProofPublicExports).runPaperProofCancel
    // @ts-expect-error containment must derive the expected account from the source plan.
    void dependencies.containment.accountId
    // @ts-expect-error PREPARE cannot activate capital or access mutation execution.
    void prepare.activateCapitalGrant
    // @ts-expect-error PREPARE cannot read or write recovery state.
    void prepare.recovery
    // @ts-expect-error SUBMIT cannot issue cancellation broker I/O.
    void submit.execution.cancel
    // @ts-expect-error SUBMIT cannot read durable intent state.
    void submit.readIntent
    // @ts-expect-error the root CANCEL view cannot replace the canonical durable intent reader.
    void dependencies.cancel.readIntent
    // @ts-expect-error the root RECOVER view cannot replace the canonical durable intent reader.
    void dependencies.recover.readIntent
    // @ts-expect-error the root SUBMIT view cannot replace the canonical broker recovery lookup.
    void dependencies.submit.execution.recover
    // @ts-expect-error the root CANCEL view cannot replace the canonical broker recovery lookup.
    void dependencies.cancel.execution.recover
    // @ts-expect-error the root RECOVER view receives canonical lookup adapters at dispatch time.
    void dependencies.recover.execution
    // @ts-expect-error CANCEL cannot activate capital.
    void cancel.activateCapitalGrant
    // @ts-expect-error CANCEL cannot issue submission broker I/O.
    void cancel.execution.submit
    // @ts-expect-error RECOVER cannot issue a broker POST.
    void recover.execution.submit
    // @ts-expect-error RECOVER cannot issue a broker DELETE.
    void recover.execution.cancel
    // @ts-expect-error RECOVER cannot prepare a new intent.
    void recover.prepareIntent
    // @ts-expect-error PREPARE cannot be invoked with a mutation command.
    void runPaperProofPrepare({ command: command('SUBMIT'), sourcePlan }, prepare)

    const receipt = await Effect.runPromise(runPaperProofPrepare({ command: command('PREPARE'), sourcePlan }, prepare))
    expect(receipt.operation).toBe('PREPARE')
  })

  test('mutation program failures remain contained at the composition boundary', async () => {
    const cases = [
      { operation: 'SUBMIT' as const, options: { failRecoveryLoad: true } },
      { operation: 'CANCEL' as const, options: {} },
      { operation: 'RECOVER' as const, options: { recoveryState: { required: recoveryRequired('SUBMIT') } } },
    ]

    for (const entryCase of cases) {
      const { calls, dependencies } = fixture({ operation: entryCase.operation, ...entryCase.options })
      const exit = await Effect.runPromiseExit(runPaperProof(command(entryCase.operation), dependencies))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls.restrict).toBeGreaterThanOrEqual(1)
      expect(calls.reconcile).toBeGreaterThanOrEqual(1)
    }
  })

  test('PREPARE reconciles and derives a generation without mutation services', async () => {
    const { calls, dependencies } = fixture({ operation: 'PREPARE' })
    const receipt = await Effect.runPromise(runPaperProof(command('PREPARE'), dependencies))

    expect(receipt.generation?.generationHash).toBe(sourcePlan.authorityGenerationHash)
    expect(receipt.recoveryRequired).toBe(false)
    expect(calls).toMatchObject({
      prepare: 1,
      activate: 0,
      submit: 0,
      cancel: 0,
      recover: 0,
      reconcile: 1,
      recoveryMark: 0,
    })
  })

  test('non-PREPARE entry gate failures contain existing mutation authority before returning', async () => {
    const cases = [
      {
        operation: 'SUBMIT' as const,
        mutateCommand: (value: PaperProofCommand): PaperProofCommand => value,
        mutateDependencies: (value: PaperProofDependencies): PaperProofDependencies => ({
          ...value,
          protectedEntryToken: 'invalid-protected-entry-token',
        }),
      },
      {
        operation: 'CANCEL' as const,
        mutateCommand: (value: PaperProofCommand): PaperProofCommand => ({
          ...value,
          proofPlanHash: hash('0'),
        }),
        mutateDependencies: (value: PaperProofDependencies): PaperProofDependencies => value,
      },
      {
        operation: 'RECOVER' as const,
        mutateCommand: (value: PaperProofCommand): PaperProofCommand => value,
        mutateDependencies: (value: PaperProofDependencies): PaperProofDependencies => ({
          ...value,
          runtime: {
            ...value.runtime,
            imageDigest: `sha256:${hash('0')}`,
          },
        }),
      },
    ]

    for (const entryCase of cases) {
      const { calls, dependencies } = fixture({ operation: entryCase.operation })
      const exit = await Effect.runPromiseExit(
        runPaperProof(
          entryCase.mutateCommand(command(entryCase.operation)),
          entryCase.mutateDependencies(dependencies),
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls.restrict).toBe(1)
      expect(calls.reconcile).toBe(1)
      expect(calls.recoveryLoad).toBe(0)
      expect(calls.completionLoad).toBe(0)
      expect(calls.prepareIntent).toBe(0)
      expect(calls.mutationRead).toBe(0)
      expect(calls.activate).toBe(0)
      expect(calls.submit).toBe(0)
      expect(calls.cancel).toBe(0)
      expect(calls.recover).toBe(0)
    }
  })

  test('PREPARE entry gate failure remains read-only without authority containment', async () => {
    const { calls, dependencies } = fixture({ operation: 'PREPARE' })
    const exit = await Effect.runPromiseExit(
      runPaperProof(command('PREPARE'), {
        ...dependencies,
        protectedEntryToken: 'invalid-protected-entry-token',
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.restrict).toBe(0)
    expect(calls.reconcile).toBe(0)
    expect(calls.prepare).toBe(0)
  })

  test('PREPARE entry mismatch contains authority when the runtime is mutation-capable', async () => {
    const { calls, dependencies } = fixture({ operation: 'PREPARE' })
    const exit = await Effect.runPromiseExit(
      runPaperProof(command('PREPARE'), {
        ...dependencies,
        runtime: runtime(true),
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.restrict).toBe(1)
    expect(calls.reconcile).toBe(1)
    expect(calls.prepare).toBe(0)
    expect(calls.recoveryLoad).toBe(0)
    expect(calls.completionLoad).toBe(0)
    expect(calls.prepareIntent).toBe(0)
    expect(calls.mutationRead).toBe(0)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.cancel).toBe(0)
    expect(calls.recover).toBe(0)
  })

  test('mutation entry rejects a consistency delay that consumes the reserved execution window', async () => {
    for (const operation of ['SUBMIT', 'CANCEL', 'RECOVER'] as const) {
      const { calls, dependencies } = fixture({ operation })
      const exit = await Effect.runPromiseExit(
        runPaperProof(
          {
            ...command(operation),
            timeoutMs: 1_000,
            containmentIoTimeoutMs: 100,
            consistencyDelayMs: 700,
          },
          dependencies,
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls.restrict).toBe(1)
      expect(calls.reconcile).toBe(1)
      expect(calls.recoveryLoad).toBe(0)
      expect(calls.completionLoad).toBe(0)
      expect(calls.prepareIntent).toBe(0)
      expect(calls.mutationRead).toBe(0)
      expect(calls.activate).toBe(0)
      expect(calls.submit).toBe(0)
      expect(calls.cancel).toBe(0)
      expect(calls.recover).toBe(0)
    }
  })

  test('SUBMIT writes its marker after activation and post-activation exact reconciliation', async () => {
    const { calls, dependencies, recoveryState, sequence } = fixture({ operation: 'SUBMIT' })
    const receipt = await Effect.runPromise(runPaperProof(command('SUBMIT'), dependencies))

    expect(receipt.mutation?.eventType).toBe(MutationEventType.SubmitAccepted)
    expect(receipt.recoveryRequired).toBe(false)
    expect(recoveryState.required).toBeUndefined()
    expect(recoveryState.completion?.operation).toBe('SUBMIT')
    expect(calls.submit).toBe(1)
    expect(sequence.indexOf('activate')).toBeLessThan(sequence.indexOf('reconcile:2'))
    expect(sequence.indexOf('reconcile:2')).toBeLessThan(sequence.indexOf('submit:mutation-started'))
    expect(sequence.indexOf('submit:mutation-started')).toBeLessThan(sequence.indexOf('recovery:mark:SUBMIT'))
    expect(sequence.indexOf('recovery:mark:SUBMIT')).toBeLessThan(sequence.indexOf('submit'))
  })

  test('SUBMIT preflight marker load failure performs bounded containment', async () => {
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', failRecoveryLoad: true })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
    expect(calls.reconcile).toBe(1)
  })

  test('containment restricts authority when the injected restriction clock fails', async () => {
    const { calls, dependencies } = fixture({
      operation: 'SUBMIT',
      failRecoveryLoad: true,
      failClockCalls: [1],
    })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.clock).toBe(1)
    expect(calls.restrict).toBe(1)
    expect(calls.reconcile).toBe(1)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
  })

  test('containment restricts authority when the injected restriction clock times out', async () => {
    const { calls, dependencies } = fixture({
      operation: 'SUBMIT',
      failRecoveryLoad: true,
      neverClockCalls: [1],
    })
    const bounded = boundedCommand('SUBMIT')
    const exit = await runWithTestClock(runPaperProof(bounded, dependencies), bounded.timeoutMs)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.clock).toBe(1)
    expect(calls.restrict).toBe(1)
    expect(calls.reconcile).toBe(1)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
  })

  test('stalled SUBMIT preflight marker load returns within deadline and contains authority', async () => {
    const { calls, dependencies, sequence } = fixture({ operation: 'SUBMIT', neverRecoveryLoad: true })
    const bounded = boundedCommand('SUBMIT')
    const exit = await runWithTestClock(runPaperProof(bounded, dependencies), bounded.timeoutMs)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
    expect(calls.reconcile).toBe(1)
    expect(sequence).toEqual(['recovery:load', 'restrict', 'reconcile:1'])
  })

  test('SUBMIT initial reconciliation failure performs containment before intent preparation', async () => {
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', failReconcileCalls: [1] })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.reconcile).toBe(2)
    expect(calls.prepareIntent).toBe(0)
    expect(calls.mutationRead).toBe(0)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
  })

  test('stalled SUBMIT initial reconciliation returns within deadline and performs containment', async () => {
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', neverReconcileCalls: [1] })
    const bounded = boundedCommand('SUBMIT')
    const exit = await runWithTestClock(runPaperProof(bounded, dependencies), bounded.timeoutMs)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.reconcile).toBe(2)
    expect(calls.prepareIntent).toBe(0)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
  })

  test('SUBMIT intent preparation failure performs containment before durable mutation reads', async () => {
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', failPrepareIntent: true })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.reconcile).toBe(2)
    expect(calls.prepareIntent).toBe(1)
    expect(calls.mutationRead).toBe(0)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
  })

  test('stalled SUBMIT intent preparation returns within deadline and performs containment', async () => {
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', neverPrepareIntent: true })
    const bounded = boundedCommand('SUBMIT')
    const exit = await runWithTestClock(runPaperProof(bounded, dependencies), bounded.timeoutMs)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.reconcile).toBe(2)
    expect(calls.prepareIntent).toBe(1)
    expect(calls.mutationRead).toBe(0)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
  })

  test('SUBMIT durable cancellation read failure performs containment before activation', async () => {
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', failMutationReadCalls: [1] })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.reconcile).toBe(2)
    expect(calls.prepareIntent).toBe(1)
    expect(calls.mutationRead).toBe(1)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
  })

  test('stalled SUBMIT durable submit read returns within deadline and performs containment', async () => {
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', neverMutationReadCalls: [2] })
    const bounded = boundedCommand('SUBMIT')
    const exit = await runWithTestClock(runPaperProof(bounded, dependencies), bounded.timeoutMs)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.reconcile).toBe(2)
    expect(calls.prepareIntent).toBe(1)
    expect(calls.mutationRead).toBe(2)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
  })

  test('activation failure creates no SUBMIT marker and performs no POST', async () => {
    const { calls, dependencies, recoveryState } = fixture({ operation: 'SUBMIT', failActivation: true })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.required).toBeUndefined()
    expect(calls.recoveryMark).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
  })

  test('post-activation reconciliation timeout creates no marker and retry submits once', async () => {
    const recoveryState: RecoveryState = {}
    const first = fixture({ operation: 'SUBMIT', recoveryState, neverReconcileCalls: [2] })
    const bounded = boundedCommand('SUBMIT')
    const exit = await runWithTestClock(runPaperProof(bounded, first.dependencies), bounded.timeoutMs)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(first.calls.activate).toBe(1)
    expect(first.calls.submit).toBe(0)
    expect(first.calls.recoveryMark).toBe(0)
    expect(recoveryState.required).toBeUndefined()

    const retry = fixture({ operation: 'SUBMIT', recoveryState })
    const receipt = await Effect.runPromise(runPaperProof(command('SUBMIT'), retry.dependencies))

    expect(receipt.mutation?.eventType).toBe(MutationEventType.SubmitAccepted)
    expect(retry.calls.submit).toBe(1)
  })

  test('final SUBMIT prerequisite failure creates no marker and performs no POST', async () => {
    const { calls, dependencies, recoveryState, sequence } = fixture({
      operation: 'SUBMIT',
      failSubmitPrerequisite: true,
    })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.required).toBeUndefined()
    expect(calls.recoveryMark).toBe(0)
    expect(calls.submit).toBe(0)
    expect(sequence).toContain('submit:preflight')
    expect(sequence).not.toContain('submit:mutation-started')
  })

  test('SUBMIT crash after marker is lookup-recovered without a second POST', async () => {
    const recoveryState: RecoveryState = {}
    const first = fixture({ operation: 'SUBMIT', recoveryState, failSubmit: true })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), first.dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(first.calls.submit).toBe(1)
    expect(recoveryState.required?.operation).toBe('SUBMIT')

    const retry = fixture({
      operation: 'RECOVER',
      recoveryState,
      latestSubmit: event(MutationEventType.SubmitStarted),
      recoverEvent: event(MutationEventType.RecoveryFound, MutationOperation.Submit),
      reconciliationUnknownCounts: [1, 0],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('RECOVER'), retry.dependencies))

    expect(receipt.recoveryRequired).toBe(false)
    expect(retry.calls.submit).toBe(0)
    expect(retry.calls.recover).toBe(1)
    expect(recoveryState.required).toBeUndefined()
    expect(recoveryState.completion?.operation).toBe('SUBMIT')
  })

  test('SUBMIT timeout after marker is lookup-recovered without a second POST', async () => {
    const recoveryState: RecoveryState = {}
    const first = fixture({ operation: 'SUBMIT', recoveryState, neverSubmitAfterMarker: true })
    const bounded = boundedCommand('SUBMIT')
    const exit = await runWithTestClock(runPaperProof(bounded, first.dependencies), bounded.timeoutMs)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(first.calls.submit).toBe(1)
    expect(recoveryState.required?.operation).toBe('SUBMIT')

    const retry = fixture({
      operation: 'RECOVER',
      recoveryState,
      latestSubmit: event(MutationEventType.SubmitStarted),
      recoverEvent: event(MutationEventType.RecoveryFound, MutationOperation.Submit),
      reconciliationUnknownCounts: [1, 0],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('RECOVER'), retry.dependencies))

    expect(receipt.recoveryRequired).toBe(false)
    expect(retry.calls.submit).toBe(0)
    expect(retry.calls.recover).toBe(1)
  })

  test('terminal SUBMIT replay retires a matching durable marker', async () => {
    const accepted = event(MutationEventType.SubmitAccepted)
    const recoveryState: RecoveryState = { required: recoveryRequired('SUBMIT') }
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', latestSubmit: accepted, recoveryState })
    const receipt = await Effect.runPromise(runPaperProof(command('SUBMIT'), dependencies))

    expect(receipt.mutation).toEqual(accepted)
    expect(receipt.recoveryRequired).toBe(false)
    expect(recoveryState.required).toBeUndefined()
    expect(recoveryState.completion?.operation).toBe('SUBMIT')
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.recover).toBe(0)
    expect(calls.recoveryComplete).toBe(1)
  })

  test('duplicate accepted SUBMIT without a marker performs no activation and no POST', async () => {
    const accepted = event(MutationEventType.SubmitAccepted)
    const { calls, dependencies } = fixture({ operation: 'SUBMIT', latestSubmit: accepted })
    const receipt = await Effect.runPromise(runPaperProof(command('SUBMIT'), dependencies))

    expect(receipt.mutation).toEqual(accepted)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.recover).toBe(0)
    expect(calls.recoveryMark).toBe(0)
    expect(calls.recoveryComplete).toBe(0)
  })

  test('SUBMIT preserves an unresolved cancellation marker', async () => {
    const recoveryState: RecoveryState = { required: recoveryRequired('CANCEL') }
    const { calls, dependencies, sequence } = fixture({ operation: 'SUBMIT', recoveryState })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.required?.operation).toBe('CANCEL')
    expect(calls.recoveryMark).toBe(0)
    expect(calls.submit).toBe(0)
    expect(sequence).not.toContain('submit:mutation-started')
  })

  test('SUBMIT cannot complete over a durable cancellation mutation', async () => {
    const accepted = event(MutationEventType.SubmitAccepted)
    const cancelStarted = {
      ...event(MutationEventType.CancelStarted, MutationOperation.Cancel),
      occurredAt: '2026-07-31T08:00:02.000Z',
    }
    const staleCompletion = recoveryCompletion('SUBMIT', accepted, false)
    const recoveryState: RecoveryState = { completion: staleCompletion }
    const { calls, dependencies } = fixture({
      operation: 'SUBMIT',
      latestSubmit: accepted,
      latestCancel: cancelStarted,
      recoveryState,
    })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.completion).toEqual(staleCompletion)
    expect(calls.recoveryComplete).toBe(0)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.restrict).toBe(1)
  })

  test('SUBMIT completion fails closed when cancellation starts after broker success', async () => {
    const cancelStarted = {
      ...event(MutationEventType.CancelStarted, MutationOperation.Cancel),
      occurredAt: '2026-07-31T08:00:02.000Z',
    }
    const { calls, dependencies, mutationState, recoveryState } = fixture({
      operation: 'SUBMIT',
      cancelAfterSubmitEvent: cancelStarted,
    })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(mutationState.cancel).toEqual(cancelStarted)
    expect(recoveryState.required?.operation).toBe('SUBMIT')
    expect(recoveryState.completion).toBeUndefined()
    expect(calls.submit).toBe(1)
    expect(calls.recoveryComplete).toBe(0)
    expect(calls.restrict).toBe(1)
  })

  test('atomic completion guard rejects cancellation racing the final store commit', async () => {
    const cancelStarted = {
      ...event(MutationEventType.CancelStarted, MutationOperation.Cancel),
      occurredAt: '2026-07-31T08:00:02.000Z',
    }
    const { calls, dependencies, mutationState, recoveryState } = fixture({
      operation: 'SUBMIT',
      cancelOnRecoveryComplete: cancelStarted,
    })
    const exit = await Effect.runPromiseExit(runPaperProof(command('SUBMIT'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(mutationState.cancel).toEqual(cancelStarted)
    expect(recoveryState.required?.operation).toBe('SUBMIT')
    expect(recoveryState.completion).toBeUndefined()
    expect(calls.submit).toBe(1)
    expect(calls.recoveryComplete).toBe(1)
    expect(calls.restrict).toBe(1)
  })

  test('CANCEL with no durable submit creates no marker and no DELETE', async () => {
    const { calls, dependencies, recoveryState } = fixture({ operation: 'CANCEL' })
    const exit = await Effect.runPromiseExit(runPaperProof(command('CANCEL'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.required).toBeUndefined()
    expect(calls.recoveryMark).toBe(0)
    expect(calls.cancel).toBe(0)
  })

  test('CANCEL with rejected or denied submit creates no marker and no DELETE', async () => {
    for (const eventType of [MutationEventType.SubmitRejected, MutationEventType.SubmitDenied]) {
      const { calls, dependencies, recoveryState } = fixture({
        operation: 'CANCEL',
        latestSubmit: event(eventType),
      })
      const exit = await Effect.runPromiseExit(runPaperProof(command('CANCEL'), dependencies))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(recoveryState.required).toBeUndefined()
      expect(calls.recoveryMark).toBe(0)
      expect(calls.cancel).toBe(0)
    }
  })

  test('CANCEL with unknown submit lacking an order creates no marker', async () => {
    const { calls, dependencies, recoveryState } = fixture({
      operation: 'CANCEL',
      latestSubmit: event(MutationEventType.SubmitUnknown),
    })
    const exit = await Effect.runPromiseExit(runPaperProof(command('CANCEL'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.required).toBeUndefined()
    expect(calls.recoveryMark).toBe(0)
    expect(calls.cancel).toBe(0)
  })

  test('final CANCEL prerequisite failure creates no marker and performs no DELETE', async () => {
    const { calls, dependencies, recoveryState, sequence } = fixture({
      operation: 'CANCEL',
      latestSubmit: event(MutationEventType.SubmitAccepted),
      intentSnapshots: [acknowledgedIntent],
      failCancelPrerequisite: true,
    })
    const exit = await Effect.runPromiseExit(runPaperProof(command('CANCEL'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.required).toBeUndefined()
    expect(calls.recoveryMark).toBe(0)
    expect(calls.cancel).toBe(0)
    expect(sequence).toContain('cancel:preflight')
    expect(sequence).not.toContain('cancel:mutation-started')
  })

  test('CANCEL writes marker only after durable order and intent preflight', async () => {
    const { calls, dependencies, sequence } = fixture({
      operation: 'CANCEL',
      latestSubmit: event(MutationEventType.SubmitAccepted),
      intentSnapshots: [acknowledgedIntent, canceledIntent],
      recoverEvent: event(MutationEventType.RecoveryFound, MutationOperation.Cancel),
    })
    const receipt = await Effect.runPromise(runPaperProof(command('CANCEL'), dependencies))

    expect(receipt.recoveryRequired).toBe(false)
    expect(calls.cancel).toBe(1)
    expect(sequence.indexOf('intent:read:1')).toBeLessThan(sequence.indexOf('cancel:mutation-started'))
    expect(sequence.indexOf('cancel:mutation-started')).toBeLessThan(sequence.indexOf('recovery:mark:CANCEL'))
    expect(sequence.indexOf('recovery:mark:CANCEL')).toBeLessThan(sequence.indexOf('cancel'))
  })

  test('accepted pending cancellation keeps marker until durable intent becomes terminal', async () => {
    const recoveryState: RecoveryState = {}
    const first = fixture({
      operation: 'CANCEL',
      recoveryState,
      latestSubmit: event(MutationEventType.SubmitAccepted),
      intentSnapshots: [acknowledgedIntent, acknowledgedIntent],
      cancelEvent: event(MutationEventType.CancelAccepted, MutationOperation.Cancel),
      recoverEvent: event(MutationEventType.RecoveryFound, MutationOperation.Cancel),
      reconciliationUnknownCounts: [0, 1],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('CANCEL'), first.dependencies))

    expect(receipt.recoveryRequired).toBe(true)
    expect(recoveryState.required?.operation).toBe('CANCEL')
    expect(recoveryState.completion).toBeUndefined()
    expect(first.calls.recoveryComplete).toBe(0)

    const later = fixture({
      operation: 'RECOVER',
      recoveryState,
      latestCancel: event(MutationEventType.CancelAccepted, MutationOperation.Cancel),
      intentSnapshots: [canceledIntent],
      recoverEvent: event(MutationEventType.RecoveryFound, MutationOperation.Cancel),
      reconciliationUnknownCounts: [1, 0],
    })
    const recovered = await Effect.runPromise(runPaperProof(command('RECOVER'), later.dependencies))

    expect(recovered.recoveryRequired).toBe(false)
    expect(recoveryState.required).toBeUndefined()
    expect(recoveryState.completion?.operation).toBe('CANCEL')
    expect(later.calls.cancel).toBe(0)
    expect(later.calls.recover).toBe(1)
  })

  test('CANCEL crash after marker is recovered without another DELETE', async () => {
    const recoveryState: RecoveryState = {}
    const first = fixture({
      operation: 'CANCEL',
      recoveryState,
      latestSubmit: event(MutationEventType.SubmitAccepted),
      intentSnapshots: [acknowledgedIntent],
      failCancel: true,
    })
    const exit = await Effect.runPromiseExit(runPaperProof(command('CANCEL'), first.dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(first.calls.cancel).toBe(1)
    expect(recoveryState.required?.operation).toBe('CANCEL')

    const retry = fixture({
      operation: 'RECOVER',
      recoveryState,
      latestCancel: event(MutationEventType.CancelStarted, MutationOperation.Cancel),
      intentSnapshots: [canceledIntent],
      recoverEvent: event(MutationEventType.RecoveryFound, MutationOperation.Cancel),
      reconciliationUnknownCounts: [1, 0],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('RECOVER'), retry.dependencies))

    expect(receipt.recoveryRequired).toBe(false)
    expect(retry.calls.cancel).toBe(0)
    expect(retry.calls.recover).toBe(1)
  })

  test('CANCEL timeout after marker is recovered without a second DELETE', async () => {
    const recoveryState: RecoveryState = {}
    const first = fixture({
      operation: 'CANCEL',
      recoveryState,
      latestSubmit: event(MutationEventType.SubmitAccepted),
      intentSnapshots: [acknowledgedIntent],
      neverCancelAfterMarker: true,
    })
    const bounded = boundedCommand('CANCEL')
    const exit = await runWithTestClock(runPaperProof(bounded, first.dependencies), bounded.timeoutMs)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(first.calls.cancel).toBe(1)
    expect(recoveryState.required?.operation).toBe('CANCEL')

    const retry = fixture({
      operation: 'RECOVER',
      recoveryState,
      latestCancel: event(MutationEventType.CancelStarted, MutationOperation.Cancel),
      intentSnapshots: [canceledIntent],
      recoverEvent: event(MutationEventType.RecoveryFound, MutationOperation.Cancel),
      reconciliationUnknownCounts: [1, 0],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('RECOVER'), retry.dependencies))

    expect(receipt.recoveryRequired).toBe(false)
    expect(retry.calls.cancel).toBe(0)
    expect(retry.calls.recover).toBe(1)
  })

  test('RECOVER dispatches according to durable SUBMIT marker', async () => {
    const recoveryState: RecoveryState = { required: recoveryRequired('SUBMIT') }
    const { calls, dependencies, sequence } = fixture({
      operation: 'RECOVER',
      recoveryState,
      latestSubmit: event(MutationEventType.SubmitStarted),
      recoverEvent: event(MutationEventType.RecoveryFound, MutationOperation.Submit),
      reconciliationUnknownCounts: [1, 0],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('RECOVER'), dependencies))

    expect(receipt.recoveryRequired).toBe(false)
    expect(calls.submit).toBe(0)
    expect(calls.cancel).toBe(0)
    expect(calls.recover).toBe(1)
    expect(sequence).toContain(`recover:${MutationOperation.Submit}`)
  })

  test('ambiguous terminal SUBMIT completion retry reports post-containment restriction truth', async () => {
    const accepted = event(MutationEventType.SubmitAccepted)
    const recoveryState: RecoveryState = { required: recoveryRequired('SUBMIT') }
    const first = fixture({
      operation: 'SUBMIT',
      recoveryState,
      latestSubmit: accepted,
      neverCompleteAfterCommit: true,
      reconciliationUnknownCounts: [0, 0],
    })
    const bounded = boundedCommand('SUBMIT')
    const exit = await runWithTestClock(runPaperProof(bounded, first.dependencies), bounded.timeoutMs)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.required).toBeUndefined()
    expect(recoveryState.completion?.restricted).toBe(false)
    expect(first.calls.submit).toBe(0)
    expect(first.calls.restrict).toBe(1)

    const retry = fixture({ operation: 'RECOVER', recoveryState, latestSubmit: accepted })
    const receipt = await Effect.runPromise(runPaperProof(command('RECOVER'), retry.dependencies))

    expect(receipt.recoveryRequired).toBe(false)
    expect(receipt.restricted).toBe(true)
    expect(recoveryState.completion?.restricted).toBe(true)
    expect(retry.calls.restrict).toBe(1)
    expect(retry.calls.recover).toBe(0)
    expect(retry.calls.recoveryLoad).toBe(1)
    expect(retry.calls.completionLoad).toBe(1)
    expect(retry.calls.recoveryComplete).toBe(1)
    expect(retry.calls.reconcile).toBe(1)
  })

  test('RECOVER supersedes stale SUBMIT completion after cancellation starts before marker commit', async () => {
    const accepted = event(MutationEventType.SubmitAccepted)
    const cancelStarted = {
      ...event(MutationEventType.CancelStarted, MutationOperation.Cancel),
      occurredAt: '2026-07-31T08:00:02.000Z',
    }
    const staleCompletion = recoveryCompletion('SUBMIT', accepted, false)
    const recoveryState: RecoveryState = { completion: staleCompletion }
    const mutationState: MutationState = { submit: accepted }
    const interruptedCancel = fixture({
      operation: 'CANCEL',
      recoveryState,
      mutationState,
      cancelStartedEvent: cancelStarted,
      failRecoveryMark: true,
      intentSnapshots: [acknowledgedIntent],
    })
    const firstExit = await Effect.runPromiseExit(runPaperProof(command('CANCEL'), interruptedCancel.dependencies))

    expect(Exit.isFailure(firstExit)).toBe(true)
    expect(mutationState.cancel).toEqual(cancelStarted)
    expect(recoveryState.required).toBeUndefined()
    expect(recoveryState.completion).toEqual(staleCompletion)
    expect(interruptedCancel.calls.cancel).toBe(0)
    expect(interruptedCancel.calls.restrict).toBe(1)

    const retry = fixture({
      operation: 'RECOVER',
      recoveryState,
      mutationState,
      intentSnapshots: [canceledIntent],
      recoverEvent: event(MutationEventType.RecoveryFound, MutationOperation.Cancel),
      reconciliationUnknownCounts: [1, 0],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('RECOVER'), retry.dependencies))

    expect(receipt.mutation?.operation).toBe(MutationOperation.Cancel)
    expect(receipt.recoveryRequired).toBe(false)
    expect(receipt.restricted).toBe(true)
    expect(recoveryState.required).toBeUndefined()
    expect(recoveryState.completion?.operation).toBe('CANCEL')
    expect(recoveryState.completion?.mutation.operation).toBe(MutationOperation.Cancel)
    expect(retry.calls.recoveryMark).toBe(1)
    expect(retry.calls.recover).toBe(1)
    expect(retry.sequence).toContain(`recover:${MutationOperation.Cancel}`)
  })

  test('RECOVER reconstructs settled receipt when completion and marker are absent', async () => {
    const settled = event(MutationEventType.RecoveryFound, MutationOperation.Cancel)
    const { calls, dependencies } = fixture({
      operation: 'RECOVER',
      latestCancel: settled,
      intentSnapshots: [canceledIntent],
      reconciliationUnknownCounts: [0],
    })
    const receipt = await Effect.runPromise(runPaperProof(command('RECOVER'), dependencies))

    expect(receipt.mutation).toEqual(settled)
    expect(receipt.recoveryRequired).toBe(false)
    expect(receipt.restricted).toBe(true)
    expect(calls.recover).toBe(0)
  })

  test('RECOVER never looks up marker without durable mutation', async () => {
    const recoveryState: RecoveryState = { required: recoveryRequired('SUBMIT') }
    const { calls, dependencies } = fixture({ operation: 'RECOVER', recoveryState })
    const exit = await Effect.runPromiseExit(runPaperProof(command('RECOVER'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.required).toBeDefined()
    expect(calls.recover).toBe(0)
    expect(calls.restrict).toBeGreaterThanOrEqual(1)
    expect(calls.reconcile).toBeGreaterThanOrEqual(1)
  })

  test('recovery marker load failure still performs bounded containment', async () => {
    const recoveryState: RecoveryState = { required: recoveryRequired('SUBMIT') }
    const { calls, dependencies } = fixture({ operation: 'RECOVER', recoveryState, failRecoveryLoad: true })
    const exit = await Effect.runPromiseExit(runPaperProof(command('RECOVER'), dependencies))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.required).toBeDefined()
    expect(calls.recover).toBe(0)
    expect(calls.restrict).toBeGreaterThanOrEqual(1)
    expect(calls.reconcile).toBeGreaterThanOrEqual(1)
  })

  test('stalled completion load returns within deadline and contains authority', async () => {
    const recoveryState: RecoveryState = { required: recoveryRequired('CANCEL') }
    const { calls, dependencies } = fixture({ operation: 'RECOVER', recoveryState, neverCompletionLoad: true })
    const bounded = boundedCommand('RECOVER')
    const exit = await runWithTestClock(runPaperProof(bounded, dependencies), bounded.timeoutMs)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(recoveryState.required).toBeDefined()
    expect(calls.recover).toBe(0)
    expect(calls.restrict).toBeGreaterThanOrEqual(1)
    expect(calls.reconcile).toBeGreaterThanOrEqual(1)
  })

  test('protected source entry invokes PREPARE without package metadata changes', async () => {
    const { dependencies } = fixture({ operation: 'PREPARE' })
    const receipt = await Effect.runPromise(
      runPaperProofCommand(
        {
          command: command('PREPARE'),
          protectedEntryToken: protectedEntryToken(sourcePlan),
        },
        dependencies,
      ),
    )

    expect(receipt.operation).toBe('PREPARE')
    expect(receipt.generation?.generationHash).toBe(sourcePlan.authorityGenerationHash)
  })

  test('malformed mutation envelopes contain trusted runtime authority before returning contract failure', async () => {
    for (const operation of ['SUBMIT', 'CANCEL', 'RECOVER'] as const) {
      const { calls, dependencies } = fixture({ operation })
      const exit = await Effect.runPromiseExit(
        runPaperProofCommand(
          {
            command: {
              ...command(operation),
              proofPlanHash: 'malformed-proof-plan-hash',
            },
            protectedEntryToken: protectedEntryToken(sourcePlan),
          },
          dependencies,
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls.restrict).toBe(1)
      expect(calls.reconcile).toBe(1)
      expect(calls.recoveryLoad).toBe(0)
      expect(calls.completionLoad).toBe(0)
      expect(calls.prepareIntent).toBe(0)
      expect(calls.mutationRead).toBe(0)
      expect(calls.activate).toBe(0)
      expect(calls.submit).toBe(0)
      expect(calls.cancel).toBe(0)
      expect(calls.recover).toBe(0)
    }
  })

  test('malformed PREPARE and read-only mutation envelopes do not invoke authority containment', async () => {
    const prepare = fixture({ operation: 'PREPARE' })
    const prepareExit = await Effect.runPromiseExit(
      runPaperProofCommand(
        {
          command: { ...command('PREPARE'), proofPlanHash: 'malformed-proof-plan-hash' },
          protectedEntryToken: protectedEntryToken(sourcePlan),
        },
        prepare.dependencies,
      ),
    )
    expect(Exit.isFailure(prepareExit)).toBe(true)
    expect(prepare.calls.restrict).toBe(0)
    expect(prepare.calls.reconcile).toBe(0)

    const submit = fixture({ operation: 'SUBMIT' })
    const submitExit = await Effect.runPromiseExit(
      runPaperProofCommand(
        {
          command: { ...command('SUBMIT'), proofPlanHash: 'malformed-proof-plan-hash' },
          protectedEntryToken: protectedEntryToken(sourcePlan),
        },
        {
          ...submit.dependencies,
          runtime: runtime(false),
        },
      ),
    )
    expect(Exit.isFailure(submitExit)).toBe(true)
    expect(submit.calls.restrict).toBe(0)
    expect(submit.calls.reconcile).toBe(0)
  })

  test('malformed PREPARE contains authority when the runtime is mutation-capable', async () => {
    const { calls, dependencies } = fixture({ operation: 'PREPARE' })
    const exit = await Effect.runPromiseExit(
      runPaperProofCommand(
        {
          command: { ...command('PREPARE'), proofPlanHash: 'malformed-proof-plan-hash' },
          protectedEntryToken: protectedEntryToken(sourcePlan),
        },
        {
          ...dependencies,
          runtime: runtime(true),
        },
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.restrict).toBe(1)
    expect(calls.reconcile).toBe(1)
    expect(calls.prepare).toBe(0)
    expect(calls.activate).toBe(0)
    expect(calls.submit).toBe(0)
    expect(calls.cancel).toBe(0)
    expect(calls.recover).toBe(0)
  })

  test('unrecognized malformed operations contain mutation-capable runtime authority', async () => {
    const inputs = [
      {
        command: { ...command('SUBMIT'), operation: 'SUBMT' },
        protectedEntryToken: protectedEntryToken(sourcePlan),
      },
      {
        command: {
          proofPlanHash: sourcePlan.proofPlanHash,
          qualificationRunId: sourcePlan.qualificationRunId,
        },
        protectedEntryToken: protectedEntryToken(sourcePlan),
      },
      {
        protectedEntryToken: protectedEntryToken(sourcePlan),
      },
    ]

    for (const input of inputs) {
      const { calls, dependencies } = fixture({ operation: 'SUBMIT' })
      const exit = await Effect.runPromiseExit(runPaperProofCommand(input, dependencies))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls.restrict).toBe(1)
      expect(calls.reconcile).toBe(1)
      expect(calls.recoveryLoad).toBe(0)
      expect(calls.completionLoad).toBe(0)
      expect(calls.prepareIntent).toBe(0)
      expect(calls.mutationRead).toBe(0)
      expect(calls.activate).toBe(0)
      expect(calls.submit).toBe(0)
      expect(calls.cancel).toBe(0)
      expect(calls.recover).toBe(0)
    }
  })

  test('executable default entry remains fail-closed without a pinned plan', async () => {
    const exit = await Effect.runPromiseExit(paperProofCommandEntryGate)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain('intentionally disabled')
  })
})
