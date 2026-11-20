import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, PlatformError, Sink, Stdio, Stream } from 'effect'
import { ChildProcessSpawner } from 'effect/process'

import { runForwardPerformanceWithinDeadline } from './forward-performance-deadline'

const node = Bun.which('node')
if (node === null) throw new Error('Native Node is required for forward-performance deadline subprocess tests')

const captureFailure = () =>
  PlatformError.systemError({
    _tag: 'PermissionDenied',
    module: 'FileSystem',
    method: 'write',
    description: 'injected private capture failure',
  })

const exercise = (
  source: string,
  options: {
    readonly deadlineMs?: number
    readonly executable?: string
    readonly failCapture?: boolean
    readonly failCleanup?: boolean
    readonly cleanupDelayMs?: number
    readonly interruptAfterCapture?: boolean
    readonly publicationDelayMs?: number
  } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-deadline-test-' })
      const captured = yield* Deferred.make<void>()
      const directories: string[] = []
      const directoryModes: number[] = []
      const fileModes: number[] = []
      const children: ChildProcessSpawner.ChildProcessHandle[] = []
      const chunks: Uint8Array[] = []
      let publishedBeforeCleanup = false
      let removalAttempts = 0
      const filesystem: FileSystem.FileSystem = {
        ...fs,
        makeTempDirectory: (settings) =>
          fs.makeTempDirectory({ ...settings, directory }).pipe(
            Effect.tap((path) =>
              Effect.sync(() => {
                directories.push(path)
              }),
            ),
          ),
        open: (path, settings) =>
          Effect.gen(function* () {
            const file = yield* fs.open(path, settings)
            fileModes.push((yield* file.stat).mode & 0o777)
            for (const path of directories) directoryModes.push((yield* fs.stat(path)).mode & 0o777)
            return {
              ...file,
              seek: (offset: bigint, from: FileSystem.SeekMode) => file.seek(offset, from),
              readAlloc: (size: number) => file.readAlloc(size),
              writeAll: (chunk: Uint8Array) =>
                options.failCapture === true
                  ? Effect.fail(captureFailure())
                  : file.writeAll(chunk).pipe(Effect.tap(() => Deferred.succeed(captured, undefined))),
            }
          }),
        remove: (path, settings) => {
          removalAttempts += 1
          if (options.cleanupDelayMs !== undefined && removalAttempts === 1)
            return Effect.sleep(options.cleanupDelayMs).pipe(Effect.andThen(fs.remove(path, settings)))
          return options.failCleanup === true && removalAttempts === 1
            ? Effect.fail(captureFailure())
            : fs.remove(path, settings)
        },
      }
      const observedSpawner = ChildProcessSpawner.make((command) =>
        spawner.spawn(command).pipe(
          Effect.tap((child) =>
            Effect.sync(() => {
              children.push(child)
            }),
          ),
        ),
      )
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.empty,
        stderr: () => Sink.drain,
        stdout: () =>
          Sink.forEach((chunk) =>
            Effect.gen(function* () {
              for (const path of directories) publishedBeforeCleanup ||= yield* fs.exists(path)
              for (const child of children) publishedBeforeCleanup ||= yield* child.isRunning
              if (options.publicationDelayMs !== undefined) yield* Effect.sleep(options.publicationDelayMs)
              chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk.slice())
            }),
          ),
      })
      const run = runForwardPerformanceWithinDeadline(
        options.executable ?? node,
        ['--input-type=module', '-e', source, directory],
        options.deadlineMs ?? 3_000,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, filesystem),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
        Effect.provideService(Stdio.Stdio, stdio),
      )
      const exit = yield* options.interruptAfterCapture === true
        ? Effect.gen(function* () {
            const fiber = yield* run.pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(captured)
            yield* Fiber.interrupt(fiber)
            return yield* Fiber.await(fiber)
          })
        : Effect.exit(run)
      const remaining = yield* Effect.all(directories.map((path) => fs.exists(path)))
      const running = yield* Effect.all(children.map((child) => child.isRunning))
      const marker = `${directory}/terminated`
      return {
        exit,
        failure: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : null,
        output: Buffer.concat(chunks),
        remaining,
        running,
        pids: children.map((child) => Number(child.pid)),
        directoryModes,
        fileModes,
        publishedBeforeCleanup,
        terminations: (yield* fs.exists(marker)) ? yield* fs.readFileString(marker) : '',
        enteredBusyLoop: yield* fs.exists(`${directory}/busy-loop`),
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout('10 seconds')),
  )

const partialUntilTerminated = `
import { appendFileSync } from 'node:fs';
process.on('SIGTERM', () => {
  appendFileSync(process.argv[1] + '/terminated', 'TERM\\n');
  process.exit(0);
});
process.stdout.write('{"partial":');
setInterval(() => {}, 1000);
`

test('publishes exact multi-chunk UTF-8 report bytes only after successful exit and private cleanup', async () => {
  const output = JSON.stringify({ text: 'é🔬'.repeat(18_000), value: 0.0000001 }) + '\n'
  const result = await exercise(`
process.stdout.write(JSON.stringify({ text: 'é🔬'.repeat(18000), value: 0.0000001 }) + '\\n');
setTimeout(() => {}, 30);
`)
  expect(result.failure).toBeNull()
  expect(result.output).toEqual(Buffer.from(output))
  expect(result.publishedBeforeCleanup).toBe(false)
  expect(result.directoryModes).toEqual([0o700])
  expect(result.fileModes).toEqual([0o600])
  expect(result.remaining).toEqual([false])
  expect(result.running).toEqual([false])
})

test('discards all captured bytes when the worker exits unsuccessfully', async () => {
  const result = await exercise(`process.stdout.write('{"complete":true}\\n'); process.exitCode = 7;`)
  expect(result.exit._tag).toBe('Failure')
  expect(JSON.stringify(result.exit)).toContain('ForwardPerformanceWorkerFailed')
  expect(JSON.stringify(result.exit)).toContain('"exitCode":7')
  expect(result.output.length).toBe(0)
  expect(result.remaining).toEqual([false])
  expect(result.running).toEqual([false])
})

test('kills and reaps CPU-bound work whose event loop cannot process TERM, without publishing a prefix', async () => {
  const result = await exercise(
    `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
process.stdout.write('{"partial":', () => {
  writeFileSync(process.argv[1] + '/busy-loop', 'entered');
  while (true) {}
});
`,
    { deadlineMs: 1_000 },
  )
  expect(result.exit._tag).toBe('Failure')
  expect(JSON.stringify(result.exit)).toContain('ForwardPerformanceDeadlineExceeded')
  expect(result.pids).toHaveLength(1)
  expect(result.enteredBusyLoop).toBe(true)
  for (const pid of result.pids) expect(() => process.kill(pid, 0)).toThrow()
  expect(result.output.length).toBe(0)
  expect(result.remaining).toEqual([false])
  expect(result.running).toEqual([false])
}, 15_000)

test('deadline cancellation waits for cooperative cleanup but rejects a zero exit after expiry', async () => {
  const result = await exercise(partialUntilTerminated, { deadlineMs: 1_000 })
  expect(result.exit._tag).toBe('Failure')
  expect(JSON.stringify(result.exit)).toContain('ForwardPerformanceDeadlineExceeded')
  expect(result.terminations).toBe('TERM\n')
  expect(result.output.length).toBe(0)
  expect(result.remaining).toEqual([false])
  expect(result.running).toEqual([false])
}, 15_000)

test('parent interruption cancels the worker once and removes its partial capture', async () => {
  const result = await exercise(partialUntilTerminated, { deadlineMs: 5_000, interruptAfterCapture: true })
  expect(result.exit._tag).toBe('Failure')
  expect(result.terminations).toBe('TERM\n')
  expect(result.output.length).toBe(0)
  expect(result.remaining).toEqual([false])
  expect(result.running).toEqual([false])
}, 15_000)

test('spawn failure cleans the private capture without report output', async () => {
  const result = await exercise('', { executable: '/bayn-deadline-test-no-such-executable' })
  expect(result.exit._tag).toBe('Failure')
  expect(result.output.length).toBe(0)
  expect(result.pids).toEqual([])
  expect(result.remaining).toEqual([false])
})

test('capture failure stops the worker and discards captured output', async () => {
  const result = await exercise(partialUntilTerminated, { failCapture: true })
  expect(result.exit._tag).toBe('Failure')
  expect(JSON.stringify(result.exit)).toContain('injected private capture failure')
  expect(result.terminations).toBe('TERM\n')
  expect(result.output.length).toBe(0)
  expect(result.remaining).toEqual([false])
  expect(result.running).toEqual([false])
}, 15_000)

test('failure to remove named capture data prevents successful stdout publication', async () => {
  const result = await exercise(`process.stdout.write('{"complete":true}\\n');`, { failCleanup: true })
  expect(result.exit._tag).toBe('Failure')
  expect(JSON.stringify(result.exit)).toContain('injected private capture failure')
  expect(result.output.length).toBe(0)
  expect(result.remaining).toEqual([false])
  expect(result.running).toEqual([false])
})

test('successful stdout backpressure is outside the execution and capture budget', async () => {
  const result = await exercise(`process.stdout.write('{"complete":true}\\n');`, {
    deadlineMs: 1_000,
    publicationDelayMs: 1_500,
  })
  expect(result.failure).toBeNull()
  expect(result.output.toString()).toBe('{"complete":true}\n')
  expect(result.publishedBeforeCleanup).toBe(false)
  expect(result.remaining).toEqual([false])
})

test('expiry during capture cleanup still discards a successful worker result', async () => {
  const result = await exercise(`process.stdout.write('{"complete":true}\\n');`, {
    deadlineMs: 1_000,
    cleanupDelayMs: 1_500,
  })
  expect(result.exit._tag).toBe('Failure')
  expect(JSON.stringify(result.exit)).toContain('ForwardPerformanceDeadlineExceeded')
  expect(result.output.length).toBe(0)
  expect(result.remaining).toEqual([false])
  expect(result.running).toEqual([false])
})
