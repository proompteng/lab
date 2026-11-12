import { expect, test } from 'bun:test'
import { Deferred, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { MarketChangeReason, type MarketChangedWakeup } from '../../execution/events'
import { KafkaMarketFailure } from './kafka'
import { makeMarketHints } from './readiness'

const revision = 'a'.repeat(40)
const producerId = '96d77600-414a-4211-9342-f3a986254fbc'

test('1000 immediate changes retain one immutable in-flight hint and the latest change only', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hints = yield* makeMarketHints(revision, producerId)
        const began = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()
        const delivered: MarketChangedWakeup[] = []
        yield* hints
          .serve((event) =>
            Effect.gen(function* () {
              delivered.push(event)
              if (delivered.length === 1) {
                yield* Deferred.succeed(began, undefined)
                yield* Deferred.await(release)
              } else yield* Deferred.succeed(finished, undefined)
            }),
          )
          .pipe(Effect.forkScoped)
        yield* hints.changed(MarketChangeReason.Startup)
        yield* Deferred.await(began)
        for (let sequence = 2; sequence <= 1000; sequence++) yield* hints.changed(MarketChangeReason.Data)
        expect(delivered.map((event) => event.sequence)).toEqual([1])
        expect(Object.isFrozen(delivered[0])).toBe(true)
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(finished)
        expect(delivered.map((event) => event.sequence)).toEqual([1, 1000])
        expect(delivered[0]?.reason).toBe(MarketChangeReason.Startup)
        yield* TestClock.adjust('1 hour')
        expect(delivered).toHaveLength(2)
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test('a lost ingress ACK retries the exact retained bytes before a newer quiet recovery hint', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hints = yield* makeMarketHints(revision, producerId)
        const began = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()
        const accepted = new Set<string>()
        const attempts: string[] = []
        let ingressAvailable = false
        yield* hints
          .serve((event) =>
            Effect.gen(function* () {
              attempts.push(JSON.stringify(event))
              yield* Deferred.succeed(began, undefined)
              if (!ingressAvailable) {
                // The ingress accepted this exact identity, but the response was lost.
                accepted.add(event.eventId)
                return yield* new KafkaMarketFailure({ operation: 'read', message: 'lost ingress acknowledgement' })
              }
              accepted.add(event.eventId)
              if (event.reason === MarketChangeReason.Ready) yield* Deferred.succeed(finished, undefined)
            }),
          )
          .pipe(Effect.forkScoped)
        yield* hints.changed(MarketChangeReason.Startup)
        yield* Deferred.await(began)
        yield* hints.changed(MarketChangeReason.Recovery)
        yield* hints.changed(MarketChangeReason.Ready)
        yield* TestClock.adjust('2 minutes')
        expect(attempts.length).toBeLessThan(12)
        expect(new Set(attempts).size).toBe(1)
        expect(accepted.size).toBe(1)
        ingressAvailable = true
        yield* TestClock.adjust('30 seconds')
        yield* Deferred.await(finished)
        expect(attempts.at(-1)).not.toBe(attempts[0])
        expect(accepted.size).toBe(2)
        expect(JSON.parse(attempts.at(-1) ?? '{}')).toMatchObject({ sequence: 3, reason: MarketChangeReason.Ready })
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test('interruption cancels an unacknowledged hint without fabricating acceptance', async () => {
  let finalized = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hints = yield* makeMarketHints(revision, producerId)
        const began = yield* Deferred.make<void>()
        const publisher = yield* hints
          .serve(() =>
            Deferred.succeed(began, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized += 1
                }),
              ),
            ),
          )
          .pipe(Effect.forkScoped)
        yield* hints.changed(MarketChangeReason.Startup)
        yield* Deferred.await(began)
        yield* Fiber.interrupt(publisher)
        expect(Exit.isFailure(yield* Fiber.await(publisher))).toBe(true)
      }),
    ),
  )
  expect(finalized).toBe(1)
})
