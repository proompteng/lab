import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { expect, test } from 'bun:test'
import { Cause, Effect, Exit, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { verifyReportJob } from '../forward-performance-verification-worker'
import { executionEvidenceFromRows, indexExecutionEvidence, verifyPerformanceDecisions } from './postgres/projection'
import { retainedV38ExecutionFixture } from '../jev/retained-v38-execution.test-support'
import {
  makeReportVerification,
  reportVerificationConcurrency,
  type ReportVerificationJob,
  type ReportVerificationReply,
} from './verification'

const index = indexExecutionEvidence([], [], [])
const row = (ordinal = 0) => ({
  cycle_id: 'a'.repeat(64),
  decision_hash: ordinal.toString(16).padStart(64, '0'),
  created_at: new Date('2026-11-15T00:00:00.000Z'),
  document: null,
})

class FixtureWorker extends EventEmitter {
  threadId = 1
  terminations = 0
  readonly pending: ReportVerificationJob[] = []
  constructor(
    readonly automatic: boolean,
    readonly reply: (job: ReportVerificationJob) => ReportVerificationReply = verifyReportJob,
  ) {
    super()
  }
  postMessage(job: ReportVerificationJob) {
    this.pending.push(structuredClone(job))
    if (this.automatic) queueMicrotask(() => this.complete())
  }
  complete() {
    const job = this.pending.shift()
    if (job === undefined) throw new Error('No pending fixture job')
    this.emit('message', this.reply(job))
  }
  async terminate() {
    this.terminations++
    this.threadId = -1
    this.emit('exit', 0)
    return 0
  }
}

const fixtures = (automatic = true, reply?: (job: ReportVerificationJob) => ReportVerificationReply) => {
  const workers: FixtureWorker[] = []
  return {
    workers,
    spawn: () => {
      const worker = new FixtureWorker(automatic, reply)
      workers.push(worker)
      return worker as unknown as Worker
    },
  }
}

test('report verification bounds in-flight jobs, preserves ordering and terminates every worker once', async () => {
  const fixture = fixtures(false)
  const inputs = Array.from({ length: reportVerificationConcurrency * 2 }, (_, ordinal) => row(ordinal))
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const verifier = yield* makeReportVerification(fixture.spawn)
        const pending = yield* Effect.forEach(inputs, (input) => verifier.decision(input, index), {
          concurrency: 'unbounded',
        }).pipe(Effect.forkChild)
        for (let wave = 0; wave < 2; wave++) {
          yield* Effect.yieldNow
          expect(fixture.workers).toHaveLength(reportVerificationConcurrency)
          expect(fixture.workers.reduce((sum, worker) => sum + worker.pending.length, 0)).toBe(
            reportVerificationConcurrency,
          )
          for (const worker of [...fixture.workers].reverse()) worker.complete()
          for (const worker of fixture.workers) {
            expect(worker.listenerCount('message')).toBe(0)
            expect(worker.listenerCount('error')).toBe(1)
            expect(worker.listenerCount('exit')).toBe(1)
          }
        }
        return yield* Fiber.join(pending)
      }),
    ),
  )
  expect(result.map((value) => value.unverifiedDecisionHashes)).toEqual(inputs.map((input) => [input.decision_hash]))
  expect(fixture.workers.every((worker) => worker.terminations === 1 && worker.eventNames().length === 0)).toBe(true)
})

test.each(['job identity', 'task identity'] as const)(
  'rejects a substituted %s and disposes its worker',
  async (kind) => {
    const fixture = fixtures(true, (job) =>
      kind === 'job identity'
        ? { ...verifyReportJob(job), id: job.id + 1 }
        : { id: job.id, outcome: 'INVALID_INFERENCE', message: 'wrong task', cause: 'fixture' },
    )
    const result = await Effect.runPromise(
      Effect.scoped(
        makeReportVerification(fixture.spawn).pipe(
          Effect.flatMap((verifier) => verifier.decision(row(), index)),
          Effect.result,
        ),
      ),
    )
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ReportVerificationError' } })
    expect(fixture.workers).toHaveLength(1)
    expect(fixture.workers[0]?.terminations).toBe(1)
  },
)

test('preserves malformed inference as a typed financial-source failure', async () => {
  const fixture = fixtures()
  const result = await Effect.runPromise(
    Effect.scoped(
      makeReportVerification(fixture.spawn).pipe(
        Effect.flatMap((verifier) => verifier.inference({}, '2026-11-15T00:00:00.000Z')),
        Effect.result,
      ),
    ),
  )
  expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InferenceCostError' } })
  expect(fixture.workers[0]?.terminations).toBe(1)
})

test('propagates a worker defect without returning partial financial evidence', async () => {
  const fixture = fixtures(true, (job) => ({ id: job.id, outcome: 'DEFECT', cause: new Error('synthetic defect') }))
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      makeReportVerification(fixture.spawn).pipe(Effect.flatMap((verifier) => verifier.decision(row(), index))),
    ),
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(fixture.workers[0]?.terminations).toBe(1)
})

test.each(['interruption', 'timeout'] as const)('terminates outstanding report CPU work on %s', async (end) => {
  const fixture = fixtures(false)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const verifier = yield* makeReportVerification(fixture.spawn)
        const pending = yield* verifier
          .decision(row(), index)
          .pipe(Effect.timeout(1_000), Effect.result, Effect.forkChild)
        yield* Effect.yieldNow
        expect(fixture.workers).toHaveLength(1)
        if (end === 'interruption') yield* Fiber.interrupt(pending)
        else {
          yield* TestClock.adjust(1_000)
          expect(yield* Fiber.join(pending)).toMatchObject({ _tag: 'Failure', failure: { _tag: 'TimeoutError' } })
        }
        expect(fixture.workers[0]?.terminations).toBe(1)
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )
  expect(fixture.workers[0]?.terminations).toBe(1)
})

test('preserves a spawn failure and closes without retrying or creating more workers', async () => {
  const cause = new Error('synthetic worker unavailable')
  let spawns = 0
  const result = await Effect.runPromise(
    Effect.scoped(
      makeReportVerification(() => {
        spawns++
        throw cause
      }).pipe(
        Effect.flatMap((verifier) => verifier.decision(row(), index)),
        Effect.result,
      ),
    ),
  )
  expect(Result.isFailure(result) && result.failure.cause).toBe(cause)
  expect(spawns).toBe(1)
})

test('a verifier cannot acquire a worker after its owning scope closes', async () => {
  const fixture = fixtures()
  const verifier = await Effect.runPromise(Effect.scoped(makeReportVerification(fixture.spawn)))
  const result = await Effect.runPromise(verifier.decision(row(), index).pipe(Effect.result))
  expect(result).toMatchObject({ _tag: 'Failure', failure: { message: 'Report verification scope is closed' } })
  expect(fixture.workers).toHaveLength(0)
})

test.each(['error', 'exit', 'postMessage'] as const)(
  'fails closed and terminates once on worker %s failure',
  async (kind) => {
    const fixture = fixtures(false)
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const verifier = yield* makeReportVerification(() => {
            const worker = fixture.spawn()
            if (kind === 'postMessage')
              worker.postMessage = () => {
                throw new Error('synthetic clone failure')
              }
            return worker
          })
          const pending = yield* verifier.decision(row(), index).pipe(Effect.result, Effect.forkChild)
          yield* Effect.yieldNow
          if (kind !== 'postMessage')
            fixture.workers[0]!.emit(kind, kind === 'error' ? new Error('synthetic crash') : 1)
          return yield* Fiber.join(pending)
        }),
      ),
    )
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ReportVerificationError' } })
    expect(fixture.workers[0]?.terminations).toBe(1)
  },
)

test('native worker preserves genuine retained execution projections and rejects corrupt documents', async () => {
  const { document, bytes } = retainedV38ExecutionFixture(0)
  const valid = {
    cycle_id: document.bindings.cycleId,
    decision_hash: document.contentHash,
    created_at: new Date(document.createdAt),
    document: JSON.parse(bytes.toString('utf8')),
  }
  const corrupt = { ...valid, document: { ...valid.document, contentHash: 'f'.repeat(64) } }
  const inputs = [valid, corrupt]
  const actual = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const verifier = yield* makeReportVerification()
        return yield* Effect.forEach(inputs, (input) => verifier.decision(input, index), { concurrency: 2 })
      }),
    ),
  )
  expect(actual).toEqual(
    inputs.map((input) => {
      const verified = verifyPerformanceDecisions([input])
      return {
        executionEvidence: executionEvidenceFromRows(verified.verifiedRows, index),
        unverifiedDecisionHashes: verified.unverifiedDecisionHashes,
      }
    }),
  )
  expect(actual[0]?.executionEvidence.length).toBeGreaterThan(0)
  expect(actual[1]?.unverifiedDecisionHashes).toEqual([valid.decision_hash])
}, 15_000)
