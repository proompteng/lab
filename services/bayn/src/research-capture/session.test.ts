import { expect, test } from 'bun:test'
import { Clock, ConfigProvider, Deferred, Effect, Exit, Fiber, Result, type Scope } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import { KafkaMarketFailure } from '../market-data/streaming/kafka'
import { CaptureInvalidation, CaptureQualification, ResearchCaptureFailure, type CaptureIntervalCut } from './capture'
import { captureEvent, recoverCaptureFromStoredObjects } from './capture.test-support'
import { researchCaptureObjectKey, verifyResearchCaptureExportPrefix } from './export'
import { makeResearchCaptureSession } from './session'
import { decodeResearchCaptureSessionConfig, researchCaptureSessionConfig } from './session-config'
import { sessionConfig, sessionMemory, sessionStart, sessionUniverse } from './session.test-support'

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(provideTestLayer(TestClock.layer())))
const start = (saved = sessionMemory(), bootstrapped = true) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(sessionStart)
    const session = yield* makeResearchCaptureSession(sessionConfig, 'a'.repeat(40))
    yield* session.start(saved.store, Effect.succeed(saved.objectStore), sessionUniverse)
    session.observer.record(captureEvent('STARTED'))
    if (bootstrapped)
      session.observer.record({
        kind: 'consumer-boundary',
        consumerEpoch: 'consumer-1',
        phase: 'BOOTSTRAPPED',
        positions: [],
      })
    return { saved, session }
  })

test('default configuration is dormant without any S3 configuration; one explicit calendar session validates', async () => {
  expect(
    await Effect.runPromise(
      researchCaptureSessionConfig.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      ),
    ),
  ).toBeUndefined()
  const result = decodeResearchCaptureSessionConfig(JSON.stringify(sessionConfig))
  expect(Result.isSuccess(result) && result.success.coverageEndMs).toBe(sessionStart + 20_000)
  for (const change of [
    { coverageStartMs: sessionConfig.coverageStartMs - 1 },
    { calendarHash: '0'.repeat(64) },
    { bootstrapDeadlineMs: sessionConfig.coverageStartMs },
    { startAtMs: sessionConfig.bootstrapDeadlineMs },
    { startAtMs: Date.parse('2026-10-04T23:59:59.999Z') },
    { stopAtMs: sessionConfig.coverageEndMs + 300_001 },
    { expectedPartitions: [...sessionConfig.expectedPartitions].reverse() },
    { maximumSqlBytes: 10 * 1024 ** 3 + 1 },
    { sessionDate: '2026-10-06' },
  ])
    expect(Result.isFailure(decodeResearchCaptureSessionConfig(JSON.stringify({ ...sessionConfig, ...change })))).toBe(
      true,
    )
})

test('an unacquired worker finishes incomplete at the fixed bootstrap deadline and never starts another session', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(sessionStart)
      const saved = sessionMemory()
      const session = yield* makeResearchCaptureSession(sessionConfig, 'a'.repeat(40))
      yield* TestClock.adjust(5000)
      expect(yield* session.status).toEqual({ phase: 'finished', reason: CaptureInvalidation.MissedBootstrap })
      yield* session.start(saved.store, Effect.die('must not acquire'), sessionUniverse)
      yield* TestClock.adjust(86_400_000)
      expect(yield* session.status).toEqual({ phase: 'finished', reason: CaptureInvalidation.MissedBootstrap })
      expect(saved.writes).toEqual([])
    }),
  ))

test('a future session has no early claim, object acquisition, raw mode, or delayed attachment to an existing worker', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(sessionStart - 86_400_000)
      const saved = sessionMemory()
      const session = yield* makeResearchCaptureSession(sessionConfig, 'a'.repeat(40))
      expect(yield* session.status).toEqual({ phase: 'waiting' })
      expect(session.workerObserver).toBeUndefined()
      yield* TestClock.adjust(1000)
      expect(saved.writes).toEqual([])
      yield* session.start(
        saved.store,
        Effect.die('early acquisition must not read S3 config or create a client'),
        sessionUniverse,
      )
      expect(yield* session.status).toEqual({ phase: 'finished', reason: CaptureInvalidation.OutsideWindow })
      expect(session.workerObserver).toBeUndefined()
      yield* TestClock.adjust(86_400_000)
      yield* session.start(saved.store, Effect.die('no delayed attachment'), sessionUniverse)
      expect(saved.writes).toEqual([])
      expect(yield* session.status).toEqual({ phase: 'finished', reason: CaptureInvalidation.OutsideWindow })
    }),
  ))

test('one successful native cut closes once while the worker remains alive and every export stays unqualified', () =>
  run(
    Effect.gen(function* () {
      const { saved, session } = yield* start()
      let cuts = 0
      session.bind({
        captureInterval: (request) =>
          Effect.sync(() => {
            cuts++
            const cut: CaptureIntervalCut = {
              ...request,
              kind: 'consumer-interval-cut',
              schemaVersion: 'bayn.native-visible-input-cut.v1',
              consumerEpoch: 'consumer-1',
              transport: {
                sdk: '@platformatic/kafka',
                version: '2.12.1',
                isolation: 'READ_COMMITTED',
                mode: 'MANUAL',
                fallback: 'FAIL',
                deserializationFailure: 'FAIL',
              },
              committedFence: {
                lookupStartedAtMs: request.coverageEndMs,
                lookupCompletedAtMs: request.coverageEndMs,
                positions: request.expectedPartitions.map((position) => ({ ...position, offset: '0' })),
              },
              drainedPositions: request.expectedPartitions.map((position) => ({ ...position, offset: '0' })),
              finalConsumerSequence: 0,
            }
            session.observer.record(cut)
            return cut
          }),
      })
      yield* TestClock.adjust(20_000)
      const status = yield* session.status
      expect(status.phase).toBe('finished')
      expect(status.phase === 'finished' && status.seal?.qualification).toBe(CaptureQualification.Unqualified)
      expect(status.phase === 'finished' && status.seal?.invalidations).toEqual([])
      expect(saved.writes.slice(0, 4)).toEqual(['sql-chunk', 'object', 'object', 'object'])
      expect(saved.writes.slice(-3)).toEqual(['object', 'object', 'sql-seal'])
      const receiptCount = status.phase === 'finished' ? status.seal?.observedReceipts : undefined
      session.observer.record(captureEvent('STOPPED'))
      yield* TestClock.adjust(10_000)
      expect(cuts).toBe(1)
      expect(saved.seals).toHaveLength(1)
      expect(status.phase === 'finished' && status.seal?.observedReceipts).toBe(receiptCount)
      const recovered = recoverCaptureFromStoredObjects(saved.chunks, saved.seals[0], (key) =>
        saved.objects.find((object) => researchCaptureObjectKey(object.contentHash) === key),
      )
      expect(Result.isFailure(recovered)).toBe(true)
      const sealed = saved.seals[0]
      const manifest = saved.objects.at(-1)
      if (sealed === undefined || manifest === undefined) throw new Error('Expected sealed export')
      const verified = verifyResearchCaptureExportPrefix(
        saved.chunks.map((metadata, ordinal) => {
          const raw = saved.objects[ordinal * 3]
          const index = saved.objects[ordinal * 3 + 2]
          if (raw === undefined || index === undefined) throw new Error('Expected exported prefix objects')
          return {
            metadata,
            raw: raw.payload,
            index: { contentHash: index.contentHash, payload: Buffer.from(index.payload).toString('utf8') },
          }
        }),
        sealed,
        { contentHash: manifest.contentHash, payload: Buffer.from(manifest.payload).toString('utf8') },
      )
      expect(Result.isSuccess(verified) && verified.success.exportVerified).toBe(true)
      expect(Result.isSuccess(verified) && verified.success.complete).toBe(false)
      expect(saved.chunks[0]?.payload).toContain('session-attempt')
    }),
  ))

test.each(['failed-cut', 'stalled-cut', 'missing-bootstrap', 'replacement', 'invalidation', 'clock-reversal'] as const)(
  '%s stays incomplete and leaves trading work successful',
  (scenario) =>
    run(
      Effect.gen(function* () {
        const { saved, session } = yield* start(sessionMemory(), scenario !== 'missing-bootstrap')
        session.bind({
          captureInterval: () =>
            scenario === 'stalled-cut'
              ? Effect.never
              : Effect.fail(new KafkaMarketFailure({ operation: 'read', message: 'not drained' })),
        })
        if (scenario === 'replacement')
          yield* session.start(saved.store, Effect.die('replacement must not acquire'), sessionUniverse)
        if (scenario === 'invalidation') session.observer.invalidate(CaptureInvalidation.AssignmentChanged)
        if (scenario === 'clock-reversal') session.observer.record(captureEvent('STOPPED'), sessionStart - 1)
        yield* TestClock.adjust(25_000)
        const state = yield* session.status
        const reason =
          scenario === 'failed-cut' || scenario === 'stalled-cut'
            ? CaptureInvalidation.Deadline
            : scenario === 'missing-bootstrap'
              ? CaptureInvalidation.MissedBootstrap
              : scenario === 'replacement'
                ? CaptureInvalidation.WorkerReplaced
                : scenario === 'clock-reversal'
                  ? CaptureInvalidation.ClockReversed
                  : CaptureInvalidation.AssignmentChanged
        expect(state.phase === 'finished' && state.reason).toBe(reason)
        expect(state.phase === 'finished' && state.seal?.invalidations).toContain(reason)
        expect(saved.seals).toHaveLength(1)
        return 'native work completed'
      }).pipe(Effect.tap((outcome) => Effect.sync(() => expect(outcome).toBe('native work completed')))),
    ),
)

test('worker scope interruption closes the attempt and cannot be repaired by the replacement worker', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(sessionStart)
      const saved = sessionMemory()
      const session = yield* makeResearchCaptureSession(sessionConfig, 'a'.repeat(40))
      let released = 0
      const worker = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* session.start(
            saved.store,
            Effect.acquireRelease(Effect.succeed(saved.objectStore), () =>
              Effect.sync(() => {
                released++
              }),
            ),
            sessionUniverse,
          )
          session.observer.record(captureEvent('STARTED'))
          return yield* Effect.never
        }),
      ).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(worker)
      const before = saved.writes.length
      yield* session.start(saved.store, Effect.die('must not reacquire'), sessionUniverse)
      const state = yield* session.status
      expect(state.phase === 'finished' && state.reason).toBe(CaptureInvalidation.Interrupted)
      expect(saved.writes.length).toBe(before)
      expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true)
      expect(released).toBe(1)
    }),
  ))

test('a capture acquisition clock defect cannot fail or acquire resources for native work', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(sessionStart)
      const clock = yield* Clock.Clock
      let reads = 0
      const session = yield* makeResearchCaptureSession(sessionConfig, 'a'.repeat(40)).pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeNanos: clock.currentTimeNanos,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          sleep: (duration) => clock.sleep(duration),
          currentTimeMillisUnsafe: () => {
            if (++reads > 1) throw new Error('capture acquisition clock defect')
            return sessionStart
          },
        }),
      )
      const saved = sessionMemory()
      yield* session.start(saved.store, Effect.die('must not acquire'), sessionUniverse)
      expect(yield* session.status).toEqual({ phase: 'finished', reason: CaptureInvalidation.Persistence })
      expect(saved.writes).toEqual([])
      expect(yield* Effect.succeed('native result')).toBe('native result')
    }),
  ))

test('S3 acquisition that crosses the bootstrap deadline cannot claim or export after the attempt finishes', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(sessionStart)
      const saved = sessionMemory()
      const objects = yield* Deferred.make<typeof saved.objectStore>()
      const session = yield* makeResearchCaptureSession(sessionConfig, 'a'.repeat(40))
      const acquiring = yield* session
        .start(saved.store, Deferred.await(objects), sessionUniverse)
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* session.status).toEqual({ phase: 'acquiring' })
      yield* TestClock.adjust(5000)
      expect(yield* session.status).toEqual({ phase: 'finished', reason: CaptureInvalidation.MissedBootstrap })
      yield* Deferred.succeed(objects, saved.objectStore)
      yield* Fiber.join(acquiring)
      expect(saved.writes).toEqual([])
      expect(session.workerObserver).toBeUndefined()
      expect(yield* session.status).toEqual({ phase: 'finished', reason: CaptureInvalidation.MissedBootstrap })
    }),
  ))

test.each(['before-claim', 'lost-claim-ack', 'after-claim'] as const)(
  '%s cannot acquire raw evidence or restart the fixed capture identity',
  (failure) =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(sessionStart)
        const saved = sessionMemory()
        const first = yield* makeResearchCaptureSession(sessionConfig, 'a'.repeat(40))
        const fail = Effect.fail(new ResearchCaptureFailure({ message: 'unknown capture write' }))
        yield* first.start(
          {
            ...saved.store,
            append: (bytes) =>
              failure === 'before-claim'
                ? fail
                : saved.store.append(bytes).pipe(failure === 'lost-claim-ack' ? Effect.andThen(fail) : Effect.asVoid),
          },
          Effect.succeed({ putVerified: () => fail }),
          sessionUniverse,
        )
        first.observer.record(captureEvent('STARTED'))
        yield* TestClock.adjust(1000)
        expect((yield* first.status).phase).toBe('finished')
        expect(saved.objects).toEqual([])
        expect(saved.seals).toEqual([])
        if (failure !== 'before-claim') {
          const second = yield* makeResearchCaptureSession(sessionConfig, 'a'.repeat(40))
          yield* second.start(saved.store, Effect.succeed(saved.objectStore), sessionUniverse)
          yield* TestClock.adjust(1000)
          expect((yield* second.status).phase).toBe('finished')
          expect(saved.objects).toEqual([])
          expect(saved.chunks).toHaveLength(1)
        }
      }),
    ),
)
