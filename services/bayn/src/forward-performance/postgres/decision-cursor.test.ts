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
import type { CycleDecisionRow } from './model'
import { readPerformanceDecisionCursor } from './decision-cursor'

const index = indexExecutionEvidence([], [], [])
const rows = Array.from({ length: reportVerificationConcurrency * 5 }, (_, n) => ({
  cycle_id: n.toString(16).padStart(64, '0'),
  decision_hash: n.toString(16).padStart(64, '0'),
  created_at: new Date('2026-11-15T00:00:00.000Z'),
  document: null,
}))
const projection = (row: typeof CycleDecisionRow.Type): ReportDecisionProjection => ({
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
  decision: (row: typeof CycleDecisionRow.Type) => Effect.Effect<ReportDecisionProjection, ReportVerificationError>,
) => ({
  decision,
  inference: () => Effect.die('unexpected inference'),
  coverage: () => Effect.die('unexpected coverage'),
  volume: () => Effect.die('unexpected volume'),
  volumeRequest: () => Effect.die('unexpected volume request'),
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
  let released = 0
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
})

test('inline verification retains complete hash rejection without materializing native jobs', async () => {
  const result = await Effect.runPromise(
    readPerformanceDecisionCursor(
      (consume) => Effect.forEach([rows[0]!, rows[0]!], consume, { discard: true }).pipe(Effect.as(undefined)),
      index,
    ),
  )
  expect(result).toEqual({ executionEvidence: [], unverifiedDecisionHashes: [rows[0]!.decision_hash] })
})
