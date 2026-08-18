import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import {
  completeExecutionControllerTick,
  decodeExecutionControllerBootstrap,
  decodeExecutionControllerTick,
  decideExecutionControllerActivation,
  decideExecutionControllerBootstrap,
  decideExecutionControllerDeactivation,
  decideExecutionControllerTick,
  resolveOptionalExecutionControllerBinding,
  type ExecutionAdvanceStepResult,
  type ExecutionControllerActivation,
  type ExecutionControllerState,
} from './controller'
import { ExecutionControllerOutcome } from './controller-status'

const controllerKey = 'a'.repeat(64)
const planHash = 'b'.repeat(64)
const nextPlanHash = 'c'.repeat(64)
const sourceRevision = 'd'.repeat(40)
const nextSourceRevision = 'e'.repeat(40)

const activation = (overrides: Partial<ExecutionControllerActivation> = {}): ExecutionControllerActivation => ({
  schemaVersion: 'bayn.execution-controller-activation.v1',
  controllerKey,
  epoch: 1,
  firstSequence: 0,
  planHash,
  sourceRevision,
  ...overrides,
})

const activated = (): ExecutionControllerState =>
  Result.getOrThrow(decideExecutionControllerActivation(null, activation())).state

const completedResult: ExecutionAdvanceStepResult = {
  completedAt: '2026-08-13T18:00:00.000Z',
  outcome: {
    _tag: ExecutionControllerOutcome.Completed,
    receiptHash: 'f'.repeat(64),
    nextDelayMs: 30_000,
  },
}

describe('execution controller decisions', () => {
  test('activates once and treats the same controller plan across worker revisions as idempotent', () => {
    const state = activated()

    expect(state).toEqual({
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 0,
      nextSequence: 0,
    })
    expect(Result.getOrThrow(decideExecutionControllerActivation(state, activation()))).toEqual({
      _tag: 'Replayed',
      state,
    })
    expect(
      Result.getOrThrow(decideExecutionControllerActivation(state, activation({ sourceRevision: nextSourceRevision }))),
    ).toEqual({ _tag: 'Replayed', state })
    for (const conflicting of [
      activation({ epoch: 2 }),
      activation({ firstSequence: 1 }),
      activation({ planHash: nextPlanHash }),
    ]) {
      expect(Result.isFailure(decideExecutionControllerActivation(state, conflicting))).toBe(true)
    }
  })

  test('requires an exact previous binding before rotating durable controller state', () => {
    const state = { ...activated(), nextSequence: 9 }
    const request = {
      schemaVersion: 'bayn.execution-controller-bootstrap.v3' as const,
      controllerKey,
      planHash: nextPlanHash,
      sourceRevision: nextSourceRevision,
      previousBinding: { planHash, sourceRevision },
    }

    expect(Result.getOrThrow(decideExecutionControllerBootstrap(state, request))).toEqual({
      _tag: 'Rotate',
      deactivation: {
        schemaVersion: 'bayn.execution-controller-deactivation.v1',
        controllerKey,
        epoch: 1,
        planHash,
        sourceRevision,
      },
    })
    expect(
      Result.getOrThrow(decideExecutionControllerBootstrap({ ...state, active: false, epoch: 2 }, request)),
    ).toEqual({ _tag: 'Activate', state: { ...state, active: false, epoch: 2 } })
    expect(
      Result.getOrThrow(
        decideExecutionControllerBootstrap(
          { ...state, planHash: nextPlanHash, sourceRevision: nextSourceRevision },
          request,
        ),
      ),
    ).toMatchObject({ _tag: 'Activate' })

    for (const conflicting of [
      decideExecutionControllerBootstrap(state, {
        ...request,
        previousBinding: { ...request.previousBinding, planHash: 'f'.repeat(64) },
      }),
      decideExecutionControllerBootstrap(state, {
        schemaVersion: 'bayn.execution-controller-bootstrap.v2',
        controllerKey,
        planHash: nextPlanHash,
        sourceRevision: nextSourceRevision,
      }),
      decideExecutionControllerBootstrap(null, request),
    ]) {
      expect(Result.isFailure(conflicting)).toBe(true)
    }
  })

  test('requires both previous-binding fields and rejects ambiguous bootstrap documents', () => {
    expect(Result.getOrThrow(resolveOptionalExecutionControllerBinding(undefined, undefined))).toBeUndefined()
    expect(Result.getOrThrow(resolveOptionalExecutionControllerBinding(planHash, sourceRevision))).toEqual({
      planHash,
      sourceRevision,
    })
    expect(Result.isFailure(resolveOptionalExecutionControllerBinding(planHash, undefined))).toBe(true)
    expect(Result.isFailure(resolveOptionalExecutionControllerBinding(undefined, sourceRevision))).toBe(true)
    expect(
      Result.isFailure(
        decodeExecutionControllerBootstrap({
          schemaVersion: 'bayn.execution-controller-bootstrap.v3',
          controllerKey,
          planHash: nextPlanHash,
          sourceRevision: nextSourceRevision,
        }),
      ),
    ).toBe(true)
  })

  test('accepts only the active epoch and exact next sequence', () => {
    const state = activated()
    const command = Result.getOrThrow(
      decideExecutionControllerTick(
        state,
        { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
        controllerKey,
        '2026-08-13T17:59:00.000Z',
        nextSourceRevision,
      ),
    )
    expect(command).toEqual({
      _tag: 'Advance',
      command: {
        controllerKey,
        epoch: 1,
        sequence: 0,
        issuedAt: '2026-08-13T17:59:00.000Z',
        sourceRevision: nextSourceRevision,
      },
    })
    expect(
      Result.getOrThrow(
        decideExecutionControllerTick(
          state,
          { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 2, sequence: 0 },
          controllerKey,
          '2026-08-13T17:59:00.000Z',
          nextSourceRevision,
        ),
      ),
    ).toEqual({ _tag: 'Ignored', reason: 'StaleEpoch' })
    expect(
      Result.getOrThrow(
        decideExecutionControllerTick(
          state,
          { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 1 },
          controllerKey,
          '2026-08-13T17:59:00.000Z',
          nextSourceRevision,
        ),
      ),
    ).toEqual({ _tag: 'Ignored', reason: 'StaleSequence' })
    expect(
      Result.getOrThrow(
        decideExecutionControllerTick(
          { ...state, active: false },
          { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
          controllerKey,
          '2026-08-13T17:59:00.000Z',
          nextSourceRevision,
        ),
      ),
    ).toEqual({ _tag: 'Ignored', reason: 'Inactive' })
  })

  test('accepts the bounded replacement handoff attempt range and rejects larger counters', () => {
    expect(
      Result.getOrThrow(
        decodeExecutionControllerTick({
          schemaVersion: 'bayn.execution-controller-tick.v1',
          epoch: 1,
          sequence: 0,
          attempt: 5,
        }),
      ).attempt,
    ).toBe(5)
    expect(
      Result.isFailure(
        decodeExecutionControllerTick({
          schemaVersion: 'bayn.execution-controller-tick.v1',
          epoch: 1,
          sequence: 0,
          attempt: 6,
        }),
      ),
    ).toBe(true)
  })

  test('rejects an exhausted exact sequence before issuing an advance command', () => {
    const state = activated()
    const decision = decideExecutionControllerTick(
      { ...state, initialSequence: Number.MAX_SAFE_INTEGER, nextSequence: Number.MAX_SAFE_INTEGER },
      {
        schemaVersion: 'bayn.execution-controller-tick.v1',
        epoch: state.epoch,
        sequence: Number.MAX_SAFE_INTEGER,
      },
      controllerKey,
      '2026-08-13T17:59:00.000Z',
      nextSourceRevision,
    )

    expect(Result.isFailure(decision)).toBe(true)
    if (Result.isSuccess(decision)) return
    expect(decision.failure).toMatchObject({ operation: 'tick', reason: 'counter-exhausted' })
  })

  test('rejects an exhausted epoch before initial activation or inactive rebinding', () => {
    const exhausted = activation({ epoch: Number.MAX_SAFE_INTEGER })
    const initial = decideExecutionControllerActivation(null, exhausted)
    const rebound = decideExecutionControllerActivation(
      { ...activated(), active: false, epoch: Number.MAX_SAFE_INTEGER },
      exhausted,
    )

    for (const decision of [initial, rebound]) {
      expect(Result.isFailure(decision)).toBe(true)
      if (Result.isFailure(decision)) {
        expect(decision.failure).toMatchObject({ operation: 'activate', reason: 'counter-exhausted' })
      }
    }
  })

  test('completes one tick, advances monotonically, and records the next due time', () => {
    const state = Result.getOrThrow(
      completeExecutionControllerTick(
        activated(),
        { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
        completedResult,
        nextSourceRevision,
      ),
    )

    expect(state).toMatchObject({
      active: true,
      epoch: 1,
      sourceRevision: nextSourceRevision,
      nextSequence: 1,
      nextDueAt: '2026-08-13T18:00:30.000Z',
      lastCompletion: {
        sequence: 0,
        outcome: 'Completed',
        receiptHash: completedResult.outcome.receiptHash,
        completedAt: completedResult.completedAt,
      },
    })
    expect(
      Result.isFailure(
        completeExecutionControllerTick(
          state,
          { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
          completedResult,
          nextSourceRevision,
        ),
      ),
    ).toBe(true)
  })

  test('persists blocked results as successful business completion', () => {
    const state = Result.getOrThrow(
      completeExecutionControllerTick(
        activated(),
        { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
        {
          completedAt: '2026-08-13T18:00:00.000Z',
          outcome: {
            _tag: ExecutionControllerOutcome.Blocked,
            receiptHash: '1'.repeat(64),
            nextDelayMs: 5_000,
          },
        },
        nextSourceRevision,
      ),
    )

    expect(state.lastCompletion?.outcome).toBe(ExecutionControllerOutcome.Blocked)
    expect(state.nextDueAt).toBe('2026-08-13T18:00:05.000Z')
  })

  test('rejects a computed next due time outside the canonical UTC range', () => {
    const decision = completeExecutionControllerTick(
      activated(),
      { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
      {
        ...completedResult,
        completedAt: '9999-12-31T23:59:59.999Z',
        outcome: { ...completedResult.outcome, nextDelayMs: 1 },
      },
      nextSourceRevision,
    )

    expect(Result.isFailure(decision)).toBe(true)
    if (Result.isFailure(decision)) {
      expect(decision.failure).toMatchObject({ operation: 'complete', reason: 'invalid-time' })
    }
  })

  test('deactivates by advancing the epoch and permits one explicitly rebound controller', () => {
    const deactivation = {
      schemaVersion: 'bayn.execution-controller-deactivation.v1' as const,
      controllerKey,
      epoch: 1,
      planHash,
      sourceRevision,
    }
    const inactive = Result.getOrThrow(decideExecutionControllerDeactivation(activated(), deactivation)).state

    expect(inactive).toMatchObject({ active: false, epoch: 2, planHash, sourceRevision })
    expect(inactive.nextDueAt).toBeUndefined()
    expect(Result.getOrThrow(decideExecutionControllerDeactivation(inactive, deactivation))._tag).toBe('Replayed')
    const rebound = Result.getOrThrow(
      decideExecutionControllerActivation(
        inactive,
        activation({
          epoch: 2,
          firstSequence: 17,
          planHash: nextPlanHash,
          sourceRevision: nextSourceRevision,
        }),
      ),
    ).state
    expect(rebound).toMatchObject({
      active: true,
      epoch: 2,
      initialSequence: 17,
      nextSequence: 17,
      planHash: nextPlanHash,
      sourceRevision: nextSourceRevision,
    })
  })
})
