import { expect, spyOn, test } from 'bun:test'
import * as NodeCrypto from 'node:crypto'

import { NodeServices } from '@effect/platform-node'
import { Cause, Deferred, Effect, Exit, FileSystem, Fiber, Logger, PlatformError, Result, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'

import {
  MainTaskState,
  MainTaskSyscallState,
  MainTaskWaitChannel,
  UnavailableReason,
  nativeProcessCaptureLimits,
  observeNativeStartupFailure,
  parseNativeProcessIo,
  parseNativeProcessScheduler,
  parseNativeProcessStat,
  parseNativeProcessStatus,
  parseNativeProcessSyscall,
  parseNativeProcessWaitChannel,
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
const waitChannel = 'io_schedule\n'
const syscall = '0 0x0 0xfeedface 0x0 0x0 0x0 0x0 0xdeadbeef 0xcafebabe\n'
const contents = { stat: stat(), io, status, schedstat: scheduler, wchan: waitChannel, syscall }
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

const fixture = (replacement: Partial<FileSystem.FileSystem> = {}, contentOverrides: Partial<typeof contents> = {}) => {
  const reads: { path: string; bytesToRead: unknown; chunkSize: number | undefined }[] = []
  const events: unknown[] = []
  const procFiles = { ...contents, ...contentOverrides }
  const fileSystem = FileSystem.makeNoop({
    stream: (path, options) => {
      reads.push({ path, bytesToRead: options?.bytesToRead, chunkSize: options?.chunkSize })
      const file = path.split('/').at(-1)
      const text =
        file === 'stat' ||
        file === 'io' ||
        file === 'status' ||
        file === 'schedstat' ||
        file === 'wchan' ||
        file === 'syscall'
          ? procFiles[file]
          : ''
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

test.each(['available', 'fingerprinted', 'invalid'] as const)(
  'default logger and Bun console preserve every allowlisted diagnostic leaf: %s',
  async (mode) => {
    const files = {
      ...contents,
      stat: stat({ pid: 0, parent: 0 }),
      schedstat: mode === 'available' ? scheduler : '',
      wchan:
        mode === 'available'
          ? waitChannel
          : mode === 'fingerprinted'
            ? 'private_wait_channel\n'
            : 'private_wait_channel+0x20/0x40 [private_module]\n',
      syscall: mode === 'available' ? syscall : 'running 0xfeedface\n',
    }
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
    expect(output.stdout).not.toMatch(/private|credential-value|\/proc\/|0x|feedface|deadbeef|cafebabe/)
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
          mainTaskWaitChannel:
            mode === 'available'
              ? { availability: 'AVAILABLE', value: MainTaskWaitChannel.IoSchedule }
              : mode === 'fingerprinted'
                ? {
                    availability: 'UNAVAILABLE',
                    reason: 'UNRECOGNIZED_WAIT_CHANNEL',
                    fingerprint: {
                      domain: 'bayn.opencode-native-wchan-symbol.v1',
                      sha256: 'e5c886491fb18da4d6b03753ac82ffe714a22ab3f5d78901db40146276cb12f6',
                    },
                  }
                : { availability: 'UNAVAILABLE', reason: 'UNRECOGNIZED_WAIT_CHANNEL' },
          mainTaskSyscall:
            mode === 'available'
              ? { availability: 'AVAILABLE', value: { state: MainTaskSyscallState.InSyscall, number: 0 } }
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

test('wait-channel parser exposes only fixed symbols and leaves zero explicitly ambiguous', () => {
  for (const symbol of Object.values(MainTaskWaitChannel))
    expect(parseNativeProcessWaitChannel(`${symbol}\n`)).toEqual(Result.succeed(symbol))
  expect(parseNativeProcessWaitChannel('0\n')).toEqual(Result.fail(UnavailableReason.ZeroWaitChannel))
})

test.each(['', ' ', 'private_wait_channel', '0xfeedface', 'io_schedule private', 'io_schedule\0'])(
  'unrecognized wait-channel content never escapes the fixed result: case %#',
  (text) => {
    expect(parseNativeProcessWaitChannel(text)).toEqual(Result.fail(UnavailableReason.UnrecognizedWaitChannel))
  },
)

test('syscall parser distinguishes running and blocked outside a syscall without retaining registers', () => {
  expect(parseNativeProcessSyscall('running\n')).toEqual(Result.succeed({ state: MainTaskSyscallState.Running }))
  expect(parseNativeProcessSyscall('-1 0xdeadbeef 0xcafebabe\n')).toEqual(
    Result.succeed({ state: MainTaskSyscallState.NotInSyscall }),
  )
})

test.each(['0', '202', '2147483647'])(
  'syscall parser retains valid signed-int syscall number %s and discards every register',
  (number) => {
    expect(
      parseNativeProcessSyscall(`${number} 0x0 0xfeedface 0x0 0x0 0x0 0x0 0xffffffffffffffff 0xcafebabe\n`),
    ).toEqual(Result.succeed({ state: MainTaskSyscallState.InSyscall, number: Number(number) }))
  },
)

test.each([
  '',
  'running 0xfeedface',
  '-1',
  '-1 0x0 0x0 0x0',
  syscall.trim().split(' ').slice(0, -1).join(' '),
  `${syscall.trim()} 0x0`,
  ...['-2', '0x0', '1.5', '+1', '2147483648', String(2 ** 53)].map((number) => syscall.replace(/^0 /, `${number} `)),
  ...['private-register', '0', '0x', '0x10000000000000000'].map((register) => syscall.replace('0xfeedface', register)),
])('malformed syscall input fails closed without leaking arguments or registers: case %#', (text) => {
  expect(parseNativeProcessSyscall(text)).toEqual(Result.fail(UnavailableReason.InvalidContent))
})

test('stable owned child emits seven bounded allowlisted reads and preserves the original failure', async () => {
  const f = fixture()
  expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
  expect(nativeProcessCaptureLimits).toEqual({
    captureBudgetMs: 200,
    observationBudgetMs: 250,
    maximumFileBytes: 4096,
    maximumFileReads: 7,
  })
  expect(f.reads).toEqual(
    ['stat', 'io', 'status', 'schedstat', 'wchan', 'syscall', 'stat'].map((file) => ({
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
          mainTaskWaitChannel: { availability: 'AVAILABLE', value: MainTaskWaitChannel.IoSchedule },
          mainTaskSyscall: { availability: 'AVAILABLE', value: { state: MainTaskSyscallState.InSyscall, number: 0 } },
        }),
      },
    }),
  ])
  for (const secret of [
    'private',
    'credential-value',
    '/proc/',
    '/private/',
    'original native readiness failure',
    '0x',
  ])
    expect(JSON.stringify(f.events)).not.toContain(secret)
})

test('successful readiness performs no diagnostic reads, hashing or logging', async () => {
  const f = fixture({}, { wchan: 'private_wait_channel' })
  const hashing = spyOn(NodeCrypto, 'createHash')
  try {
    await Effect.runPromise(f.provide(observeNativeStartupFailure(Exit.succeed(undefined), 'initial', child)))
    expect(f.reads).toEqual([])
    expect(f.events).toEqual([])
    expect(hashing).not.toHaveBeenCalled()
  } finally {
    hashing.mockRestore()
  }
})

// Fixed vectors were independently computed with Python hashlib over UTF-8 domain + NUL + trimmed symbol.
test.each([
  ['private_wait_channel', 'e5c886491fb18da4d6b03753ac82ffe714a22ab3f5d78901db40146276cb12f6'],
  ['unlisted_kernel_wait', 'ce4d509c4a3e5cf47f2c6bbb281feba88b34850142d6b65984d19a97d26a4848'],
] as const)('unknown wait-channel %s retains only its independent golden fingerprint', async (symbol, sha256) => {
  const f = fixture({}, { wchan: ` \t${symbol}\n` })
  expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
  expect(f.reads).toHaveLength(7)
  expect(f.events).toEqual([
    expect.objectContaining({
      snapshot: {
        availability: 'AVAILABLE',
        value: expect.objectContaining({
          mainTaskWaitChannel: {
            availability: 'UNAVAILABLE',
            reason: 'UNRECOGNIZED_WAIT_CHANNEL',
            fingerprint: { domain: 'bayn.opencode-native-wchan-symbol.v1', sha256 },
          },
        }),
      },
    }),
  ])
  expect(JSON.stringify(f.events)).not.toContain(symbol)
})

test.each(['g', 'g'.repeat(128)])(
  'fingerprint eligibility accepts the bounded identifier length: case %#',
  async (symbol) => {
    const f = fixture({}, { wchan: symbol })
    expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
    expect(f.events).toEqual([
      expect.objectContaining({
        snapshot: {
          availability: 'AVAILABLE',
          value: expect.objectContaining({
            mainTaskWaitChannel: {
              availability: 'UNAVAILABLE',
              reason: 'UNRECOGNIZED_WAIT_CHANNEL',
              fingerprint: {
                domain: 'bayn.opencode-native-wchan-symbol.v1',
                sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              },
            },
          }),
        },
      }),
    ])
  },
)

test.each([
  ...Object.values(MainTaskWaitChannel),
  '',
  '0',
  'deadbeef',
  'DEAD_BEEF',
  '__0xdeadbeef',
  '_0x',
  '_0xprivate_wait',
  '__0XBADADDR',
  '___',
  'NULL',
  'nil',
  'none',
  'unknown',
  'unavailable',
  'ptrval',
  'RUNNING',
  'invalid',
  'error',
  '(ptrval)',
  'wait_for_completion+0x10/0x30',
  'wait_for_completion.isra.0',
  'wait_for_completion [private_module]',
  '/private/wait',
  'private wait',
  'private\nwait',
  'private\0wait',
  'private-wait',
  'privaté_wait',
  'g'.repeat(129),
])('known, zero, invalid, address-like and placeholder wait-channel inputs never hash: case %#', async (text) => {
  const f = fixture({}, { wchan: text })
  const hashing = spyOn(NodeCrypto, 'createHash')
  try {
    expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
    const expected = Result.match(parseNativeProcessWaitChannel(text), {
      onSuccess: (value) => ({ availability: 'AVAILABLE', value }),
      onFailure: (reason) => ({ availability: 'UNAVAILABLE', reason }),
    })
    expect(f.events).toEqual([
      expect.objectContaining({
        snapshot: {
          availability: 'AVAILABLE',
          value: expect.objectContaining({ mainTaskWaitChannel: expected }),
        },
      }),
    ])
    expect(hashing).not.toHaveBeenCalled()
    expect(JSON.stringify(f.events)).not.toMatch(/fingerprint|private|ptrval|0x/)
  } finally {
    hashing.mockRestore()
  }
})

test('a throwing wait-channel hash implementation cannot replace or append to the original failure', async () => {
  const f = fixture({}, { wchan: 'private_wait_channel' })
  const hashing = spyOn(NodeCrypto, 'createHash').mockImplementation(() => {
    throw new Error('/private/hash-credential-value')
  })
  try {
    expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
    expect(hashing).toHaveBeenCalledTimes(1)
    expect(f.events).toEqual([
      expect.objectContaining({ snapshot: { availability: 'UNAVAILABLE', reason: 'CAPTURE_FAILED' } }),
    ])
    expect(JSON.stringify(f.events)).not.toMatch(/private|credential-value|fingerprint/)
  } finally {
    hashing.mockRestore()
  }
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
      if (path.endsWith('/status'))
        return Stream.fail(
          PlatformError.systemError({
            _tag: 'Unknown',
            module: 'FileSystem',
            method: 'stream',
            pathOrDescriptor: '/private/denied',
          }),
        )
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

test.each(['PermissionDenied', 'NotFound'] as const)(
  'optional wait/syscall %s reads remain unavailable without losing the owned-process snapshot',
  async (tag) => {
    const base = fixture()
    const f = fixture({
      stream: (path, options) => {
        if (path.endsWith('/wchan') || path.endsWith('/syscall'))
          return Stream.fail(
            PlatformError.systemError({
              _tag: tag,
              module: 'FileSystem',
              method: 'stream',
              pathOrDescriptor: '/private/credential-value',
              description: 'private error text',
            }),
          )
        return base.fileSystem.stream(path, options)
      },
    })
    expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
    const missing = { availability: 'UNAVAILABLE', reason: tag === 'PermissionDenied' ? 'READ_DENIED' : 'READ_MISSING' }
    expect(f.events).toEqual([
      expect.objectContaining({
        snapshot: {
          availability: 'AVAILABLE',
          value: expect.objectContaining({
            process: expect.objectContaining({ pid, parentPid: process.pid, startTimeTicks: 123456 }),
            mainTaskScheduler: expect.objectContaining({ availability: 'AVAILABLE' }),
            mainTaskWaitChannel: missing,
            mainTaskSyscall: missing,
          }),
        },
      }),
    ])
    expect(base.reads.map((read) => read.path.split('/').at(-1))).toEqual(['stat', 'io', 'status', 'schedstat', 'stat'])
    expect(JSON.stringify(f.events)).not.toMatch(/private|credential-value|\/proc\//)
  },
)

test.each([
  ['wchan', 'mainTaskWaitChannel'],
  ['syscall', 'mainTaskSyscall'],
] as const)('oversized %s input is rejected before its parser runs', async (file, field) => {
  const base = fixture()
  const f = fixture({
    stream: (path, options) =>
      path.endsWith(`/${file}`) ? Stream.make(new Uint8Array(4097).fill(65)) : base.fileSystem.stream(path, options),
  })
  expect(await Effect.runPromise(f.provide(observe()))).toEqual(original)
  expect(f.events).toEqual([
    expect.objectContaining({
      snapshot: {
        availability: 'AVAILABLE',
        value: expect.objectContaining({ [field]: { availability: 'UNAVAILABLE', reason: 'READ_LIMIT' } }),
      },
    }),
  ])
})

test.each(['stat', 'wchan', 'syscall'] as const)(
  'a never-completing %s reader is interrupted and finalized once inside the uninterruptible onExit hook',
  async (blockedFile) => {
    let finalized = 0
    const events: unknown[] = []
    const reads: string[] = []
    const base = fixture({}, { wchan: 'private_wait_channel' })
    const program = Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const fs = FileSystem.makeNoop({
        stream: (path, options) => {
          const file = path.split('/').at(-1) ?? ''
          reads.push(file)
          if (file !== blockedFile) return base.fileSystem.stream(path, options)
          return Stream.fromEffect(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                finalized += 1
              }),
            ),
          )
        },
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
    const sequence = ['stat', 'io', 'status', 'schedstat', 'wchan', 'syscall']
    expect(reads).toEqual(sequence.slice(0, sequence.indexOf(blockedFile) + 1))
    expect(events).toEqual([
      expect.objectContaining({
        captureElapsedMs: 200,
        snapshot: { availability: 'UNAVAILABLE', reason: 'CAPTURE_TIMEOUT' },
      }),
    ])
  },
)

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
