import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import type { ApplicationPlanFor } from '../app'
import type {
  ExecutionControllerStatus,
  ExecutionControllerStatusProjection,
  ExecutionControllerStatusStoreShape,
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
  lastOutcome: 'Blocked',
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

const plan = (
  imageDigest = `sha256:${hash('3')}`,
  cyclePollIntervalMs = 30_000,
): ApplicationPlanFor<'AutonomousService'> =>
  ({
    _tag: 'AutonomousService',
    config: {
      alpaca: {
        identity: { identityHash: command.controllerKey },
        authorityGenerationHash: hash('4'),
        reconciliationIntervalMs: 30_000,
      },
      build: { sourceRevision, imageDigest },
      capitalActivationRequestJson: '{"schemaVersion":"test"}',
      cyclePollIntervalMs,
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
  test('binds controller identity to account, image, source, strategy, authority, and cadence', () => {
    const first = executionControllerConfig(plan())
    const replay = executionControllerConfig(plan())
    const newImage = executionControllerConfig(plan(`sha256:${hash('8')}`))
    const newCadence = executionControllerConfig(plan(`sha256:${hash('3')}`, 60_000))

    expect(Result.isSuccess(first)).toBe(true)
    expect(replay).toEqual(first)
    if (Result.isFailure(first) || Result.isFailure(newImage) || Result.isFailure(newCadence)) return
    expect(first.success.controllerKey).toBe(command.controllerKey)
    expect(first.success.planHash).not.toBe(newImage.success.planHash)
    expect(first.success.planHash).not.toBe(newCadence.success.planHash)
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
