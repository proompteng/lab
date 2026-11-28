import { Clock, Effect, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'

import { IntentStoreError, type IntentStoreService, type ProtectionCancelAdmission } from '../execution/intents/domain'
import { MutationStoreError, type MutationStoreShape, type StartReceipt } from '../execution/mutations/model'
import { utcInstantFromEpochMillis } from '../time'
import type { SimulatedExecutionClock } from './clock'

/** Observe durable account-clock admissions before the simulated broker can produce a response. */
export const makeReplayAdmissionClock = (clock: Pick<SimulatedExecutionClock, 'advanceTo'>) =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1)
    const observe = (admittedAt: string) =>
      permit.withPermit(
        Effect.gen(function* () {
          const current = yield* Clock.currentTimeMillis
          const admitted = Date.parse(admittedAt)
          if (admitted <= current) return
          yield* clock.advanceTo(utcInstantFromEpochMillis(admitted))
          yield* TestClock.setTime(Math.max(admitted, yield* Clock.currentTimeMillis))
        }),
      )
    const protection = (admission: ProtectionCancelAdmission) =>
      admission._tag === 'NotEligible'
        ? Effect.void
        : observe(
            admission._tag === 'Accepted' ? admission.receipt.command.requestedAt : admission.command.requestedAt,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new IntentStoreError({
                  operation: 'protection-cancel',
                  failure: 'query',
                  message: 'Replay clock could not observe committed protection cancellation admission',
                  cause,
                }),
            ),
          )
    const mutation = (operation: 'begin-submit' | 'begin-cancel') => (receipt: StartReceipt) =>
      observe(receipt.event.occurredAt).pipe(
        Effect.mapError(
          (cause) =>
            new MutationStoreError({
              operation,
              failure: 'query',
              message: 'Replay clock could not observe committed mutation admission',
              cause,
            }),
        ),
      )
    return {
      intents: (store: IntentStoreService): IntentStoreService => ({
        ...store,
        beginProtectionCancel: (...args) => store.beginProtectionCancel(...args).pipe(Effect.tap(protection)),
      }),
      mutations: (store: MutationStoreShape): MutationStoreShape => ({
        ...store,
        beginSubmit: (...args) => store.beginSubmit(...args).pipe(Effect.tap(mutation('begin-submit'))),
        beginCancel: (...args) => store.beginCancel(...args).pipe(Effect.tap(mutation('begin-cancel'))),
      }),
    }
  })
