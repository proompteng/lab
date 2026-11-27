import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { expect, test } from 'bun:test'
import { Cause, Effect, Exit, Fiber, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { verifyReportJob } from '../forward-performance-verification-worker'
import { executionEvidenceFromRows, indexExecutionEvidence, verifyPerformanceDecisions } from './postgres/projection'
import type { CycleDecisionJsonRow } from './postgres/model'
import { CycleState } from '../cycle/model'
import type { AlphaDecisionJsonRow } from './postgres/alpha-decisions'
import { IsoDateSchema } from '../schemas'
import { retainedV38ExecutionFixture } from '../jev/retained-v38-execution.test-support'
import {
  makeIntradayPerformanceFixture,
  makeStreamingPerformanceFixture,
  makeStreamingPartitionPerformanceFixture,
} from './intraday-cycle.test-support'
import { intradayPerformanceDecisionRequest, makeIntradayPerformanceVolumeEvidenceBatch } from './intraday-volume'
import {
  makeReportVerification,
  reportVerificationConcurrency,
  ReportVerificationTask,
  type ReportDecisionIndex,
  type ReportVerificationJob,
  type ReportVerificationReply,
} from './verification'

const index = indexExecutionEvidence([], [], [])
const row = (ordinal = 0) => ({
  cycle_id: 'a'.repeat(64),
  decision_hash: ordinal.toString(16).padStart(64, '0'),
  created_at: new Date('2026-11-15T00:00:00.000Z'),
  document_json: 'null',
})

class FixtureWorker extends EventEmitter {
  threadId = 1
  terminations = 0
  readonly pending: ReportVerificationJob[] = []
  readonly received: ReportVerificationJob[] = []
  decisionIndex: ReportDecisionIndex | undefined
  constructor(
    readonly automatic: boolean,
    readonly reply: (job: ReportVerificationJob) => ReportVerificationReply = verifyReportJob,
  ) {
    super()
  }
  postMessage(job: ReportVerificationJob) {
    const cloned = structuredClone(job)
    this.pending.push(cloned)
    this.received.push(cloned)
    if (this.automatic) queueMicrotask(() => this.complete())
  }
  complete() {
    const job = this.pending.shift()
    if (job === undefined) throw new Error('No pending fixture job')
    if (job.input.task === ReportVerificationTask.Decision) {
      this.decisionIndex = job.input.index ?? this.decisionIndex
      if (this.decisionIndex === undefined) throw new Error('Fixture decision index is unavailable')
      this.emit('message', this.reply({ ...job, input: { ...job.input, index: this.decisionIndex } }))
    } else this.emit('message', this.reply(job))
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
  expect(
    fixture.workers.every(
      (worker) =>
        worker.received.filter(
          (job) => job.input.task === ReportVerificationTask.Decision && job.input.index !== undefined,
        ).length === 1,
    ),
  ).toBe(true)
})

test('replaces each worker index when a new report cut is supplied', async () => {
  const fixture = fixtures()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const verifier = yield* makeReportVerification(fixture.spawn)
        for (const cut of [index, index, indexExecutionEvidence([], [], [])])
          yield* Effect.forEach(
            Array.from({ length: reportVerificationConcurrency }, (_, n) => row(n)),
            (input) => verifier.decision(input, cut),
            { concurrency: reportVerificationConcurrency },
          )
        expect(fixture.workers).toHaveLength(reportVerificationConcurrency)
        for (const worker of fixture.workers) {
          expect(worker.received).toHaveLength(3)
          expect(
            worker.received.map(
              (job) => job.input.task === ReportVerificationTask.Decision && job.input.index !== undefined,
            ),
          ).toEqual([true, false, true])
        }
      }),
    ),
  )
})

test('native alpha worker jobs preserve rejected decision denominators without an execution index', async () => {
  const fixture = fixtures()
  const inputs: (typeof AlphaDecisionJsonRow.Type)[] = [0, 1, 2].map((ordinal) => ({
    ...row(ordinal),
    account_id: 'alpha-fixture',
    authority_generation_hash: 'b'.repeat(64),
    qualification_run_id: 'c'.repeat(64),
    strategy_protocol_hash: 'd'.repeat(64),
    risk_policy_hash: 'e'.repeat(64),
    session_date: Schema.decodeUnknownSync(IsoDateSchema)('2026-11-15'),
    cycle_state: CycleState.Active,
    terminal_at: null,
    generation_activated_at: new Date('2026-11-14T00:00:00.000Z'),
    reconciled_at: new Date('2026-11-15T01:00:00.000Z'),
    execution_evidence_in_scope: false,
    qualification_build: null,
    activation_build: null,
  }))
  const projections = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const verifier = yield* makeReportVerification(fixture.spawn)
        return yield* Effect.forEach(inputs, (input) => verifier.alphaDecision(input), {
          concurrency: reportVerificationConcurrency,
        })
      }),
    ),
  )
  expect(projections).toEqual(
    inputs.map((input) => ({ alphaDecisions: [], unverifiedAlphaDecisionHashes: [input.decision_hash] })),
  )
  expect(
    fixture.workers
      .flatMap((worker) => worker.received)
      .every((job) => job.input.task === ReportVerificationTask.AlphaDecision && !('index' in job.input)),
  ).toBe(true)
  expect(fixture.workers.every((worker) => worker.terminations === 1)).toBe(true)
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
  const objects = [valid, corrupt, { ...valid, document: null }]
  const transported: (typeof CycleDecisionJsonRow.Type)[] = objects.map(({ document, ...metadata }) => ({
    ...metadata,
    document_json: JSON.stringify(document),
  }))
  transported.push({ ...transported[0]!, document_json: '{' }, { ...transported[0]!, document_json: null })
  const inputs = Array.from(
    { length: reportVerificationConcurrency + 2 },
    (_, n) => transported[n % transported.length]!,
  )
  const actual = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const verifier = yield* makeReportVerification()
        return yield* Effect.forEach(inputs, (input) => verifier.decision(input, index), { concurrency: 2 })
      }),
    ),
  )
  const expected = objects.map((input) => {
    const verified = verifyPerformanceDecisions([input])
    return {
      executionEvidence: executionEvidenceFromRows(verified.verifiedRows, index),
      unverifiedDecisionHashes: verified.unverifiedDecisionHashes,
    }
  })
  expected.push(
    { executionEvidence: [], unverifiedDecisionHashes: [valid.decision_hash] },
    { executionEvidence: [], unverifiedDecisionHashes: [valid.decision_hash] },
  )
  expect(actual).toEqual(inputs.map((_, n) => expected[n % expected.length]))
  expect(actual[0]?.executionEvidence.length).toBeGreaterThan(0)
  expect(actual[1]?.unverifiedDecisionHashes).toEqual([valid.decision_hash])
}, 30_000)

test('native volume verification preserves complete, sparse and missing-close evidence and typed failures', async () => {
  const { request, archive, bars } = makeIntradayPerformanceFixture()
  const inputs = [bars, bars.slice(1), bars.slice(0, -1), [bars[0], ...bars]]
  const actual = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const verifier = yield* makeReportVerification()
        return yield* Effect.forEach(inputs, (input) => verifier.volume([request], archive, input).pipe(Effect.result))
      }),
    ),
  )
  for (const [i, input] of inputs.entries()) {
    const expected = makeIntradayPerformanceVolumeEvidenceBatch([request], archive, input)
    const result = actual[i]
    if (Result.isSuccess(expected)) expect(result).toEqual(expected)
    else {
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'IntradaySnapshotFailure',
          reason: expected.failure.reason,
          message: expected.failure.message,
        },
      })
    }
  }
}, 30_000)

test('native grouping authenticates original intraday, streaming and partition manifests before querying', async () => {
  const inputs = [
    makeIntradayPerformanceFixture,
    makeStreamingPerformanceFixture,
    makeStreamingPartitionPerformanceFixture,
  ].flatMap((makeFixture) => {
    const { request } = makeFixture()
    return [request, { ...request, decisionSnapshotId: '0'.repeat(64) }]
  })
  const actual = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const verifier = yield* makeReportVerification()
        return yield* Effect.forEach(inputs, (request) => verifier.volumeRequest(request).pipe(Effect.result), {
          concurrency: 2,
        })
      }),
    ),
  )
  for (const [i, request] of inputs.entries()) {
    const expected = intradayPerformanceDecisionRequest(request)
    if (Result.isSuccess(expected)) expect(actual[i]).toEqual(expected)
    else
      expect(actual[i]).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'IntradaySnapshotFailure',
          reason: expected.failure.reason,
          message: expected.failure.message,
        },
      })
  }
}, 30_000)
