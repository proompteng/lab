import { expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations/model'
import {
  MutationEventType,
  MutationStore,
  type MutationEvent,
  type MutationStoreShape,
} from '../execution/mutations/model'
import { confirmAcceptedCancellation, type ExecutionMutationExecutor } from './mutation-interpreter'

const at = '2026-11-06T15:14:30.000Z'
const accepted: MutationEvent = {
  schemaVersion: 'bayn.paper-mutation-event.v1',
  eventId: 'a'.repeat(64),
  mutationId: 'b'.repeat(64),
  requestHash: 'c'.repeat(64),
  intentId: 'd'.repeat(64),
  sequence: 2,
  operation: MutationOperation.Cancel,
  eventType: MutationEventType.CancelAccepted,
  consistencyDelayMs: 1_000,
  brokerOrderId: 'cancel-confirmation-order',
  occurredAt: at,
}
const forbidden = () => Effect.die(new Error('confirmation cannot issue a broker or accounting mutation'))
const store = (event: MutationEvent | undefined): MutationStoreShape => ({
  latest: () => Effect.succeed(event),
  authorizeSubmit: forbidden,
  beginSubmit: forbidden,
  submitAccepted: forbidden,
  submitRejected: forbidden,
  submitDenied: forbidden,
  submitUnknown: forbidden,
  beginCancel: forbidden,
  cancelAccepted: forbidden,
  cancelUnknown: forbidden,
  recoveryFound: forbidden,
  recoveryNotFound: forbidden,
  recoveryUnknown: forbidden,
})
const run = (
  event: MutationEvent | undefined,
  recover: ExecutionMutationExecutor<Error, never>['recover'],
  observedAt = '2026-11-06T15:14:31.000Z',
) =>
  Effect.runPromise(
    confirmAcceptedCancellation(accepted.intentId, { recover }, Effect.succeed(observedAt)).pipe(
      Effect.provideService(MutationStore, store(event)),
      Effect.result,
    ),
  )

test('accepted cancellation confirmation preserves its consistency delay and only uses lookup recovery', async () => {
  let lookups = 0
  const recover: ExecutionMutationExecutor<Error, never>['recover'] = (intentId, operation) =>
    Effect.sync(() => {
      expect(intentId).toBe(accepted.intentId)
      expect(operation).toBe(MutationOperation.Cancel)
      lookups += 1
      return { ...accepted, eventId: 'e'.repeat(64), sequence: 3, eventType: MutationEventType.RecoveryFound }
    })
  expect(Result.getOrThrow(await run(accepted, recover, at))).toEqual({ delayMs: 1_000 })
  expect(Result.getOrThrow(await run(accepted, recover, '2026-11-06T15:14:30.999Z'))).toEqual({ delayMs: 1 })
  expect(lookups).toBe(0)
  expect(Result.getOrThrow(await run(accepted, recover))).toEqual({ delayMs: 0 })
  expect(lookups).toBe(1)
})

test.each([MutationEventType.RecoveryFound, MutationEventType.CancelUnknown])(
  'changed cancellation outcome %s returns to mandatory reconciliation without an extra lookup',
  async (eventType) => {
    expect(Result.getOrThrow(await run({ ...accepted, eventType }, forbidden))).toEqual({ delayMs: 0 })
  },
)

test.each([undefined, { ...accepted, intentId: 'f'.repeat(64) }, { ...accepted, operation: MutationOperation.Submit }])(
  'missing or changed durable cancellation identity fails closed',
  async (event) => {
    const result = await run(event, forbidden)
    expect(Result.isFailure(result) && result.failure.failure).toBe('contract')
  },
)

test('failed or unresolved confirmation is not converted into successful reconciliation', async () => {
  const failed = await run(accepted, () => Effect.fail(new Error('broker lookup failed')))
  expect(Result.isFailure(failed) && failed.failure.failure).toBe('operational')
  const unresolved = await run(accepted, () =>
    Effect.succeed({ ...accepted, eventType: MutationEventType.RecoveryUnknown }),
  )
  expect(Result.isFailure(unresolved) && unresolved.failure.failure).toBe('operational')
})
