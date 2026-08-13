import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import type { ApplicationPlanFor } from '../app'
import {
  ExecutionControllerOutcome,
  type ExecutionControllerStatus,
  type ExecutionControllerStatusProjection,
  ExecutionControllerStatusStoreError,
  type ExecutionControllerStatusStoreShape,
} from '../execution/controller-status'
import { TransientExecutionFailure, type AdvanceExecutionCommand } from '../execution/advance'
import {
  executeNativeExecutionAdvance,
  executionControllerConfig,
  makeNativeExecutionRuntimeAdapter,
  nativeExecutionRuntimeInitializationTimeoutMs,
} from './native-execution-runtime'

const hash = (character: string): string => character.repeat(64)
const sourceRevision = 'a'.repeat(40)
const completedAt = '2026-08-13T18:00:00.000Z'

const marketDataBinding = {
  snapshotId: hash('8'),
  publicationAsOf: '2026-08-12',
  calendarVersion: 'xnys-2026-v1',
  bounds: {
    schemaVersion: 'bayn.evaluation-bounds.v1' as const,
    dataStart: '2020-01-01',
    dataEnd: '2026-08-12',
    lookbackStart: '2025-01-01',
    evaluationStart: '2026-01-01',
    evaluationEnd: '2026-08-12',
  },
}

type PlanOverrides = {
  readonly imageDigest?: string
  readonly cyclePollIntervalMs?: number
  readonly qualificationRunId?: string
  readonly marketDataBinding?: typeof marketDataBinding
}

const command: AdvanceExecutionCommand = {
  controllerKey: hash('1'),
  epoch: 4,
  sequence: 7,
  issuedAt: completedAt,
  sourceRevision,
}

const driver = {
  advance: Effect.succeed({
    observation: {
      result: 'SUCCESS' as const,
      observedAt: completedAt,
      outcome: 'NOT_DUE' as const,
    },
  }),
  maintainReconciliation: Effect.void,
  nextDelayMs: 30_000,
  wait: () => Effect.void,
}

const status = (overrides: Partial<ExecutionControllerStatus> = {}): ExecutionControllerStatus => ({
  schemaVersion: 1,
  controllerKey: command.controllerKey,
  epoch: command.epoch,
  lastSequence: command.sequence,
  lastOutcome: ExecutionControllerOutcome.Blocked,
  lastReceiptHash: hash('2'),
  completedAt,
  nextDueAt: '2026-08-13T18:00:30.000Z',
  ...overrides,
})

const statusStore = (
  project: (candidate: ExecutionControllerStatus) => ExecutionControllerStatusProjection,
): ExecutionControllerStatusStoreShape => ({
  project: (candidate) => Effect.succeed(project(candidate)),
  read: () => Effect.succeed(null),
})

const plan = (overrides: PlanOverrides = {}): ApplicationPlanFor<'AutonomousService'> =>
  ({
    _tag: 'AutonomousService',
    config: {
      alpaca: {
        identity: { identityHash: command.controllerKey },
        authorityGenerationHash: hash('4'),
        reconciliationIntervalMs: 30_000,
      },
      build: { sourceRevision, imageDigest: overrides.imageDigest ?? `sha256:${hash('3')}` },
      qualificationRunId: overrides.qualificationRunId ?? hash('9'),
      clickhouse: overrides.marketDataBinding ?? marketDataBinding,
      capitalActivationRequestJson: '{"schemaVersion":"test"}',
      cyclePollIntervalMs: overrides.cyclePollIntervalMs ?? 30_000,
      operationTimeoutMs: 30_000,
    },
    strategy: {
      provenance: {
        strategy: {
          name: 'risk-balanced-trend',
          behaviorHash: hash('5'),
          parameterHash: hash('6'),
          parameterSchemaVersion: 'v4',
        },
      },
    },
    strategyProtocolHash: hash('7'),
  }) as ApplicationPlanFor<'AutonomousService'>

describe('native execution runtime', () => {
  test('binds controller identity to code, authority, qualification, market data, and cadence', () => {
    const first = executionControllerConfig(plan())
    const replay = executionControllerConfig(plan())
    const changedPlans = [
      plan({ imageDigest: `sha256:${hash('a')}` }),
      plan({ cyclePollIntervalMs: 60_000 }),
      plan({ qualificationRunId: hash('a') }),
      plan({ marketDataBinding: { ...marketDataBinding, snapshotId: hash('b') } }),
      plan({ marketDataBinding: { ...marketDataBinding, publicationAsOf: '2026-08-13' } }),
      plan({ marketDataBinding: { ...marketDataBinding, calendarVersion: 'xnys-2026-v2' } }),
      ...Object.keys(marketDataBinding.bounds).map((field) =>
        plan({
          marketDataBinding: {
            ...marketDataBinding,
            bounds: {
              ...marketDataBinding.bounds,
              [field]: `${marketDataBinding.bounds[field as keyof typeof marketDataBinding.bounds]}-changed`,
            },
          },
        }),
      ),
    ].map(executionControllerConfig)

    expect(Result.isSuccess(first)).toBe(true)
    expect(replay).toEqual(first)
    if (Result.isFailure(first)) return
    expect(first.success.controllerKey).toBe(command.controllerKey)
    for (const changed of changedPlans) {
      expect(Result.isSuccess(changed)).toBe(true)
      if (Result.isSuccess(changed)) expect(first.success.planHash).not.toBe(changed.success.planHash)
    }
    expect(nativeExecutionRuntimeInitializationTimeoutMs(30_000)).toBe(150_000)
  })

  test('projects the exact completed tick before returning the compact Restate result', async () => {
    let projected: ExecutionControllerStatus | undefined
    const result = await Effect.runPromise(
      executeNativeExecutionAdvance(
        command,
        driver,
        statusStore((candidate) => {
          projected = candidate
          return { _tag: 'Applied', status: candidate }
        }),
      ),
    )

    expect(result.outcome).toMatchObject({ _tag: 'Blocked', nextDelayMs: 30_000 })
    expect(projected).toMatchObject({
      controllerKey: command.controllerKey,
      epoch: command.epoch,
      lastSequence: command.sequence,
      lastOutcome: 'Blocked',
      lastReceiptHash: result.outcome.receiptHash,
    })
    expect(projected?.nextDueAt).toBe(
      new Date(Date.parse(result.completedAt) + result.outcome.nextDelayMs).toISOString(),
    )
  })

  test('fails the Restate step when PostgreSQL has already advanced beyond this completion', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        executeNativeExecutionAdvance(
          command,
          driver,
          statusStore(() => ({
            _tag: 'Stale',
            status: status({ lastSequence: command.sequence + 1 }),
          })),
        ),
      ),
    )

    expect(failure).toBeInstanceOf(TransientExecutionFailure)
    expect(failure.message).toBe('execution controller status projection did not complete')
  })

  test('replays an ambiguously committed projection without advancing execution again', async () => {
    let advanceCount = 0
    let projectCount = 0
    const persistence: { current: ExecutionControllerStatus | null } = { current: null }
    const replayDriver = {
      ...driver,
      advance: Effect.sync(() => {
        advanceCount += 1
        return {
          observation: {
            result: 'SUCCESS' as const,
            observedAt: completedAt,
            outcome: 'NOT_DUE' as const,
          },
        }
      }),
    }
    const uncertainStore: ExecutionControllerStatusStoreShape = {
      read: () => Effect.succeed(persistence.current),
      project: (candidate) =>
        Effect.sync(() => {
          projectCount += 1
          persistence.current = candidate
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new ExecutionControllerStatusStoreError({
                operation: 'project',
                failure: 'query',
                message: 'connection failed after commit',
              }),
            ),
          ),
        ),
    }

    const first = await Effect.runPromiseExit(executeNativeExecutionAdvance(command, replayDriver, uncertainStore))
    const replay = await Effect.runPromise(executeNativeExecutionAdvance(command, replayDriver, uncertainStore))

    expect(first._tag).toBe('Failure')
    expect(advanceCount).toBe(1)
    expect(projectCount).toBe(1)
    const committed = persistence.current
    if (committed === null) throw new Error('ambiguous projection did not persist its status')
    expect(replay).toEqual({
      completedAt: committed.completedAt,
      outcome: {
        _tag: committed.lastOutcome,
        receiptHash: committed.lastReceiptHash,
        nextDelayMs: 30_000,
      },
    })
  })

  test('forwards Restate cancellation into the Effect runner', async () => {
    const abort = new AbortController()
    let observedSignal: AbortSignal | undefined
    const runtime = makeNativeExecutionRuntimeAdapter(
      driver,
      statusStore((candidate) => ({
        _tag: 'Applied',
        status: candidate,
      })),
      {
        runPromise: (effect, options) => {
          observedSignal = options?.signal
          return Effect.runPromise(effect, options)
        },
      },
    )

    await runtime.advance(command, abort.signal)
    expect(observedSignal).toBe(abort.signal)
  })
})
