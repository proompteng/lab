import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Cause, Deferred, Effect, Fiber, FileSystem, Path, Result, Stream } from 'effect'
import { gunzipSync } from 'node:zlib'

import { sha256 } from '../hash'
import { makeNativeArrivalChunk } from '../market-data/streaming/native-arrival'
import { nativeArrivalExportFixture as fixture } from './native-arrival-export.test-support'
import { parseNativeArrivalExportArgs } from '../native-arrival-export-command'
import { exportNativeArrivalPrefix } from './native-arrival-export'
import { ReplaySourceFailure } from './source'

test('exports exact gzip members and validates the complete original prefix through the controls reader', async () => {
  const data = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const outputPath = path.join(root, 'export')
      const report = yield* exportNativeArrivalPrefix({
        ...data,
        throughOrdinal: 1,
        outputPath,
        chunks: Stream.fromIterable(data.chunks),
      })
      const bytes = yield* fs.readFile(path.join(outputPath, 'arrivals.ndjson.gz'))
      expect(bytes).toEqual(new Uint8Array(Buffer.concat(data.chunks.map((chunk) => Buffer.from(chunk.compressed)))))
      expect(gunzipSync(bytes).toString()).toBe(data.records.map((record) => JSON.stringify(record) + '\n').join(''))
      expect(report.recordCount).toBe(data.records.length)
      expect(report.dataSha256).toBe(sha256(bytes))
      expect(report.sourceReceiptSha256).toBe(
        sha256(yield* fs.readFileString(path.join(outputPath, 'source-receipt.json'))),
      )
      expect(Number((yield* fs.stat(outputPath)).mode) & 0o777).toBe(0o700)
      expect(Number((yield* fs.stat(path.join(outputPath, 'source-receipt.json'))).mode) & 0o777).toBe(0o600)
      const retry = yield* exportNativeArrivalPrefix({
        ...data,
        throughOrdinal: 1,
        outputPath,
        chunks: Stream.fromIterable(data.chunks),
      }).pipe(Effect.result)
      expect(Result.isFailure(retry)).toBe(true)
      expect(report.sourceReceiptSha256).toBe(
        sha256(yield* fs.readFileString(path.join(outputPath, 'source-receipt.json'))),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test.each([
  'missing-first',
  'missing-last',
  'wrong-epoch',
  'altered-bytes',
  'reversed',
  'unreproducible-disposition',
  'failed-read',
  'defect',
] as const)('failed export publishes no usable receipt: %s', async (failure) => {
  const data = fixture()
  const first = data.chunks[0]
  const second = data.chunks[1]
  if (first === undefined || second === undefined) throw new Error('Fixture chunks are absent')
  let chunks = data.chunks
  if (failure === 'missing-first') chunks = [second]
  if (failure === 'missing-last') chunks = [first]
  if (failure === 'wrong-epoch') chunks = [{ ...first, header: { ...first.header, captureId: '0'.repeat(64) } }, second]
  if (failure === 'altered-bytes') chunks = [{ ...first, compressed: Uint8Array.of(0) }, second]
  if (failure === 'reversed') chunks = [second, first]
  if (failure === 'unreproducible-disposition') {
    const records = data.records.map((record) => ({
      ...record,
      receipt: { ...record.receipt, projectionSequence: 9_000_000 },
    }))
    chunks = [Result.getOrThrow(makeNativeArrivalChunk(data.epoch, 0, null, records))]
  }
  const stream =
    failure === 'failed-read'
      ? Stream.concat(Stream.make(first), Stream.fail(new ReplaySourceFailure({ message: 'Interrupted archive read' })))
      : failure === 'defect'
        ? Stream.die('archive defect')
        : Stream.fromIterable(chunks)
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const outputPath = path.join(root, 'export')
      const exit = yield* exportNativeArrivalPrefix({
        epoch: data.epoch,
        throughOrdinal: failure === 'unreproducible-disposition' ? 0 : 1,
        chunks: stream,
        outputPath,
      }).pipe(Effect.exit)
      expect(exit._tag).toBe('Failure')
      expect(yield* fs.exists(path.join(outputPath, 'source-receipt.json'))).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('interruption closes the chunk stream and publishes no receipt', async () => {
  const data = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const outputPath = path.join(root, 'export')
      const started = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      const stream = Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))).pipe(
        Stream.ensuring(Deferred.succeed(closed, undefined)),
      )
      const fiber = yield* exportNativeArrivalPrefix({
        epoch: data.epoch,
        throughOrdinal: 1,
        chunks: stream,
        outputPath,
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag === 'Failure' && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Deferred.await(closed)
      expect(yield* fs.exists(path.join(outputPath, 'source-receipt.json'))).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('CLI requires an explicit immutable consumer prefix and a new output directory', () => {
  const args = ['--capture-id', '1'.repeat(64), '--through-ordinal', '12', '--output', '/private/export']
  expect(Result.getOrThrow(parseNativeArrivalExportArgs(args))).toMatchObject({ _tag: 'Export', throughOrdinal: 12 })
  for (const bad of ['', '-1', '1.5', '01', '9007199254740992', 'Infinity'])
    expect(Result.isFailure(parseNativeArrivalExportArgs([...args.slice(0, 3), bad, ...args.slice(4)]))).toBe(true)
  expect(Result.isFailure(parseNativeArrivalExportArgs(args.slice(0, 4)))).toBe(true)
  expect(Result.getOrThrow(parseNativeArrivalExportArgs(['--help']))).toEqual({ _tag: 'Help' })
})

test('the CLI reports the actionable failure alongside its incomplete-export warning', async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/../native-arrival-export-command.ts`, '--invalid'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).toBe(1)
  expect(stdout).toBe('')
  expect(stderr).toContain('Usage: bayn-native-arrival-export')
  expect(stderr).toContain('without source-receipt.json is incomplete')
})

test('an invalid archive URL remains diagnosable without exposing its credential', async () => {
  const secret = 'synthetic-password-never-log'
  const child = Bun.spawn(
    [
      process.execPath,
      `${import.meta.dir}/../native-arrival-export-command.ts`,
      '--capture-id',
      '1'.repeat(64),
      '--through-ordinal',
      '0',
      '--output',
      '/synthetic-unused-export',
    ],
    {
      env: {
        ...process.env,
        BAYN_POSTGRES_URL: `postgresql://fixture:${secret}@[invalid`,
        BAYN_POSTGRES_TLS: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).toBe(1)
  expect(stdout).toBe('')
  expect(stderr).toContain('invalid PostgreSQL connection URL')
  expect(stderr).not.toContain(secret)
})
