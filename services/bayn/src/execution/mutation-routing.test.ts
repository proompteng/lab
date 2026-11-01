import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { MutationOperation } from '../broker/alpaca-mutations/model'
import { decodeOutcomeInput, decideMutationOutcome, makeEventResult, mutationIdResult } from './mutations/decisions'
import { MutationEventType } from './mutations/model'

test('an uncertain mutation replays only the exact dispatch time, including a request that was never dispatched', () => {
  const intentId = '1'.repeat(64)
  const requestHash = '2'.repeat(64)
  const startedAt = '2026-10-25T14:30:00.000Z'
  const occurredAt = '2026-10-25T14:30:01.000Z'
  const started = Result.getOrThrow(
    makeEventResult('begin-cancel', {
      mutationId: Result.getOrThrow(mutationIdResult(intentId, MutationOperation.Cancel)),
      intentId,
      sequence: 1,
      operation: MutationOperation.Cancel,
      eventType: MutationEventType.CancelStarted,
      requestHash,
      brokerOrderId: 'fixture-order',
      consistencyDelayMs: 1000,
      occurredAt: startedAt,
    }),
  )
  const input = Result.getOrThrow(
    decodeOutcomeInput('record-cancel', {
      intentId,
      requestHash,
      occurredAt,
      brokerOrderId: 'fixture-order',
      evidence: {
        routing: { startedAt, requestDispatchedAt: '2026-10-25T14:30:00.500Z', completedAt: occurredAt },
      },
    }),
  )
  const definition = { _tag: 'CancelUnknown' } as const
  const recorded = Result.getOrThrow(decideMutationOutcome(input, definition, started, undefined)).event
  expect(Result.getOrThrow(decideMutationOutcome(input, definition, recorded, undefined))).toEqual({
    _tag: 'ReplayMutation',
    event: recorded,
  })
  for (const requestDispatchedAt of [null, '2026-10-25T14:30:00.750Z']) {
    const changed = { ...input, routing: { startedAt, requestDispatchedAt, completedAt: occurredAt } }
    expect(Result.isFailure(decideMutationOutcome(changed, definition, recorded, undefined))).toBe(true)
  }
})
