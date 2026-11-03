import { expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { NodeServices } from '@effect/platform-node'
import { Clock, Deferred, Effect, Exit, Fiber, FileSystem, Tracer } from 'effect'
import { TestClock } from 'effect/testing'
import { retainedReplayFixture } from '../testing/retained-replay-fixture'
import { openBacktestSource } from './source'
import { makeReplayPhaseTracer, type ReplayPhaseRecord } from './replay-phase-tracer.test-support'

test('normal and diagnostic CLI imports are inert and both entrypoints execute help exactly once', () => {
  const normal = `${import.meta.dir}/../backtest-command.ts`
  const traced = `${import.meta.dir}/replay-phase-command.test-support.ts`
  const imported = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--eval',
      `await import(${JSON.stringify(normal)}); await import(${JSON.stringify(traced)}); console.log('imported')`,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10000,
  })
  expect(imported.exitCode).toBe(0)
  expect(imported.stdout.toString()).toBe('imported\n')
  expect(imported.stderr.toString()).toBe('')
  const outputs = [normal, traced].map((entrypoint) => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, entrypoint, '--help'],
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10000,
    })
    expect(child.exitCode).toBe(0)
    expect(child.stderr.toString()).toBe('')
    return child.stdout.toString()
  })
  expect(outputs[0]).toBe(outputs[1])
  expect(outputs[0]?.match(/Usage:/g)).toHaveLength(1)
})

test('phase durations use the captured monotonic clock, not replay time, and never expose payloads', async () => {
  const records: ReplayPhaseRecord[] = []
  let now = 0n
  const tracer = makeReplayPhaseTracer({ monotonicTimeNanosUnsafe: () => now }, (record) => records.push(record))
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* TestClock.adjust(86_400_000)
      now = 7_000_000n
      yield* Effect.annotateCurrentSpan('private', 'secret-fixture')
      return 'private-result'
    }).pipe(
      Effect.withSpan('bayn.backtest.sessions'),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  )
  expect(result).toEqual(Exit.succeed('private-result'))
  expect(records).toEqual([
    { phase: 'bayn.backtest.sessions', status: 'started', elapsedMs: 0 },
    { phase: 'bayn.backtest.sessions', status: 'completed', elapsedMs: 7 },
  ])
})

test('failure and interruption retain outcome and a visible start without leaking causes', async () => {
  const records: ReplayPhaseRecord[] = []
  const tracer = makeReplayPhaseTracer({ monotonicTimeNanosUnsafe: () => 0n }, (record) => records.push(record))
  const failure = await Effect.runPromiseExit(
    Effect.fail('private-error').pipe(
      Effect.withSpan('bayn.backtest.source-preflight'),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  )
  expect(Exit.isFailure(failure)).toBe(true)
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const fiber = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.withSpan('bayn.backtest.source-tail'),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      expect(records.at(-1)?.status).toBe('started')
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provideService(Tracer.Tracer, tracer)),
  )
  expect(records.map((record) => record.status)).toEqual(['started', 'failed', 'started', 'interrupted'])
  expect(JSON.stringify(records)).not.toContain('private-error')
  const defect = await Effect.runPromiseExit(
    Effect.die('private-defect').pipe(
      Effect.withSpan('bayn.backtest.report-evidence'),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  )
  expect(Exit.isFailure(defect)).toBe(true)
  expect(records.at(-1)?.status).toBe('failed')
  expect(JSON.stringify(records)).not.toContain('private-defect')
})

test('unlisted spans are silent and diagnostic output is bounded', async () => {
  const records: ReplayPhaseRecord[] = []
  const tracer = makeReplayPhaseTracer({ monotonicTimeNanosUnsafe: () => 0n }, (record) => records.push(record))
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan('private-source-name'))
      yield* Effect.forEach(Array.from({ length: 40 }), () =>
        Effect.void.pipe(Effect.withSpan('bayn.backtest.sessions')),
      )
    }).pipe(Effect.provideService(Tracer.Tracer, tracer)),
  )
  expect(records).toHaveLength(64)
  expect(records.every((record) => record.phase === 'bayn.backtest.sessions')).toBe(true)
})

test('real source preflight and retained tail produce phase receipts without changing evidence', async () => {
  const records: ReplayPhaseRecord[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* Clock.clockWith(Effect.succeed)
        const tracer = makeReplayPhaseTracer(clock, (record) => records.push(record))
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const fixture = retainedReplayFixture()
        const path = `${directory}/arrivals.gz`
        yield* fs.writeFile(path, gzipSync(fixture.body))
        yield* Effect.gen(function* () {
          const source = yield* openBacktestSource(path, fixture.manifest, fixture.input.source.runId, fixture.capture)
          yield* source.finish
          expect((yield* source.cursor).processedRecords).toBe(fixture.manifest.recordCount)
        }).pipe(Effect.provideService(Tracer.Tracer, tracer))
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(records.map(({ phase, status }) => ({ phase, status }))).toEqual([
    { phase: 'bayn.backtest.source-preflight', status: 'started' },
    { phase: 'bayn.backtest.source-preflight', status: 'completed' },
    { phase: 'bayn.backtest.source-tail', status: 'started' },
    { phase: 'bayn.backtest.source-tail', status: 'completed' },
  ])
})
