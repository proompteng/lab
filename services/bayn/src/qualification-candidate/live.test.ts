import { describe, expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Redacted, Ref } from 'effect'

import { readCandidateReplica, readQualificationLocks } from './live'
import type { CandidateConfig } from './model'
import {
  candidateInput,
  candidateObservations,
  candidatePublicationDate,
  candidatePublisherPrincipal,
  candidateReplicaEndpoints,
} from './test-fixtures'

const candidateConfig = (): CandidateConfig => ({
  publicationDate: candidatePublicationDate,
  clickhouseUrls: candidateInput().clickhouseUrls,
  publisherUsername: candidatePublisherPrincipal,
  publisherPassword: Redacted.make('publisher-password'),
  postgresUrl: Redacted.make('postgresql://bayn:password@127.0.0.1:5432/bayn'),
  postgresTls: undefined,
  tigerBeetleClusterId: candidateInput().tigerBeetleClusterId,
  tigerBeetleAddresses: candidateInput().tigerBeetleAddresses,
  tigerBeetleLedger: candidateInput().tigerBeetleLedger,
  operationTimeoutMs: 5_000,
})

describe('qualification candidate live client lifecycle', () => {
  test('acquires and releases the ClickHouse client exactly once after a successful replica read', async () => {
    let acquisitions = 0
    let releases = 0
    const observation = candidateObservations()[0]

    const result = await Effect.runPromise(
      readCandidateReplica(
        candidateInput(),
        candidateReplicaEndpoints[0],
        Redacted.make('publisher-password'),
        5_000,
        () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquisitions += 1
              return { read: Effect.succeed(observation) }
            }),
            () =>
              Effect.sync(() => {
                releases += 1
              }),
          ),
      ),
    )

    expect(result).toEqual(observation)
    expect(acquisitions).toBe(1)
    expect(releases).toBe(1)
  })

  test('interrupts an in-flight ClickHouse read and releases the client exactly once', async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const acquisitions = yield* Ref.make(0)
        const releases = yield* Ref.make(0)
        const fiber = yield* readCandidateReplica(
          candidateInput(),
          candidateReplicaEndpoints[0],
          Redacted.make('publisher-password'),
          5_000,
          () =>
            Effect.acquireRelease(
              Ref.update(acquisitions, (count) => count + 1).pipe(
                Effect.as({
                  read: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
                }),
              ),
              () => Ref.update(releases, (count) => count + 1),
            ),
        ).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return yield* Effect.all({
          acquisitions: Ref.get(acquisitions),
          releases: Ref.get(releases),
        })
      }),
    )

    expect(counts).toEqual({ acquisitions: 1, releases: 1 })
  })

  test('acquires and releases the PostgreSQL client exactly once after a successful lock read', async () => {
    let acquisitions = 0
    let releases = 0
    const observation = { transactionReadOnly: true, count: 0 }

    const result = await Effect.runPromise(
      readQualificationLocks(candidateConfig(), 'a'.repeat(64), () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            acquisitions += 1
            return { read: () => Effect.succeed(observation) }
          }),
          () =>
            Effect.sync(() => {
              releases += 1
            }),
        ),
      ),
    )

    expect(result).toEqual(observation)
    expect(acquisitions).toBe(1)
    expect(releases).toBe(1)
  })

  test('interrupts an in-flight PostgreSQL read and releases the client exactly once', async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const acquisitions = yield* Ref.make(0)
        const releases = yield* Ref.make(0)
        const fiber = yield* readQualificationLocks(candidateConfig(), 'a'.repeat(64), () =>
          Effect.acquireRelease(
            Ref.update(acquisitions, (count) => count + 1).pipe(
              Effect.as({
                read: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              }),
            ),
            () => Ref.update(releases, (count) => count + 1),
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return yield* Effect.all({
          acquisitions: Ref.get(acquisitions),
          releases: Ref.get(releases),
        })
      }),
    )

    expect(counts).toEqual({ acquisitions: 1, releases: 1 })
  })
})
