import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import {
  completeExecutionControllerTick,
  decodeExecutionControllerState,
  type ExecutionControllerState,
} from './controller'
import { ExecutionControllerOutcome } from './controller-status'
import { ExecutionControllerHealthSchema, projectExecutionControllerHealth } from './controller-health'
import { strictParseOptions } from '../schemas'

const key = 'a'.repeat(64)
const state: ExecutionControllerState = {
  schemaVersion: 1,
  active: true,
  epoch: 1,
  planHash: 'b'.repeat(64),
  sourceRevision: 'c'.repeat(40),
  initialSequence: 0,
  nextSequence: 1,
  lastCompletion: {
    sequence: 0,
    outcome: ExecutionControllerOutcome.Waiting,
    receiptHash: 'd'.repeat(64),
    completedAt: '2026-11-11T18:00:00.000Z',
  },
}

test('the operational projection exposes no financial receipt or observation', () => {
  expect(Result.getOrThrow(projectExecutionControllerHealth(key, state))).toEqual({
    schemaVersion: 'bayn.execution-controller-health.v1',
    controllerKey: key,
    active: true,
    epoch: 1,
    planHash: state.planHash,
    sourceRevision: state.sourceRevision,
    nextSequence: 1,
  })
  expect(Result.getOrThrow(projectExecutionControllerHealth(key, null))).toBeNull()
})

test('missing legacy wake time fails only health decoding and does not strand the financial owner', () => {
  const legacy = { ...state, wakeScheduledSequence: 1 }
  expect(Result.isSuccess(decodeExecutionControllerState(legacy))).toBe(true)
  expect(Result.isFailure(projectExecutionControllerHealth(key, legacy))).toBe(true)
  const completed = Result.getOrThrow(
    completeExecutionControllerTick(
      legacy,
      { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 1 },
      {
        completedAt: '2026-11-11T18:00:01.000Z',
        outcome: { _tag: ExecutionControllerOutcome.Waiting, receiptHash: 'e'.repeat(64), nextDelayMs: 1 },
      },
      state.sourceRevision,
    ),
  )
  expect(completed.wakeAcceptedAt).toBeUndefined()
  expect(completed.wakeScheduledSequence).toBeUndefined()
  expect(Result.getOrThrow(projectExecutionControllerHealth(key, completed))).not.toHaveProperty('pendingWake')
})

test('the first accepted wake and original domain deadline are projected without time renewal', () => {
  const pending = {
    ...state,
    nextDueAt: '2026-11-11T18:10:00.000Z',
    wakeScheduledSequence: 1,
    wakeAcceptedAt: '2026-11-11T18:00:01.000Z',
  }
  expect(Result.getOrThrow(projectExecutionControllerHealth(key, pending))).toMatchObject({
    nextDueAt: pending.nextDueAt,
    pendingWake: { sequence: 1, acceptedAt: pending.wakeAcceptedAt },
  })
  expect(Result.getOrThrow(projectExecutionControllerHealth(key, { ...pending, active: false }))).not.toHaveProperty(
    'pendingWake',
  )
})

test('an external operational view cannot attach a wake to a different execution sequence', () => {
  const projected = Result.getOrThrow(projectExecutionControllerHealth(key, state))
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(
        ExecutionControllerHealthSchema,
        strictParseOptions,
      )({
        ...projected,
        pendingWake: { sequence: 0, acceptedAt: '2026-11-11T18:00:01.000Z' },
      }),
    ),
  ).toBe(true)
})
