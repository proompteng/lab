import { expect, spyOn, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { Cause, Deferred, Effect, Exit, FileSystem, Fiber, Logger, Result, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'

import {
  MainTaskState,
  UnavailableReason,
  nativeProcessCaptureLimits,
  observeNativeStartupFailure,
  parseNativeProcessIo,
  parseNativeProcessScheduler,
  parseNativeProcessStat,
  parseNativeProcessStatus,
} from '../../tools/test-native-process-diagnostics'

const pid = ChildProcessSpawner.ProcessId(process.pid + 10000)
const child = { pid, isRunning: Effect.succeed(true) }
const stat = (overrides: { pid?: number; parent?: number; start?: number; state?: string; comm?: string } = {}) => {
  const fields = Array<string>(50).fill('0')
  fields[0] = overrides.state ?? 'S'
  fields[1] = String(overrides.parent ?? process.pid)
  fields[7] = '10'
  fields[9] = '2'
  fields[11] = '300'
  fields[12] = '40'
  fields[17] = '4'
  fields[19] = String(overrides.start ?? 123456)
  fields[20] = '1000000'
  fields[21] = '30'
  return `${overrides.pid ?? pid} (${overrides.comm ?? 'private ) command\n'}) ${fields.join(' ')}\n`
}
const io = 'rchar: 101\nwchar: 102\nsyscr: 3\nsyscw: 4\nread_bytes: 0\nwrite_bytes: 4096\ncancelled_write_bytes: 2048\n'
const status =
  'Name: private-command\nEnv: credential-value\nPath: /private/file\nVmRSS: 120 kB\nVmHWM: 140 kB\nThreads: 4\nvoluntary_ctxt_switches: 8\nnonvoluntary_ctxt_switches: 9\n'
const scheduler = '30000000 12000000 8\n'
const contents = { stat: stat(), io, status, schedstat: scheduler }
const originalCause = Cause.fail(new Error('original native readiness failure'))
const original = Exit.failCause(originalCause)
const observe = (handle = child) =>
  Effect.failCause(originalCause).pipe(
    Effect.onExit((exit) => observeNativeStartupFailure(exit, 'initial', handle)),
    Effect.exit,
  )

const collectEvents = (events: unknown[], message: unknown) => {
  const messages: readonly unknown[] = Array.isArray(message) ? message : [message]
  for (const entry of messages) {
    if (typeof entry !== 'string') throw new Error('Expected a serialized diagnostic')
    const decoded: unknown = JSON.parse(entry)
    events.push(decoded)
  }
}

const fixture = (replacement: Partial<FileSystem.FileSystem> = {}) => {
  const reads: { path: string; bytesToRead: unknown; chunkSize: number | undefined }[] = []
  const events: unknown[] = []
  const fileSystem = FileSystem.makeNoop({
    stream: (path, options) => {
      reads.push({ path, bytesToRead: options?.bytesToRead, chunkSize: options?.chunkSize })
      const file = path.split('/').at(-1)
      const text = file === 'stat' || file === 'io' || file === 'status' || file === 'schedstat' ? contents[file] : ''
      return Stream.make(new TextEncoder().encode(text))
    },
    ...replacement,
  })
  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provide(Logger.layer([Logger.make(({ message }) => collectEvents(events, message))])),
    )
  return { reads, events, fileSystem, provide }
}

test.each(['available', 'unavailable'] as const)(
  'default logger and Bun console preserve every allowlisted diagnostic leaf: %s',
  async (mode) => {
    const files = { ...contents, stat: stat({ pid: 0, parent: 0 }), schedstat: mode === 'available' ? scheduler : '' }
    const program = `
      import { Effect, Exit, FileSystem, Stream } from 'effect'
      import { ChildProcessSpawner } from 'effect/process'
      import { observeNativeStartupFailure } from ${JSON.stringify(new URL('../../tools/test-native-process-diagnostics.ts', import.meta.url).href)}
      const pid = ChildProcessSpawner.ProcessId(process.pid + 10000)
      const files = ${JSON.stringify(files)}
      files.stat = files.stat.replace(/^0 /, pid + ' ').replace(') S 0 ', ') S ' + process.pid + ' ')
      const fs = FileSystem.makeNoop({
        stream: (path) => Stream.make(new TextEncoder().encode(files[path.split('/').at(-1)] ?? '')),
      })
      await Effect.runPromise(observeNativeStartupFailure(Exit.fail('original failure'), 'initial', {
        pid, isRunning: Effect.succeed(true),
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs)))
    `
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const handle = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ['--eval', program], { cwd: import.meta.dir }),
        )
        return yield* Effect.all(
          {
            stdout: handle.stdout.pipe(
              Stream.decodeText(),
              Stream.runCollect,
              Effect.map((chunks) => chunks.join('')),
            ),
            stderr: handle.stderr.pipe(
              Stream.decodeText(),
              Stream.runCollect,
              Effect.map((chunks) => chunks.join('')),
            ),
            exitCode: handle.exitCode,
          },
          { concurrency: 'unbounded' },
        )
      }).pipe(Effect.timeout('3 seconds'), Effect.scoped, Effect.provide(NodeServices.layer)),
    )
    expect(output.exitCode).toBe(ChildProcessSpawner.ExitCode(0))
    expect(output.stderr).toBe('')
    expect(output.stdout).not.toContain('[Object')
    expect(output.stdout).not.toMatch(/private|credential-value|\/proc\//)
    const lines = output.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    const line = lines[0] ?? ''
    const record: unknown = JSON.parse(line.slice(line.indexOf('{')))
    expect(record).toEqual({
      event: 'bayn.opencode-native-process-failure-test.v1',
      phase: 'initial',
      beforeOuterScopeCleanup: true,
      captureElapsedMs: expect.any(Number),
      limits: nativeProcessCaptureLimits,
      snapshot: {
        availability: 'AVAILABLE',
        value: {
          process: {
            ...Result.getOrThrow(parseNativeProcessStat(stat())),
            pid: expect.any(Number),
            parentPid: expect.any(Number),
          },
          processAndWaitedChildrenIo: { availability: 'AVAILABLE', value: Result.getOrThrow(parseNativeProcessIo(io)) },
          status: { availability: 'AVAILABLE', value: Result.getOrThrow(parseNativeProcessStatus(status)) },
          mainTaskScheduler:
            mode === 'available'
              ? { availability: 'AVAILABLE', value: Result.getOrThrow(parseNativeProcessScheduler(scheduler)) }
              : { availability: 'UNAVAILABLE', reason: 'INVALID_CONTENT' },
        },
      },
    })
  },
)

test('stat parser strips the complete comm and preserves only validated numeric fields and task state', () => {
  const result = parseNativeProcessStat(stat())
  expect(result).toEqual(
    Result.succeed({
      pid,
      parentPid: process.pid,
      mainTaskState: MainTaskState.Sleeping,
      minorFaults: 10,
      majorFaults: 2,
      userCpuTicks: 300,
      systemCpuTicks: 40,
      threadCount: 4,
      startTimeTicks: 123456,
      virtualBytes: 1000000,
      residentPages: 30,
    }),
  )
  expect(JSON.stringify(result)).not.toContain('private')
})

test.each([
  '',
  '12 (private) S 1',
  stat({ state: '?' }),
  stat({ pid: 1.5 }),
  stat({ start: -1 }),
  stat({ start: 2 ** 53 }),
])('stat parser rejects malformed, truncated or unsafe values without retaining raw input: case %#', (input) =>
  expect(parseNativeProcessStat(input)).toEqual(Result.fail(UnavailableReason.InvalidContent)),
)

test('counter parsers allowlist values, distinguish units and preserve actual zero storage reads', () => {
  expect(parseNativeProcessIo(io)).toEqual(
    Result.succeed({
      readCharacters: 101,
      writtenCharacters: 102,
      readSyscalls: 3,
      writeSyscalls: 4,
      storageReadBytes: 0,
      storageWriteBytes: 4096,
      cancelledWriteBytes: 2048,
    }),
  )
  expect(parseNativeProcessStatus(status)).toEqual(
    Result.succeed({
      residentKiB: 120,
      peakResidentKiB: 140,
      threadCount: 4,
      mainTaskVoluntaryContextSwitches: 8,
      mainTaskInvoluntaryContextSwitches: 9,
    }),
  )
  expect(parseNativeProcessScheduler(scheduler)).toEqual(
    Result.succeed({ mainTaskRuntimeNs: 30000000, mainTaskRunQueueDelayNs: 12000000, mainTaskTimeslices: 8 }),
  )
})

test.each([
  ['missing I/O', () => parseNativeProcessIo(io.replace('read_bytes: 0\n', ''))],
  ['duplicate I/O', () => parseNativeProcessIo(`${io}read_bytes: 1\n`)],
  ['negative I/O', () => parseNativeProcessIo(io.replace('rchar: 101', 'rchar: -1'))],
  ['unsafe I/O', () => parseNativeProcessIo(io.replace('rchar: 101', `rchar: ${2 ** 53}`))],
  ['wrong memory units', () => parseNativeProcessStatus(status.replace('120 kB', '120 MB'))],
  ['duplicate memory', () => parseNativeProcessStatus(`${status}VmRSS: 0 kB\n`)],
  ['missing context switches', () => parseNativeProcessStatus(status.replace('voluntary_ctxt_switches: 8\n', ''))],
  ['truncated scheduler', () => parseNativeProcessScheduler('1 2')],
  ['extra scheduler fields', () => parseNativeProcessScheduler('1 2 3 4')],
  ['invalid scheduler', () => parseNativeProcessScheduler('private 2 3')],
])('invalid %s remains unavailable instead of becoming zero', (_name, parse) => {
  expect(parse()).toEqual(Result.fail(UnavailableReason.InvalidContent))
})

test('stable owned child emits five bounded allowlisted reads and preserves the original failure', async () => {
  const f = fixture()
  expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
  expect(f.reads).toEqual(
    ['stat', 'io', 'status', 'schedstat', 'stat'].map((file) => ({
      path: `/proc/${pid}/${file}`,
      bytesToRead: 4097,
      chunkSize: 1024,
    })),
  )
  expect(f.events).toEqual([
    expect.objectContaining({
      event: 'bayn.opencode-native-process-failure-test.v1',
      beforeOuterScopeCleanup: true,
      phase: 'initial',
      limits: nativeProcessCaptureLimits,
      snapshot: {
        availability: 'AVAILABLE',
        value: expect.objectContaining({
          process: expect.objectContaining({ pid, parentPid: process.pid, startTimeTicks: 123456 }),
          processAndWaitedChildrenIo: expect.objectContaining({ availability: 'AVAILABLE' }),
          status: expect.objectContaining({ availability: 'AVAILABLE' }),
          mainTaskScheduler: expect.objectContaining({ availability: 'AVAILABLE' }),
        }),
      },
    }),
  ])
  for (const secret of ['private', 'credential-value', '/proc/', '/private/', 'original native readiness failure'])
    expect(JSON.stringify(f.events)).not.toContain(secret)
})

test('successful readiness performs no diagnostic reads or logging', async () => {
  const f = fixture()
  await Effect.runPromise(f.provide(observeNativeStartupFailure(Exit.succeed(undefined), 'initial', child)))
  expect(f.reads).toEqual([])
  expect(f.events).toEqual([])
})

test.each([
  undefined,
  { ...child, isRunning: Effect.succeed(false) },
  { ...child, pid: ChildProcessSpawner.ProcessId(0) },
])('absent, exited or invalid child is unavailable without reading proc: case %#', async (handle) => {
  const f = fixture()
  await Effect.runPromise(f.provide(observeNativeStartupFailure(original, 'initial', handle)))
  expect(f.reads).toEqual([])
  expect(f.events).toEqual([
    expect.objectContaining({ snapshot: expect.objectContaining({ availability: 'UNAVAILABLE' }) }),
  ])
})

test.each([{ pid: pid + 1 }, { parent: process.pid + 1 }, { state: 'Z' }])(
  'rejects a child identity mismatch before reading counters: %j',
  async (overrides) => {
    let reads = 0
    const f = fixture({
      stream: () => {
        reads += 1
        return Stream.make(new TextEncoder().encode(stat(overrides)))
      },
    })
    expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
    expect(reads).toBe(1)
    expect(f.events).toEqual([
      expect.objectContaining({ snapshot: { availability: 'UNAVAILABLE', reason: 'IDENTITY_CHANGED' } }),
    ])
  },
)

test.each([{ start: 123457 }, { pid: pid + 1 }, { parent: process.pid + 1 }, { state: 'X' }])(
  'discards all counters when final identity changed: %j',
  async (overrides) => {
    const base = fixture()
    let statReads = 0
    const f = fixture({
      stream: (path, options) => {
        if (path.endsWith('/stat') && ++statReads === 2) return Stream.make(new TextEncoder().encode(stat(overrides)))
        return base.fileSystem.stream(path, options)
      },
    })
    expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
    expect(f.events).toEqual([
      expect.objectContaining({ snapshot: { availability: 'UNAVAILABLE', reason: 'IDENTITY_CHANGED' } }),
    ])
  },
)

test('discards counters if the owned handle exits during collection', async () => {
  let checks = 0
  const f = fixture()
  const handle = { ...child, isRunning: Effect.sync(() => ++checks === 1) }
  expect(await Effect.runPromise(f.provide(observe(handle)))).toEqual(original)
  expect(checks).toBe(2)
  expect(f.events).toEqual([
    expect.objectContaining({ snapshot: { availability: 'UNAVAILABLE', reason: 'CHILD_NOT_RUNNING' } }),
  ])
})

test('bounded streams reject oversized input before parsing and retain optional read failures explicitly', async () => {
  const base = fixture()
  const f = fixture({
    stream: (path, options) => {
      if (path.endsWith('/io')) return Stream.make(new Uint8Array(4097).fill(65))
      if (path.endsWith('/status')) return FileSystem.makeNoop({}).stream('/private/denied')
      return base.fileSystem.stream(path, options)
    },
  })
  expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
  expect(f.events).toEqual([
    expect.objectContaining({
      snapshot: {
        availability: 'AVAILABLE',
        value: expect.objectContaining({
          processAndWaitedChildrenIo: { availability: 'UNAVAILABLE', reason: 'READ_LIMIT' },
          status: { availability: 'UNAVAILABLE', reason: 'READ_FAILED' },
        }),
      },
    }),
  ])
  expect(JSON.stringify(f.events)).not.toContain('/private/denied')
})

test('a never-completing proc reader is interrupted and finalized once inside the uninterruptible onExit hook', async () => {
  let finalized = 0
  const events: unknown[] = []
  const program = Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const fs = FileSystem.makeNoop({
      stream: () =>
        Stream.fromEffect(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              finalized += 1
            }),
          ),
        ),
    })
    const fiber = yield* observe().pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* TestClock.adjust(nativeProcessCaptureLimits.captureBudgetMs)
    expect(yield* Fiber.join(fiber)).toEqual(original)
    expect(finalized).toBe(1)
  }).pipe(
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.provide(Logger.layer([Logger.make(({ message }) => collectEvents(events, message))])),
  )
  await Effect.runPromise(program)
  expect(events).toEqual([
    expect.objectContaining({
      captureElapsedMs: 200,
      snapshot: { availability: 'UNAVAILABLE', reason: 'CAPTURE_TIMEOUT' },
    }),
  ])
})

test.each(['reader', 'logger'])('a throwing %s cannot replace or append to the original failure', async (kind) => {
  const f = fixture(
    kind === 'reader'
      ? {
          stream: () => {
            throw new Error('/private/credential-value')
          },
        }
      : {},
  )
  let loggerCalls = 0
  const result = await Effect.runPromise(
    kind === 'logger'
      ? observe().pipe(
          Effect.provideService(FileSystem.FileSystem, f.fileSystem),
          Effect.provide(
            Logger.layer([
              Logger.make(() => {
                loggerCalls += 1
                throw new Error('/private/credential-value')
              }),
            ]),
          ),
        )
      : f.provide(observe()),
  )
  expect(result).toEqual(original)
  if (kind === 'logger') expect(loggerCalls).toBe(1)
  expect(JSON.stringify(f.events)).not.toContain('credential-value')
})

test('a serialization defect cannot replace or append to the original failure', async () => {
  const f = fixture()
  const stringify = JSON.stringify
  let serializationCalls = 0
  const serialization = spyOn(JSON, 'stringify').mockImplementation(
    (
      value: unknown,
      replacer?: ((key: string, value: unknown) => unknown) | (string | number)[] | null,
      space?: string | number,
    ) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        'event' in value &&
        value.event === 'bayn.opencode-native-process-failure-test.v1'
      ) {
        serializationCalls += 1
        throw new Error('/private/credential-value')
      }
      return typeof replacer === 'function' ? stringify(value, replacer, space) : stringify(value, replacer, space)
    },
  )
  try {
    expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
    expect(serializationCalls).toBe(1)
    expect(f.events).toEqual([])
  } finally {
    serialization.mockRestore()
  }
})

test('an original defect and interruption retain their exact causes', async () => {
  const interrupted = await Effect.runPromise(Effect.interrupt.pipe(Effect.exit))
  if (Exit.isSuccess(interrupted)) throw new Error('Expected interruption')
  for (const cause of [Cause.die('original defect'), interrupted.cause]) {
    const f = fixture()
    const result = await Effect.runPromise(
      f.provide(
        Effect.failCause(cause).pipe(
          Effect.onExit((exit) => observeNativeStartupFailure(exit, 'restart', child)),
          Effect.exit,
        ),
      ),
    )
    expect(result).toEqual(Exit.failCause(cause))
  }
})
