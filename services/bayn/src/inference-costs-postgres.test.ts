import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Deferred, Effect, Effectable, Exit, Fiber, Redacted, Result, Stream } from 'effect'
import * as Reactivity from 'effect/reactivity/Reactivity'
import type { Statement } from 'effect/sql/Statement'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result } from './hash'
import { decodeInferenceCostEvidence, decodeInferenceCostRequest } from './inference-costs'
import { ReportVerification, reportVerificationConcurrency } from './forward-performance/verification'
import { acquireInferenceExpenseSnapshot } from './inference-costs-postgres'
import { inferenceExpenseRateCard, makeInferenceExpenseQuotes, type InferenceExpenseSource } from './inference-expense'
import {
  entryCompletionFixture,
  entryEvaluationRequestFixture,
  stagedCheckpointFixture,
} from './jev/entry-inference.test-support'
import { JevOutcome, makeJevEvaluationReceipt } from './jev/evidence'

const accountId = 'snapshot-scheduling-fixture'
const sessionDate = '2026-10-25'
const asOf = '2026-10-25T07:01:00.000Z'
const sources = ['AAPL', 'MSFT', 'NVDA'].map((symbol): InferenceExpenseSource => {
  const request = entryEvaluationRequestFixture('2026-10-25T07:00:32.000Z', symbol)
  const completion = entryCompletionFixture(request)
  return {
    accountId,
    sessionDate,
    asOf,
    requestId: request.requestId,
    cycleId: request.cycleId,
    authorityGenerationHash: request.authorityGenerationHash,
    request,
    receipt: Result.getOrThrow(
      makeJevEvaluationReceipt(request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v3',
        requestId: request.requestId,
        startedAt: request.observedAt,
        completedAt: completion.completedAt,
        outcome: { status: JevOutcome.Completed, completion },
      }),
    ),
    resolution: null,
    handoff: completion.handoff,
    stagedCheckpoint: stagedCheckpointFixture(request),
  }
})
const requests = sources.map(({ accountId: _account, sessionDate: _date, asOf: _asOf, ...row }) => row)
const quotes = sources.flatMap((source) =>
  Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard)),
)
const cut = { as_of: asOf, request_count: requests.length, quote_count: quotes.length }
const rows = [
  { ...cut, kind: 'CUT', payload: null },
  ...requests.map((payload) => ({ ...cut, kind: 'REQUEST', payload })),
  ...quotes.map((quote) => ({
    ...cut,
    kind: 'QUOTE',
    payload: { quoteHash: quote.quoteHash, payload: quote, verifiedAt: asOf },
  })),
]
const expectedEvidence = Result.getOrThrow(
  decodeInferenceCostEvidence({
    schemaVersion: 'bayn.inference-cost-evidence.v4',
    accountBindingHash: Result.getOrThrow(
      canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId }),
    ),
    sessionDate,
    asOf,
    requests,
  }),
)

const readFixture = (input: readonly unknown[], afterCapture: () => void, onRelease: () => void) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* PgClient.make({
        url: Redacted.make('postgres://unused@127.0.0.1:1/unused_test'),
        minConnections: 0,
        stream: () => {
          throw new Error('Snapshot scheduling test must not connect')
        },
      })
      const captured = new Proxy(sql, {
        get(target, property, receiver) {
          if (property === 'withTransaction')
            return <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.ensuring(Effect.sync(onRelease)))
          return Reflect.get(target, property, receiver)
        },
        apply(target, receiver, args) {
          const statement: Statement<unknown> = Reflect.apply(target, receiver, args)
          const observed = Effectable.Prototype({
            label: 'Snapshot fixture statement',
            evaluate: () => Effect.succeed([]),
          })
          return new Proxy(statement, {
            get(target, property, receiver) {
              if (property === 'stream') return Stream.fromArray(input)
              return Object.hasOwn(observed, property)
                ? Reflect.get(observed, property, receiver)
                : Reflect.get(target, property, receiver)
            },
          })
        },
      })
      const snapshot = yield* acquireInferenceExpenseSnapshot(captured, accountId, sessionDate)
      afterCapture()
      return yield* snapshot.verify
    }),
  ).pipe(Effect.provide(Reactivity.layer))

test('expense verification starts the next request while an earlier request is still outstanding', async () => {
  const inputRequests = Array.from(
    { length: reportVerificationConcurrency + 1 },
    (_, n) => requests[n % requests.length]!,
  )
  const metadata = { as_of: asOf, request_count: inputRequests.length, quote_count: 0 }
  const input = [
    { ...metadata, kind: 'CUT', payload: null },
    ...inputRequests.map((payload) => ({ ...metadata, kind: 'REQUEST', payload })),
  ]
  let calls = 0,
    releases = 0
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>()
        const next = yield* Deferred.make<void>()
        const pending = yield* readFixture(
          input,
          () => {},
          () => {
            releases++
          },
        ).pipe(
          Effect.provideService(ReportVerification, {
            volume: () => Effect.die('unexpected volume'),
            volumeRequest: () => Effect.die('unexpected volume request'),
            decision: () => Effect.die('unexpected decision'),
            alphaDecision: () => Effect.die('unexpected alpha decision'),
            coverage: () => Effect.die('unexpected coverage'),
            inference: (payload, cutoff) =>
              Effect.gen(function* () {
                const ordinal = calls++
                if (ordinal === reportVerificationConcurrency) yield* Deferred.succeed(next, undefined)
                if (ordinal === 0) yield* Deferred.await(first)
                return yield* Effect.fromResult(decodeInferenceCostRequest(payload, cutoff))
              }),
          }),
          Effect.forkChild,
        )
        yield* Deferred.await(next)
        expect(releases).toBe(1)
        expect(calls).toBe(inputRequests.length)
        yield* Deferred.succeed(first, undefined)
        return yield* Fiber.join(pending)
      }),
    ),
  )
  expect(result.evidence.requests.map((request) => request.requestId)).toEqual(
    inputRequests.map((request) => request.requestId).sort(),
  )
  expect(result.quotes).toEqual([])
})

test('expense snapshot verification services the event loop after releasing its complete source cut', async () => {
  let serviced = false
  let releases = 0
  let immediate: ReturnType<typeof setImmediate> | undefined
  try {
    const result = await Effect.runPromise(
      readFixture(
        rows,
        () => {
          expect(releases).toBe(1)
          immediate = setImmediate(() => {
            serviced = true
          })
        },
        () => {
          releases++
        },
      ),
    )
    expect(serviced).toBe(true)
    expect(releases).toBe(1)
    expect(result.evidence).toEqual({
      ...expectedEvidence,
      requests: expectedEvidence.requests.toSorted((left, right) => left.requestId.localeCompare(right.requestId)),
    })
    expect(result.quotes).toEqual(quotes.map((quote) => ({ quote, verifiedAt: asOf })))
  } finally {
    if (immediate) clearImmediate(immediate)
  }
})

test('expense snapshot verification interrupts without publishing a partial result or retaining its transaction', async () => {
  const controller = new AbortController()
  let releases = 0
  let immediate: ReturnType<typeof setImmediate> | undefined
  try {
    const exit = await Effect.runPromiseExit(
      readFixture(
        rows,
        () => {
          immediate = setImmediate(() => controller.abort())
        },
        () => {
          releases++
        },
      ),
      { signal: controller.signal },
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(releases).toBe(1)
  } finally {
    if (immediate) clearImmediate(immediate)
  }
})

test('expense snapshot verification observes its existing caller deadline and finalizes once', async () => {
  let releases = 0
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* readFixture(
        rows,
        () => {},
        () => releases++,
      ).pipe(Effect.timeout(1_000), Effect.result, Effect.forkChild)
      yield* TestClock.adjust(1_000)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(exit).toMatchObject({ _tag: 'Failure', failure: { _tag: 'TimeoutError' } })
  expect(releases).toBe(1)
})

test.each([
  {
    name: 'identity',
    input: rows.map((row) =>
      row.kind === 'REQUEST' ? { ...row, payload: { ...requests[0], requestId: 'f'.repeat(64) } } : row,
    ),
  },
  { name: 'coverage', input: rows.map((row) => ({ ...row, request_count: requests.length + 1 })) },
  { name: 'cutoff', input: rows.map((row) => ({ ...row, as_of: '2026-10-25T07:00:00.000Z' })) },
])('expense snapshot scheduling retains $name rejection', async ({ input }) => {
  let releases = 0
  const result = await Effect.runPromise(
    readFixture(
      input,
      () => {},
      () => releases++,
    ).pipe(Effect.result),
  )
  expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InferenceCostError' } })
  expect(releases).toBe(1)
})
