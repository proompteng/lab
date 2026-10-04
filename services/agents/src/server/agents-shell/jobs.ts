import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import {
  MAX_RETAINED_OUTPUT_JOBS,
  MAX_RETAINED_RECEIPTS,
  OUTPUT_RETENTION_TOTAL_BYTES,
  RECEIPT_TTL_MS,
  REPLY_META_RESERVE_BYTES,
  STATUS_REPLY_BYTES,
} from './constants'
import { AgentsShellRuntimeError } from './errors'
import { jsonTextResult } from './results'

export type OutputTail = {
  totalBytes: number
  truncated: boolean
  storage: Buffer
  start: number
  length: number
}

type JobIdentity = {
  id: string
  ownerSubject: string
  sessionId: string | null
  taskId: string
  agentId: string | null
  requestKey: string
  requestId: string | null
  toolCallId: string | null
  commandPreview: string
  commandHash: string
  cwd: string
  startedAt: string
  stdout: OutputTail
  stderr: OutputTail
  outputCaptureError: string | null
  auditErrors: number
}

export type RunningShellJob = JobIdentity & {
  kind: 'running'
  process: ChildProcessByStdio<null, Readable, Readable>
  termination: 'cancelled' | 'timed_out' | null
  timeout: ReturnType<typeof setTimeout> | null
  finishedAt: null
}

export type CompletedShellJob = JobIdentity & {
  kind: 'completed'
  status: 'exited' | 'cancelled' | 'timed_out'
  finishedAt: string
  exitCode: number | null
  signal: string | null
}

export type ShellJob = RunningShellJob | CompletedShellJob

export type CommandInput = {
  command: string
  cwd: string
  timeoutSeconds: number
  maxBytes: number
  waitMs: number
  requestKey: string
  sessionId?: string
  agentId?: string
}

export type OutputCursor = {
  jobId: string
  stdoutOffset: number
  stderrOffset: number
  outputEncoding: 'utf8' | 'base64'
}

export const previewCommand = (command: string, maxBytes = 160) => {
  const bytes = Buffer.from(command)
  if (bytes.length <= maxBytes) return command
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

export class ShellJobStore {
  private readonly jobs = new Map<string, ShellJob>()
  private readonly completed = new Map<string, number>()
  private readonly outputs = new Set<string>()
  private readonly active = new Set<string>()

  get size() {
    return this.jobs.size
  }

  has(jobId: string) {
    return this.jobs.has(jobId)
  }

  get(jobId: string) {
    this.prune()
    const job = this.jobs.get(jobId)
    if (job?.kind === 'completed' && Date.now() - Date.parse(job.finishedAt) >= RECEIPT_TTL_MS) {
      this.delete(jobId)
      return undefined
    }
    return job
  }

  set(jobId: string, job: ShellJob) {
    if (!this.jobs.has(jobId)) this.ensureCapacity()
    this.jobs.set(jobId, job)
    if (job.kind === 'running') this.active.add(jobId)
    else {
      this.active.delete(jobId)
      this.completed.set(jobId, Date.parse(job.finishedAt))
      if (job.stdout.storage.length + job.stderr.storage.length > 0) this.outputs.add(jobId)
    }
    this.prune()
    return this
  }

  values() {
    this.prune()
    return this.jobs.values()
  }

  *running() {
    for (const id of this.active) {
      const job = this.jobs.get(id)
      if (job?.kind === 'running') yield job
    }
  }

  ensureCapacity() {
    this.prune()
    if (this.jobs.size >= MAX_RETAINED_RECEIPTS)
      throw new AgentsShellRuntimeError({
        message: 'completion receipt capacity reached; retry after expiry',
        code: 'CAPACITY_BUSY',
        retryAfterMs: 1000,
      })
  }

  private delete(id: string) {
    this.jobs.delete(id)
    this.completed.delete(id)
    this.outputs.delete(id)
    this.active.delete(id)
  }

  prune() {
    const expiry = Date.now() - RECEIPT_TTL_MS
    for (const [id, finishedAt] of this.completed) {
      if (finishedAt > expiry) break
      this.delete(id)
    }
    let bytes = 0
    for (const id of [...this.active, ...this.outputs]) {
      const job = this.jobs.get(id)
      if (job) bytes += job.stdout.storage.length + job.stderr.storage.length
    }
    for (const id of this.outputs) {
      if (this.outputs.size <= MAX_RETAINED_OUTPUT_JOBS && bytes <= OUTPUT_RETENTION_TOTAL_BYTES) break
      const job = this.jobs.get(id)
      this.outputs.delete(id)
      if (!job) continue
      bytes -= job.stdout.storage.length + job.stderr.storage.length
      for (const output of [job.stdout, job.stderr]) {
        output.storage = Buffer.alloc(0)
        output.start = 0
        output.length = 0
        output.truncated ||= output.totalBytes > 0
      }
    }
  }
}

export const tail = (): OutputTail => ({
  totalBytes: 0,
  truncated: false,
  storage: Buffer.alloc(0),
  start: 0,
  length: 0,
})

const copyRetained = (output: OutputTail, start: number, end: number, target: Buffer) => {
  if (end <= start) return
  const index = (output.start + start) % output.storage.length
  const first = Math.min(end - start, output.storage.length - index)
  if (first > 0) output.storage.copy(target, 0, index, index + first)
  if (first < end - start) output.storage.copy(target, first, 0, end - start - first)
}
const byteAt = (output: OutputTail, index: number) => output.storage[(output.start + index) % output.storage.length]

export const appendTail = (output: OutputTail, chunk: Buffer, maxBytes: number) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('retention budget must be a nonnegative safe integer')
  output.totalBytes += chunk.length
  if (maxBytes <= 0) {
    output.storage = Buffer.alloc(0)
    output.start = 0
    output.length = 0
    output.truncated = output.totalBytes > 0
    return
  }
  // Grow geometrically only when necessary; sustained output copies only the incoming retained bytes.
  const required = Math.min(maxBytes, output.length + chunk.length)
  if (output.storage.length < required || output.storage.length > maxBytes) {
    const storage = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(required, output.storage.length * 2, 65_536)))
    const retained = Math.min(output.length, storage.length)
    copyRetained(output, output.length - retained, output.length, storage)
    output.storage = storage
    output.start = 0
    output.length = retained
  }
  if (chunk.length >= maxBytes) {
    chunk.copy(output.storage, 0, chunk.length - maxBytes)
    output.start = 0
    output.length = maxBytes
  } else if (chunk.length > 0) {
    const evicted = Math.max(0, output.length + chunk.length - maxBytes)
    output.start = (output.start + evicted) % output.storage.length
    output.length -= evicted
    const index = (output.start + output.length) % output.storage.length
    const first = Math.min(chunk.length, output.storage.length - index)
    chunk.copy(output.storage, index, 0, first)
    if (first < chunk.length) chunk.copy(output.storage, 0, first)
    output.length += chunk.length
  }
  output.truncated ||= output.totalBytes > output.length
}

export const outputFromOffset = (
  output: OutputTail,
  offset: number | null,
  maxBytes: number,
  encoding: 'utf8' | 'base64' = 'utf8',
  final = true,
) => {
  const retentionStart = Math.max(0, output.totalBytes - output.length)
  const requestedOffset = offset ?? Math.max(retentionStart, output.totalBytes - maxBytes)
  let start = Math.min(output.length, Math.max(0, requestedOffset - retentionStart))
  let end = Math.min(output.length, start + maxBytes)
  // Never introduce a replacement character by splitting a valid UTF-8 code point.
  // Base64 is available when exact arbitrary bytes, including invalid UTF-8, matter.
  if (encoding === 'utf8') {
    while (start < end && (byteAt(output, start) & 0xc0) === 0x80) start += 1
    if (end < output.length) {
      while (end > start && (byteAt(output, end) & 0xc0) === 0x80) end -= 1
    } else if (!final && end > start) {
      let lead = end - 1
      while (lead > start && (byteAt(output, lead) & 0xc0) === 0x80) lead -= 1
      const byte = byteAt(output, lead)
      const width =
        byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 1
      if (end - lead < width) end = lead
    }
  }
  const page = Buffer.allocUnsafe(end - start)
  copyRetained(output, start, end, page)
  return {
    text: page.toString(encoding),
    retentionStartByte: retentionStart,
    startOffset: retentionStart + start,
    nextOffset: retentionStart + end,
    hasMore: end < output.length && end > start,
    truncatedBeforeOffset: requestedOffset < retentionStart || (offset === null && start > 0),
  }
}

export const jobMetadata = (job: ShellJob) => {
  const identity = {
    jobId: job.id,
    sessionId: job.sessionId,
    taskId: job.taskId,
    agentId: job.agentId,
    requestKey: job.requestKey,
    requestId: job.requestId,
    toolCallId: job.toolCallId,
    commandPreview: job.commandPreview,
    commandHash: job.commandHash,
    cwd: job.cwd,
    startedAt: job.startedAt,
    stdoutBytes: job.stdout.totalBytes,
    stderrBytes: job.stderr.totalBytes,
    stdoutRetentionStartByte: job.stdout.totalBytes - job.stdout.length,
    stderrRetentionStartByte: job.stderr.totalBytes - job.stderr.length,
    outputCaptureError: job.outputCaptureError,
    auditErrors: job.auditErrors,
    captureIncomplete: job.outputCaptureError !== null || job.auditErrors > 0,
  }
  return job.kind === 'running'
    ? {
        ...identity,
        state: 'running' as const,
        ok: null,
        exitCode: null,
        signal: null,
        finishedAt: null,
        expiresAt: null,
      }
    : {
        ...identity,
        state: job.status,
        ok: job.status === 'exited' && job.exitCode === 0,
        exitCode: job.exitCode,
        signal: job.signal,
        finishedAt: job.finishedAt,
        expiresAt: new Date(Date.parse(job.finishedAt) + RECEIPT_TTL_MS).toISOString(),
      }
}

export const encodeOutputCursor = (cursor: OutputCursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url')

export const decodeOutputCursor = (value: string, jobId: string): OutputCursor => {
  let cursor: unknown
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid output cursor')
  }
  if (
    typeof cursor !== 'object' ||
    cursor === null ||
    !('jobId' in cursor) ||
    cursor.jobId !== jobId ||
    !('stdoutOffset' in cursor) ||
    typeof cursor.stdoutOffset !== 'number' ||
    !Number.isSafeInteger(cursor.stdoutOffset) ||
    cursor.stdoutOffset < 0 ||
    !('stderrOffset' in cursor) ||
    typeof cursor.stderrOffset !== 'number' ||
    !Number.isSafeInteger(cursor.stderrOffset) ||
    cursor.stderrOffset < 0 ||
    !('outputEncoding' in cursor) ||
    (cursor.outputEncoding !== 'utf8' && cursor.outputEncoding !== 'base64')
  )
    throw new Error('output cursor does not match this job or contains invalid offsets')
  return {
    jobId,
    stdoutOffset: cursor.stdoutOffset,
    stderrOffset: cursor.stderrOffset,
    outputEncoding: cursor.outputEncoding,
  }
}

export const readJobOutput = (job: ShellJob, cursor: OutputCursor, maxBytes: number) => {
  if (cursor.stdoutOffset > job.stdout.totalBytes || cursor.stderrOffset > job.stderr.totalBytes)
    throw new Error('output cursor is beyond produced bytes')
  const metadata = jobMetadata(job)
  let outputBytes = Math.max(0, Math.floor((maxBytes - REPLY_META_RESERVE_BYTES - 2048) / 2))
  for (;;) {
    const stdoutAvailable = Math.max(
      0,
      job.stdout.totalBytes - Math.max(cursor.stdoutOffset, job.stdout.totalBytes - job.stdout.length),
    )
    const stderrAvailable = Math.max(
      0,
      job.stderr.totalBytes - Math.max(cursor.stderrOffset, job.stderr.totalBytes - job.stderr.length),
    )
    const stdoutBudget = stderrAvailable === 0 ? outputBytes : Math.min(stdoutAvailable, Math.ceil(outputBytes / 2))
    const stdout = outputFromOffset(
      job.stdout,
      cursor.stdoutOffset,
      stdoutBudget,
      cursor.outputEncoding,
      job.kind === 'completed',
    )
    const stderr = outputFromOffset(
      job.stderr,
      cursor.stderrOffset,
      Math.max(0, outputBytes - (stdout.nextOffset - stdout.startOffset)),
      cursor.outputEncoding,
      job.kind === 'completed',
    )
    const result = {
      ...metadata,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutStartOffset: stdout.startOffset,
      stderrStartOffset: stderr.startOffset,
      stdoutNextOffset: stdout.nextOffset,
      stderrNextOffset: stderr.nextOffset,
      stdoutHasMore: stdout.hasMore,
      stderrHasMore: stderr.hasMore,
      stdoutTruncated: stdout.truncatedBeforeOffset,
      stderrTruncated: stderr.truncatedBeforeOffset,
      cursor: encodeOutputCursor({
        jobId: job.id,
        stdoutOffset: stdout.nextOffset,
        stderrOffset: stderr.nextOffset,
        outputEncoding: cursor.outputEncoding,
      }),
      outputEncoding: cursor.outputEncoding,
      maxBytes,
    }
    const wireBytes = Buffer.byteLength(JSON.stringify(jsonTextResult(result))) + REPLY_META_RESERVE_BYTES
    if (wireBytes <= maxBytes) return result
    if (outputBytes === 0) throw new Error('reply budget is too small for job metadata')
    outputBytes = Math.floor(outputBytes / 2)
  }
}

export const listJobMetadata = (jobs: ShellJob[], cursor: string | undefined, limit: number) => {
  let after: { startedAt: string; id: string } | undefined
  if (cursor) {
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    } catch {
      throw new Error('invalid status cursor')
    }
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('startedAt' in decoded) ||
      typeof decoded.startedAt !== 'string' ||
      !('id' in decoded) ||
      typeof decoded.id !== 'string'
    )
      throw new Error('invalid status cursor')
    after = { startedAt: decoded.startedAt, id: decoded.id }
  }
  const sorted = jobs
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
    .filter(
      (job) => !after || job.startedAt < after.startedAt || (job.startedAt === after.startedAt && job.id < after.id),
    )
  const page: ReturnType<typeof jobMetadata>[] = []
  let result = { jobs: page, cursor: null as string | null, hasMore: false }
  for (const job of sorted.slice(0, limit)) {
    const hasMore = page.length + 1 < sorted.length
    const next = {
      jobs: [...page, jobMetadata(job)],
      cursor: hasMore
        ? Buffer.from(JSON.stringify({ startedAt: job.startedAt, id: job.id })).toString('base64url')
        : null,
      hasMore,
    }
    if (Buffer.byteLength(JSON.stringify(jsonTextResult(next))) + REPLY_META_RESERVE_BYTES > STATUS_REPLY_BYTES) {
      if (page.length === 0) throw new Error('job metadata exceeds status reply budget')
      break
    }
    page.push(next.jobs[next.jobs.length - 1])
    result = { ...next, jobs: page }
  }
  return result
}
