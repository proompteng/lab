import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import {
  completeExecutionControllerTick,
  decodeExecutionControllerState,
  decodeExecutionAdvanceStepResult,
  decodeExecutionDeploymentActivation,
  decodeExecutionControllerTick,
  decideExecutionControllerActivation,
  decideExecutionDeploymentActivation,
  decideExecutionControllerDeactivation,
  decideExecutionControllerTick,
  executionControllerMaximumRecoveryWindow,
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
      schemaVersion: 'bayn.execution-deployment-activation.v1' as const,
      controllerKey,
      planHash: nextPlanHash,
      sourceRevision: nextSourceRevision,
      previousBinding: { planHash, sourceRevision },
    }

    expect(Result.getOrThrow(decideExecutionDeploymentActivation(state, request))).toEqual({
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
      Result.getOrThrow(decideExecutionDeploymentActivation({ ...state, active: false, epoch: 2 }, request)),
    ).toEqual({ _tag: 'Activate', state: { ...state, active: false, epoch: 2 } })
    expect(
      Result.getOrThrow(
        decideExecutionDeploymentActivation(
          { ...state, planHash: nextPlanHash, sourceRevision: nextSourceRevision },
          request,
        ),
      ),
    ).toMatchObject({ _tag: 'Activate' })

    for (const conflicting of [
      decideExecutionDeploymentActivation(state, {
        ...request,
        previousBinding: { ...request.previousBinding, planHash: 'f'.repeat(64) },
      }),
      decideExecutionDeploymentActivation(state, {
        schemaVersion: 'bayn.execution-deployment-activation.v1',
        controllerKey,
        planHash: nextPlanHash,
        sourceRevision: nextSourceRevision,
      }),
      decideExecutionDeploymentActivation(null, request),
    ]) {
      expect(Result.isFailure(conflicting)).toBe(true)
    }
  })

  test('requires both previous-binding fields and rejects partial deployment bindings', () => {
    expect(Result.getOrThrow(resolveOptionalExecutionControllerBinding(undefined, undefined))).toBeUndefined()
    expect(Result.getOrThrow(resolveOptionalExecutionControllerBinding(planHash, sourceRevision))).toEqual({
      planHash,
      sourceRevision,
    })
    expect(Result.isFailure(resolveOptionalExecutionControllerBinding(planHash, undefined))).toBe(true)
    expect(Result.isFailure(resolveOptionalExecutionControllerBinding(undefined, sourceRevision))).toBe(true)
    expect(
      Result.isFailure(
        decodeExecutionDeploymentActivation({
          schemaVersion: 'bayn.execution-deployment-activation.v1',
          controllerKey,
          planHash: nextPlanHash,
          sourceRevision: nextSourceRevision,
          previousBinding: { planHash },
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
          attempt: 6,
          sourceCatchUpRevision: nextSourceRevision,
        }),
      ),
    ).toMatchObject({ attempt: 6, sourceCatchUpRevision: nextSourceRevision })
    expect(
      Result.isFailure(
        decodeExecutionControllerTick({
          schemaVersion: 'bayn.execution-controller-tick.v1',
          epoch: 1,
          sequence: 0,
          attempt: 7,
        }),
      ),
    ).toBe(true)
    expect(
      Result.getOrThrow(
        decodeExecutionControllerTick({
          schemaVersion: 'bayn.execution-controller-tick.v1',
          epoch: 1,
          sequence: 0,
          recoveryWindow: executionControllerMaximumRecoveryWindow,
          retryWindowHash: 'f'.repeat(64),
        }),
      ),
    ).toMatchObject({ recoveryWindow: executionControllerMaximumRecoveryWindow })
    expect(
      Result.isFailure(
        decodeExecutionControllerTick({
          schemaVersion: 'bayn.execution-controller-tick.v1',
          epoch: 1,
          sequence: 0,
          recoveryWindow: executionControllerMaximumRecoveryWindow + 1,
          retryWindowHash: 'f'.repeat(64),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decodeExecutionControllerTick({
          schemaVersion: 'bayn.execution-controller-tick.v1',
          epoch: 1,
          sequence: 0,
          sourceCatchUpRevision: 'not-a-source-revision',
        }),
      ),
    ).toBe(true)
  })

  test('rejects malformed retained session dates in durable pass evidence', () => {
    const candidate = {
      completedAt: '2026-08-13T18:00:00.000Z',
      observation: {
        result: 'SUCCESS',
        observedAt: '2026-08-13T18:00:00.000Z',
        outcome: 'NOT_DUE',
        cadence: 'EVERY_SESSION',
        notDueReason: 'STALE_CAPITAL_BOOTSTRAP',
        cadenceDecision: {
          schemaVersion: 'bayn.month-end-cadence-decision.v1',
          condition: 'EXPECTED_WAIT',
          reason: 'SIGNAL_AND_EXECUTION_SESSION_SAME_MONTH',
          signalSessionDate: 'zzz',
          executionSessionDate: 'zzzz',
          nextEligibility: {
            status: 'UNKNOWN',
            reason: 'FUTURE_CALENDAR_EVIDENCE_UNAVAILABLE',
          },
        },
      },
      outcome: {
        _tag: ExecutionControllerOutcome.Blocked,
        receiptHash: 'f'.repeat(64),
        nextDelayMs: 30_000,
      },
    }

    expect(Result.isFailure(decodeExecutionAdvanceStepResult(candidate))).toBe(true)
    expect(
      Result.isFailure(
        decodeExecutionAdvanceStepResult({
          ...candidate,
          observation: {
            ...candidate.observation,
            cadenceDecision: {
              ...candidate.observation.cadenceDecision,
              signalSessionDate: '2026-08-12',
              executionSessionDate: '2026-08-13',
              nextEligibility: {
                status: 'PROVEN',
                sessionDate: 'not-a-date',
                basis: 'EXECUTION_SESSION_MONTH_TRANSITION',
              },
            },
          },
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
    const observation = {
      result: 'SUCCESS' as const,
      observedAt: completedResult.completedAt,
      outcome: 'WINDOW_CLOSED' as const,
    }
    const state = Result.getOrThrow(
      completeExecutionControllerTick(
        activated(),
        { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
        { ...completedResult, observation },
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
    expect(state.lastCompletion).not.toHaveProperty('lastPass')
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

  test.each([1_000, 5_000])('persists a %sms continuation across a controller restart', (nextDelayMs) => {
    const state = Result.getOrThrow(
      completeExecutionControllerTick(
        activated(),
        { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
        {
          completedAt: '2026-08-13T18:00:00.000Z',
          outcome: {
            _tag: ExecutionControllerOutcome.Blocked,
            receiptHash: '1'.repeat(64),
            nextDelayMs,
          },
        },
        nextSourceRevision,
      ),
    )

    expect(state.lastCompletion?.outcome).toBe(ExecutionControllerOutcome.Blocked)
    const nextDueAt = new Date(Date.parse('2026-08-13T18:00:00.000Z') + nextDelayMs).toISOString()
    expect(state.nextDueAt).toBe(nextDueAt)
    const resumed = Result.getOrThrow(decodeExecutionControllerState(JSON.parse(JSON.stringify(state))))
    expect(resumed).toEqual(state)
    expect(
      Result.getOrThrow(
        decideExecutionControllerTick(
          resumed,
          {
            schemaVersion: 'bayn.execution-controller-tick.v1',
            epoch: 1,
            sequence: resumed.nextSequence,
          },
          controllerKey,
          nextDueAt,
          nextSourceRevision,
        ),
      ),
    ).toMatchObject({ _tag: 'Advance' })
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
