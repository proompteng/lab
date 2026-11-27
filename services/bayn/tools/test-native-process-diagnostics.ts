import * as NodeCrypto from 'node:crypto'

import { Clock, Effect, Exit, FileSystem, Option, Result, Schema, Stream } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'

export const nativeProcessCaptureLimits = {
  captureBudgetMs: 200,
  observationBudgetMs: 250,
  maximumFileBytes: 4096,
  maximumFileReads: 7,
} as const

export enum UnavailableReason {
  UnsupportedPlatform = 'UNSUPPORTED_PLATFORM',
  NoChild = 'NO_CHILD',
  ChildNotRunning = 'CHILD_NOT_RUNNING',
  IdentityChanged = 'IDENTITY_CHANGED',
  ReadFailed = 'READ_FAILED',
  ReadDenied = 'READ_DENIED',
  ReadMissing = 'READ_MISSING',
  ReadLimit = 'READ_LIMIT',
  InvalidContent = 'INVALID_CONTENT',
  ZeroWaitChannel = 'ZERO_WAIT_CHANNEL',
  UnrecognizedWaitChannel = 'UNRECOGNIZED_WAIT_CHANNEL',
  CaptureTimeout = 'CAPTURE_TIMEOUT',
  CaptureFailed = 'CAPTURE_FAILED',
}

export enum MainTaskState {
  Running = 'R',
  Sleeping = 'S',
  Uninterruptible = 'D',
  Zombie = 'Z',
  Stopped = 'T',
  Tracing = 't',
  Dead = 'X',
  DeadLegacy = 'x',
  Wakekill = 'K',
  Waking = 'W',
  Parked = 'P',
  Idle = 'I',
}

export enum MainTaskWaitChannel {
  IoSchedule = 'io_schedule',
  IoScheduleTimeout = 'io_schedule_timeout',
  FolioWaitBit = 'folio_wait_bit_common',
  PageWaitBit = 'wait_on_page_bit_common',
  BufferWait = '__wait_on_buffer',
  JournalCommit = 'jbd2_log_wait_commit',
  RequestQueue = 'rq_qos_wait',
  CompletionIo = 'wait_for_completion_io',
  FutexWait = 'futex_wait_queue',
  FutexWaitLegacy = 'futex_wait_queue_me',
}

export enum MainTaskSyscallState {
  Running = 'RUNNING',
  NotInSyscall = 'NOT_IN_SYSCALL',
  InSyscall = 'IN_SYSCALL',
}

export type MainTaskSyscall =
  | { readonly state: MainTaskSyscallState.Running | MainTaskSyscallState.NotInSyscall }
  | { readonly state: MainTaskSyscallState.InSyscall; readonly number: number }

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const syscallNumberSchema = count.check(Schema.isLessThanOrEqualTo(2147483647))
const waitChannelSchema = Schema.Enum(MainTaskWaitChannel)
const processStatSchema = Schema.Struct({
  pid: count,
  parentPid: count,
  mainTaskState: Schema.Enum(MainTaskState),
  minorFaults: count,
  majorFaults: count,
  userCpuTicks: count,
  systemCpuTicks: count,
  threadCount: count,
  startTimeTicks: count,
  virtualBytes: count,
  residentPages: count,
})
const ioSchema = Schema.Struct({
  readCharacters: count,
  writtenCharacters: count,
  readSyscalls: count,
  writeSyscalls: count,
  storageReadBytes: count,
  storageWriteBytes: count,
  cancelledWriteBytes: count,
})
const statusSchema = Schema.Struct({
  residentKiB: count,
  peakResidentKiB: count,
  threadCount: count,
  mainTaskVoluntaryContextSwitches: count,
  mainTaskInvoluntaryContextSwitches: count,
})
const schedulerSchema = Schema.Struct({
  mainTaskRuntimeNs: count,
  mainTaskRunQueueDelayNs: count,
  mainTaskTimeslices: count,
})

const integer = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN)
const invalid = () => UnavailableReason.InvalidContent
const available = <A>(value: A) => ({ availability: 'AVAILABLE' as const, value })
const unavailable = (reason: UnavailableReason) => ({ availability: 'UNAVAILABLE' as const, reason })

export const parseNativeProcessStat = (text: string) => {
  // comm can contain spaces and parentheses. It is deliberately never retained.
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  const fields =
    close > open && open > 0
      ? text
          .slice(close + 1)
          .trim()
          .split(/\s+/)
      : []
  return Schema.decodeUnknownResult(processStatSchema)({
    pid: integer(text.slice(0, open).trim()),
    parentPid: integer(fields[1]),
    mainTaskState: fields[0],
    minorFaults: integer(fields[7]),
    majorFaults: integer(fields[9]),
    userCpuTicks: integer(fields[11]),
    systemCpuTicks: integer(fields[12]),
    threadCount: integer(fields[17]),
    startTimeTicks: integer(fields[19]),
    virtualBytes: integer(fields[20]),
    residentPages: integer(fields[21]),
  }).pipe(Result.mapError(invalid))
}

const namedCount = (text: string, name: string, unit = '') => {
  const lines = text.split('\n').filter((line) => line.startsWith(`${name}:`))
  if (lines.length !== 1) return NaN
  const match = new RegExp(`^${name}:\\s+(\\d+)${unit}\\s*$`).exec(lines[0] ?? '')
  return integer(match?.[1])
}

export const parseNativeProcessIo = (text: string) =>
  Schema.decodeUnknownResult(ioSchema)({
    readCharacters: namedCount(text, 'rchar'),
    writtenCharacters: namedCount(text, 'wchar'),
    readSyscalls: namedCount(text, 'syscr'),
    writeSyscalls: namedCount(text, 'syscw'),
    storageReadBytes: namedCount(text, 'read_bytes'),
    storageWriteBytes: namedCount(text, 'write_bytes'),
    cancelledWriteBytes: namedCount(text, 'cancelled_write_bytes'),
  }).pipe(Result.mapError(invalid))

export const parseNativeProcessStatus = (text: string) =>
  Schema.decodeUnknownResult(statusSchema)({
    residentKiB: namedCount(text, 'VmRSS', '\\s+kB'),
    peakResidentKiB: namedCount(text, 'VmHWM', '\\s+kB'),
    threadCount: namedCount(text, 'Threads'),
    mainTaskVoluntaryContextSwitches: namedCount(text, 'voluntary_ctxt_switches'),
    mainTaskInvoluntaryContextSwitches: namedCount(text, 'nonvoluntary_ctxt_switches'),
  }).pipe(Result.mapError(invalid))

export const parseNativeProcessScheduler = (text: string) => {
  const fields = text.trim().split(/\s+/)
  return Schema.decodeUnknownResult(schedulerSchema)({
    mainTaskRuntimeNs: fields.length === 3 ? integer(fields[0]) : NaN,
    mainTaskRunQueueDelayNs: integer(fields[1]),
    mainTaskTimeslices: integer(fields[2]),
  }).pipe(Result.mapError(invalid))
}

export const parseNativeProcessWaitChannel = (text: string) => {
  const symbol = text.trim()
  if (symbol === '0') return Result.fail(UnavailableReason.ZeroWaitChannel)
  return Schema.decodeUnknownResult(waitChannelSchema)(symbol).pipe(
    Result.mapError(() => UnavailableReason.UnrecognizedWaitChannel),
  )
}

const waitChannelFingerprintDomain = 'bayn.opencode-native-wchan-symbol.v1'
const waitChannelPlaceholders = new Set([
  'null',
  'nil',
  'none',
  'unknown',
  'unavailable',
  'ptrval',
  'running',
  'invalid',
  'error',
])

const fingerprintWaitChannel = (text: string) => {
  const symbol = text.trim()
  if (
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(symbol) ||
    /^_*0x/i.test(symbol) ||
    /^_*(?:0x)?[0-9a-f_]*$/i.test(symbol) ||
    waitChannelPlaceholders.has(symbol.toLowerCase())
  )
    return Option.none()
  const sha256 = NodeCrypto.createHash('sha256')
    .update(`${waitChannelFingerprintDomain}\0${symbol}`, 'utf8')
    .digest('hex')
  return /^[0-9a-f]{64}$/.test(sha256) ? Option.some({ domain: waitChannelFingerprintDomain, sha256 }) : Option.none()
}

export const parseNativeProcessSyscall = (text: string): Result.Result<MainTaskSyscall, UnavailableReason> => {
  const fields = text.trim().split(/\s+/)
  if (fields.length === 1 && fields[0] === 'running') return Result.succeed({ state: MainTaskSyscallState.Running })
  // Validate the kernel's hexadecimal register format without retaining any argument, SP or PC value.
  if (fields.slice(1).some((field) => !/^0x[0-9a-f]{1,16}$/.test(field))) return Result.fail(invalid())
  if (fields.length === 3 && fields[0] === '-1') return Result.succeed({ state: MainTaskSyscallState.NotInSyscall })
  if (fields.length !== 9) return Result.fail(invalid())
  return Schema.decodeUnknownResult(syscallNumberSchema)(integer(fields[0])).pipe(
    Result.map((number) => ({ state: MainTaskSyscallState.InSyscall, number })),
    Result.mapError(invalid),
  )
}

type OwnedChild = Pick<ChildProcessSpawner.ChildProcessHandle, 'pid' | 'isRunning'>

const capture = (child: OwnedChild | undefined) =>
  Effect.gen(function* () {
    if (process.platform !== 'linux') return unavailable(UnavailableReason.UnsupportedPlatform)
    if (child === undefined) return unavailable(UnavailableReason.NoChild)
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.pid === process.pid)
      return unavailable(UnavailableReason.IdentityChanged)
    if (!(yield* child.isRunning)) return unavailable(UnavailableReason.ChildNotRunning)
    const fs = yield* FileSystem.FileSystem
    const read = <A>(
      file: 'stat' | 'io' | 'status' | 'schedstat' | 'wchan' | 'syscall',
      parse: (text: string) => Result.Result<A, UnavailableReason>,
    ) =>
      fs
        .stream(`/proc/${child.pid}/${file}`, {
          bytesToRead: nativeProcessCaptureLimits.maximumFileBytes + 1,
          chunkSize: 1024,
        })
        .pipe(
          Stream.runCollect,
          Effect.map((chunks) => {
            const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
            if (length > nativeProcessCaptureLimits.maximumFileBytes) return unavailable(UnavailableReason.ReadLimit)
            const bytes = new Uint8Array(length)
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            const text = new TextDecoder().decode(bytes)
            return Result.match(parse(text), {
              onSuccess: available,
              onFailure: (reason) => {
                const missing = unavailable(reason)
                if (file !== 'wchan' || reason !== UnavailableReason.UnrecognizedWaitChannel) return missing
                return Option.match(fingerprintWaitChannel(text), {
                  onNone: () => missing,
                  onSome: (fingerprint) => ({ ...missing, fingerprint }),
                })
              },
            })
          }),
          Effect.orElseSucceed((error) => {
            switch (error.reason._tag) {
              case 'PermissionDenied':
                return unavailable(UnavailableReason.ReadDenied)
              case 'NotFound':
                return unavailable(UnavailableReason.ReadMissing)
              default:
                return unavailable(UnavailableReason.ReadFailed)
            }
          }),
        )
    const before = yield* read('stat', parseNativeProcessStat)
    if (before.availability === 'UNAVAILABLE') return before
    const owns = (stat: typeof processStatSchema.Type) =>
      stat.pid === child.pid &&
      stat.parentPid === process.pid &&
      ![MainTaskState.Zombie, MainTaskState.Dead, MainTaskState.DeadLegacy].includes(stat.mainTaskState)
    if (!owns(before.value)) return unavailable(UnavailableReason.IdentityChanged)
    const io = yield* read('io', parseNativeProcessIo)
    const status = yield* read('status', parseNativeProcessStatus)
    const scheduler = yield* read('schedstat', parseNativeProcessScheduler)
    const waitChannel = yield* read('wchan', parseNativeProcessWaitChannel)
    const syscall = yield* read('syscall', parseNativeProcessSyscall)
    const after = yield* read('stat', parseNativeProcessStat)
    if (after.availability === 'UNAVAILABLE') return after
    if (!(yield* child.isRunning)) return unavailable(UnavailableReason.ChildNotRunning)
    if (!owns(after.value) || before.value.startTimeTicks !== after.value.startTimeTicks)
      return unavailable(UnavailableReason.IdentityChanged)
    return available({
      process: after.value,
      processAndWaitedChildrenIo: io,
      status,
      mainTaskScheduler: scheduler,
      mainTaskWaitChannel: waitChannel,
      mainTaskSyscall: syscall,
    })
  })

export const observeNativeStartupFailure = (
  exit: Exit.Exit<unknown, unknown>,
  phase: 'initial' | 'restart',
  child: OwnedChild | undefined,
) => {
  if (Exit.isSuccess(exit)) return Effect.void
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    // onExit is uninterruptible. Restore interruption inside the bounded capture and its scoped file streams.
    const snapshot = yield* capture(child).pipe(
      Effect.timeoutOption(nativeProcessCaptureLimits.captureBudgetMs),
      Effect.interruptible,
      Effect.map(Option.getOrElse(() => unavailable(UnavailableReason.CaptureTimeout))),
      Effect.catchCause(() => Effect.succeed(unavailable(UnavailableReason.CaptureFailed))),
    )
    yield* Effect.logInfo(
      JSON.stringify({
        event: 'bayn.opencode-native-process-failure-test.v1',
        phase,
        beforeOuterScopeCleanup: true,
        captureElapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
        limits: nativeProcessCaptureLimits,
        snapshot,
      }),
    )
  }).pipe(
    Effect.timeoutOption(nativeProcessCaptureLimits.observationBudgetMs),
    Effect.interruptible,
    // Diagnostics, including logger defects, must never alter the original native test Cause.
    Effect.catchCause(() => Effect.void),
    Effect.asVoid,
  )
}
