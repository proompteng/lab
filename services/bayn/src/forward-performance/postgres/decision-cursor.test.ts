import { expect, test } from 'bun:test'
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { DatabaseError } from '../../db/database-error'

import {
  ReportVerification,
  ReportVerificationError,
  reportVerificationConcurrency,
  type ReportDecisionProjection,
} from '../verification'
import { indexExecutionEvidence } from './projection'
import type { CycleDecisionJsonRow } from './model'
import { readPerformanceDecisionCursor } from './decision-cursor'

const index = indexExecutionEvidence([], [], [])
const rows = Array.from({ length: reportVerificationConcurrency * 5 }, (_, n) => ({
  cycle_id: n.toString(16).padStart(64, '0'),
  decision_hash: n.toString(16).padStart(64, '0'),
  created_at: new Date('2026-11-15T00:00:00.000Z'),
  document_json: 'null',
}))
const projection = (row: typeof CycleDecisionJsonRow.Type): ReportDecisionProjection => ({
  executionEvidence: [
    {
      cycleId: row.cycle_id,
      decisionDocumentHash: row.decision_hash,
      decisionHash: row.decision_hash,
      decisionCreatedAt: row.created_at.toISOString(),
      intentId: row.decision_hash,
      accountId: 'cursor-fixture',
      symbol: 'AAPL',
      side: 'BUY',
      fills: [],
    },
  ],
  unverifiedDecisionHashes: [],
})
const service = (
  decision: (row: typeof CycleDecisionJsonRow.Type) => Effect.Effect<ReportDecisionProjection, ReportVerificationError>,
) => ({
  decision,
  alphaDecision: () => Effect.die('unexpected alpha decision'),
  inference: () => Effect.die('unexpected inference'),
  coverage: () => Effect.die('unexpected coverage'),
  volume: () => Effect.die('unexpected volume'),
  volumeRequest: () => Effect.die('unexpected volume request'),
})

test('cursor captures remaining SQL after closing its producer while ordered verification is still pending', async () => {
  const captured = { bindings: ['same-snapshot-binding'] }
  let captureStarted = false,
    firstCompleted = false
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const closed = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const work = yield* readPerformanceDecisionCursor(
          (consume) =>
            Effect.gen(function* () {
              yield* Effect.forEach(rows.slice(0, 3), consume, { discard: true })
              yield* Deferred.await(started)
              yield* Deferred.succeed(closed, undefined)
            }).pipe(Effect.as(undefined)),
          index,
          Effect.sync(() => {
            captureStarted = true
            expect(firstCompleted).toBe(false)
            return captured
          }),
        ).pipe(
          Effect.provideService(
            ReportVerification,
            service((row) =>
              Effect.gen(function* () {
                if (row.cycle_id === rows[0]!.cycle_id) {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)
                  firstCompleted = true
                }
                return projection(row)
              }),
            ),
          ),
          Effect.forkChild,
        )
        yield* Deferred.await(closed)
        yield* Effect.yieldNow
        expect(captureStarted).toBe(true)
        expect(firstCompleted).toBe(false)
        yield* Deferred.succeed(release, undefined)
        return yield* Fiber.join(work)
      }),
    ),
  )
  expect(result.captured).toBe(captured)
  expect(result.executionEvidence.map((row) => row.cycleId)).toEqual(rows.slice(0, 3).map((row) => row.cycle_id))
})

test.each(['failure', 'defect', 'interruption', 'timeout'] as const)(
  'remaining capture %s cancels and joins pending jobs without replacing its cause',
  async (kind) => {
    let started = 0,
      released = 0,
      captureReleased = 0
    const failure = new DatabaseError({
      failure: 'invariant',
      operation: 'read-snapshot',
      message: 'synthetic remaining capture failure',
    })
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const allStarted = yield* Deferred.make<void>()
          const finishCapture = Effect.acquireUseRelease(
            Effect.void,
            () =>
              kind === 'failure'
                ? Effect.fail(failure)
                : kind === 'defect'
                  ? Effect.die(failure)
                  : kind === 'interruption'
                    ? Effect.interrupt
                    : Effect.never,
            () => Effect.sync(() => captureReleased++),
          )
          const work = yield* readPerformanceDecisionCursor(
            (consume) =>
              Effect.forEach(rows.slice(0, 3), consume, { discard: true }).pipe(
                Effect.andThen(Deferred.await(allStarted)),
                Effect.as(undefined),
              ),
            index,
            finishCapture,
          ).pipe(
            Effect.provideService(
              ReportVerification,
              service(() =>
                Effect.acquireUseRelease(
                  Effect.gen(function* () {
                    if (++started === 3) yield* Deferred.succeed(allStarted, undefined)
                  }),
                  () => Effect.never,
                  () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => released++))),
                ),
              ),
            ),
            Effect.timeout(1000),
            Effect.forkChild,
          )
          if (kind === 'timeout') yield* TestClock.adjust(1000)
          return yield* Fiber.await(work)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(started).toBe(3)
    expect(released).toBe(started)
    expect(captureReleased).toBe(1)
    if (kind === 'failure')
      expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toMatchObject({ value: failure })
    if (kind === 'defect') expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    if (kind === 'interruption') expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    if (kind === 'timeout')
      expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toMatchObject({
        value: { _tag: 'TimeoutError' },
      })
  },
)

test('a worker failure interrupts remaining capture and joins all pending jobs', async () => {
  let started = 0,
    released = 0,
    captureReleased = 0
  const failure = new ReportVerificationError({ message: 'synthetic worker failure during capture' })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const allStarted = yield* Deferred.make<void>()
      const captureStarted = yield* Deferred.make<void>()
      return yield* readPerformanceDecisionCursor(
        (consume) =>
          Effect.forEach(rows.slice(0, 2), consume, { discard: true }).pipe(
            Effect.andThen(Deferred.await(allStarted)),
            Effect.as(undefined),
          ),
        index,
        Effect.acquireUseRelease(
          Deferred.succeed(captureStarted, undefined),
          () => Effect.never,
          () => Effect.sync(() => captureReleased++),
        ),
      ).pipe(
        Effect.provideService(
          ReportVerification,
          service((row) =>
            Effect.acquireUseRelease(
              Effect.gen(function* () {
                if (++started === 2) yield* Deferred.succeed(allStarted, undefined)
              }),
              () =>
                row.cycle_id === rows[0]!.cycle_id
                  ? Deferred.await(captureStarted).pipe(Effect.andThen(Effect.fail(failure)))
                  : Effect.never,
              () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => released++))),
            ),
          ),
        ),
        Effect.result,
      )
    }),
  )
  expect(result).toMatchObject({ _tag: 'Failure', failure })
  expect(started).toBe(2)
  expect(released).toBe(started)
  expect(captureReleased).toBe(1)
})

test('an empty cursor closes before capturing exactly once', async () => {
  let closed = false,
    captures = 0
  const captured = ['empty-cut-binding']
  const result = await Effect.runPromise(
    readPerformanceDecisionCursor(
      () =>
        Effect.sync(() => {
          closed = true
        }).pipe(Effect.as(undefined)),
      index,
      Effect.sync(() => {
        expect(closed).toBe(true)
        captures++
        return captured
      }),
    ),
  )
  expect(result).toEqual({ executionEvidence: [], unverifiedDecisionHashes: [], captured })
  expect(captures).toBe(1)
})

test('cursor bounds raw lookahead, feeds beyond a slow first batch and preserves source order', async () => {
  let read = 0
  const started: string[] = []
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>()
        const reading = yield* Deferred.make<void>()
        const running = yield* Deferred.make<void>()
        const work = readPerformanceDecisionCursor(
          (consume) =>
            Effect.forEach(
              rows,
              (row) => {
                read++
                return read === reportVerificationConcurrency * 4
                  ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(consume(row)))
                  : consume(row)
              },
              { discard: true },
            ).pipe(Effect.as(undefined)),
          index,
          Effect.void,
        ).pipe(
          Effect.provideService(
            ReportVerification,
            service((row) =>
              Effect.gen(function* () {
                started.push(row.cycle_id)
                if (started.length > reportVerificationConcurrency) yield* Deferred.succeed(running, undefined)
                if (row.cycle_id === rows[0]!.cycle_id) yield* Deferred.await(release)
                return projection(row)
              }),
            ),
          ),
        )
        const fiber = yield* work.pipe(Effect.forkChild)
        yield* Effect.all([Deferred.await(reading), Deferred.await(running)], { concurrency: 2 })
        expect(read).toBe(reportVerificationConcurrency * 4)
        expect(started.length).toBeGreaterThan(reportVerificationConcurrency)
        yield* Deferred.succeed(release, undefined)
        return yield* Fiber.join(fiber)
      }),
    ),
  )
  expect(read).toBe(rows.length)
  expect(result.executionEvidence.map((row) => row.cycleId)).toEqual(rows.map((row) => row.cycle_id))
})

test.each(['failure', 'defect', 'interruption', 'timeout'] as const)(
  'cursor cancels and joins every outstanding job on %s',
  async (kind) => {
    let started = 0,
      released = 0
    const failure = new ReportVerificationError({ message: 'synthetic cursor worker failure' })
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstStarted = yield* Deferred.make<void>()
          const work = readPerformanceDecisionCursor(
            (consume) => Effect.forEach(rows, consume, { discard: true }).pipe(Effect.as(undefined)),
            index,
            Effect.void,
          ).pipe(
            Effect.provideService(
              ReportVerification,
              service((row) =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    started++
                  }).pipe(Effect.tap(() => Deferred.succeed(firstStarted, undefined))),
                  () =>
                    row.cycle_id === rows[1]!.cycle_id && (kind === 'failure' || kind === 'defect')
                      ? kind === 'failure'
                        ? Effect.fail(failure)
                        : Effect.die(failure)
                      : Effect.never,
                  () =>
                    Effect.sync(() => {
                      released++
                    }),
                ),
              ),
            ),
            Effect.timeout(1000),
          )
          const fiber = yield* work.pipe(Effect.forkChild)
          yield* Deferred.await(firstStarted)
          if (kind === 'interruption') yield* Fiber.interrupt(fiber)
          if (kind === 'timeout') yield* TestClock.adjust(1000)
          return yield* Fiber.await(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(started).toBeGreaterThan(0)
    expect(released).toBe(started)
    if (kind === 'failure')
      expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toMatchObject({ value: failure })
    if (kind === 'defect') expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    if (kind === 'timeout')
      expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toMatchObject({
        value: { _tag: 'TimeoutError' },
      })
    if (kind === 'interruption') expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  },
)

test('a cursor transport failure cancels an already-running verification before returning its original error', async () => {
  let released = 0,
    captures = 0
  const failure = new DatabaseError({
    failure: 'invariant',
    operation: 'read-snapshot',
    message: 'synthetic cursor failure',
  })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      return yield* readPerformanceDecisionCursor(
        (consume) =>
          Effect.gen(function* () {
            yield* consume(rows[0]!)
            yield* Deferred.await(started)
            return yield* failure
          }),
        index,
        Effect.sync(() => {
          captures++
        }),
      ).pipe(
        Effect.provideService(
          ReportVerification,
          service(() =>
            Effect.acquireUseRelease(
              Deferred.succeed(started, undefined),
              () => Effect.never,
              () =>
                Effect.sync(() => {
                  released++
                }),
            ),
          ),
        ),
        Effect.result,
      )
    }),
  )
  expect(result).toMatchObject({ _tag: 'Failure', failure })
  expect(released).toBe(1)
  expect(captures).toBe(0)
})

test('inline verification finishes serially before capture and retains complete hash rejection', async () => {
  let consumed = 0
  const result = await Effect.runPromise(
    readPerformanceDecisionCursor(
      (consume) =>
        Effect.forEach(
          [rows[0]!, { ...rows[0]!, document_json: '{' }, { ...rows[0]!, document_json: null }],
          (row) =>
            consume(row).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  consumed++
                }),
              ),
            ),
          { discard: true },
        ).pipe(Effect.as(undefined)),
      index,
      Effect.sync(() => {
        expect(consumed).toBe(3)
      }),
    ),
  )
  expect(result).toEqual({
    executionEvidence: [],
    unverifiedDecisionHashes: [rows[0]!.decision_hash],
    captured: undefined,
  })
})
