import { expect, test } from 'bun:test'
import { Clock, Deferred, Effect, Exit, Fiber, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { IntentStoreError, type IntentStoreService, type ProtectionCancelAdmission } from '../execution/intents/domain'
import { makeReplayAdmissionClock } from './admission-clock'

const command = {
  intentId: 'a'.repeat(64),
  accountId: `replay-${'b'.repeat(64)}`,
  brokerOrderId: 'native-protection',
  requestedAt: '2026-09-04T14:30:02.250Z',
}
const initialAt = '2026-09-04T14:30:02.000Z'
const unused = Effect.die('Unexpected mutation beyond native cancellation admission')
const store = (begin: IntentStoreService['beginProtectionCancel']): IntentStoreService => ({
  commit: () => unused,
  read: () => unused,
  protectionForCycle: () => unused,
  beginProtectionCancel: begin,
  recordProtectionCancelAccepted: () => unused,
})

test('failed replay admission alignment preserves the durable command and prevents a broker effect', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(initialAt))
      let attempts = 0
      let brokerCalls = 0
      let fail = true
      const alignment = yield* makeReplayAdmissionClock({
        advanceTo: () =>
          fail ? Schema.decodeUnknownEffect(Schema.Number)('invalid clock response').pipe(Effect.asVoid) : Effect.void,
      })
      const admitted = alignment.intents(
        store(() =>
          Effect.sync(
            (): ProtectionCancelAdmission => ({
              _tag: attempts++ === 0 ? 'New' : 'PendingUnknown',
              command,
            }),
          ),
        ),
      )
      const invoke = admitted.beginProtectionCancel(command.intentId, command.brokerOrderId, initialAt, undefined).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            brokerCalls += 1
          }),
        ),
      )
      const first = yield* invoke.pipe(Effect.exit)
      expect(Exit.isFailure(first)).toBe(true)
      if (Exit.isSuccess(first)) throw new Error('Expected replay alignment failure')
      expect(
        first.cause.reasons.some((reason) => reason._tag === 'Fail' && reason.error instanceof IntentStoreError),
      ).toBe(true)
      expect(brokerCalls).toBe(0)
      fail = false
      expect(yield* invoke).toEqual({ _tag: 'PendingUnknown', command })
      expect(yield* Clock.currentTimeMillis).toBe(Date.parse(command.requestedAt))
      expect(brokerCalls).toBe(1)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test('interrupting replay admission alignment releases its permit before recovery', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(initialAt))
      const entered = yield* Deferred.make<void>()
      let stalled = true
      let interrupted = 0
      const alignment = yield* makeReplayAdmissionClock({
        advanceTo: () =>
          stalled
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Effect.sync(() => interrupted++)),
              )
            : Effect.void,
      })
      const admitted = alignment.intents(store(() => Effect.succeed({ _tag: 'PendingUnknown', command })))
      const pending = yield* admitted
        .beginProtectionCancel(command.intentId, command.brokerOrderId, initialAt, undefined)
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(pending)
      expect(interrupted).toBe(1)
      stalled = false
      expect(
        yield* admitted.beginProtectionCancel(command.intentId, command.brokerOrderId, initialAt, undefined),
      ).toEqual({
        _tag: 'PendingUnknown',
        command,
      })
      expect(yield* Clock.currentTimeMillis).toBe(Date.parse(command.requestedAt))
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test('accepted native cancellation recovery aligns its original command without changing the receipt', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(initialAt))
      const advances: string[] = []
      const alignment = yield* makeReplayAdmissionClock({
        advanceTo: (at) => Effect.sync(() => void advances.push(at)),
      })
      const receipt = {
        command,
        requestHash: 'c'.repeat(64),
        evidence: {
          requestId: 'native-cancel-request',
          status: 204,
          contentHash: 'd'.repeat(64),
          observedAt: command.requestedAt,
        },
      }
      const recovered = alignment.intents(store(() => Effect.succeed({ _tag: 'Accepted', receipt })))
      expect(
        yield* recovered.beginProtectionCancel(command.intentId, command.brokerOrderId, initialAt, undefined),
      ).toEqual({ _tag: 'Accepted', receipt })
      expect(advances).toEqual([command.requestedAt])
      expect(yield* Clock.currentTimeMillis).toBe(Date.parse(command.requestedAt))
      const ineligible = alignment.intents(store(() => Effect.succeed({ _tag: 'NotEligible' })))
      expect(
        yield* ineligible.beginProtectionCancel(command.intentId, command.brokerOrderId, initialAt, undefined),
      ).toEqual({ _tag: 'NotEligible' })
      expect(advances).toEqual([command.requestedAt])
    }).pipe(Effect.provide(TestClock.layer())),
  )
})
