import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import type { ProcessResult } from './process-runner'
import { MAX_RETAINED_JOBS } from './constants'

export type ShellJobStatus = 'running' | 'exited' | 'killed' | 'timed_out'

export type OutputTail = {
  totalBytes: number
  truncated: boolean
  storage: Buffer
  start: number
  length: number
}

export type ShellJob = {
  id: string
  ownerSubject: string
  sessionId: string | null
  agentId: string | null
  requestId: string | null
  toolCallId: string | null
  command: string
  cwd: string
  process: ChildProcessByStdio<null, Readable, Readable>
  startedAt: string
  finishedAt: string | null
  status: ShellJobStatus
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  outputCaptureError: string | null
  auditErrors: number
  timeout: ReturnType<typeof setTimeout> | null
  stdout: OutputTail
  stderr: OutputTail
}

export type CommandInput = {
  command: string
  cwd: string
  timeoutSeconds: number
  maxOutputBytes: number
  sessionId?: string
  agentId?: string
}

export type ShellJobSummary = ProcessResult & {
  jobId: string
  outputCaptureError: string | null
  auditErrors: number
  sessionId: string | null
  agentId: string | null
  requestId: string | null
  toolCallId: string | null
  outputEncoding: 'utf8' | 'base64'
  outputLimitBytes: number
  stdoutStartOffset: number
  stderrStartOffset: number
  stdoutHasMore: boolean
  stderrHasMore: boolean
  status: ShellJobStatus
  startedAt: string
  finishedAt: string | null
  stdoutRetentionStartByte: number
  stderrRetentionStartByte: number
  stdoutNextOffset: number
  stderrNextOffset: number
}

export class ShellJobStore {
  private readonly jobs = new Map<string, ShellJob>()

  get size() {
    return this.jobs.size
  }

  get(jobId: string) {
    this.prune()
    return this.jobs.get(jobId)
  }

  set(jobId: string, job: ShellJob) {
    this.jobs.set(jobId, job)
    this.prune()
    return this
  }

  values() {
    this.prune()
    return this.jobs.values()
  }

  prune() {
    // Running jobs are never evicted. Completed histories have an explicit bounded lifetime.
    let bytes = Array.from(this.jobs.values()).reduce(
      (total, job) => total + job.stdout.storage.length + job.stderr.storage.length,
      0,
    )
    for (const [id, job] of this.jobs) {
      if (job.finishedAt === null) continue
      if (
        this.jobs.size <= MAX_RETAINED_JOBS &&
        bytes <= 64 * 1024 * 1024 &&
        Date.now() - Date.parse(job.finishedAt) < 60 * 60 * 1000
      )
        continue
      bytes -= job.stdout.storage.length + job.stderr.storage.length
      this.jobs.delete(id)
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

export const summarizeJob = (
  job: ShellJob,
  maxOutputBytes: number,
  offsets: { stdoutOffset?: number | null; stderrOffset?: number | null; outputEncoding?: 'utf8' | 'base64' } = {},
): ShellJobSummary => {
  const stdout = outputFromOffset(
    job.stdout,
    offsets.stdoutOffset ?? null,
    maxOutputBytes,
    offsets.outputEncoding,
    job.finishedAt !== null,
  )
  const stderr = outputFromOffset(
    job.stderr,
    offsets.stderrOffset ?? null,
    maxOutputBytes,
    offsets.outputEncoding,
    job.finishedAt !== null,
  )
  return {
    ok: job.exitCode === 0 && !job.timedOut,
    command: job.command,
    cwd: job.cwd,
    exitCode: job.exitCode,
    signal: job.signal,
    timedOut: job.timedOut,
    outputCaptureError: job.outputCaptureError,
    auditErrors: job.auditErrors,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: job.stdout.totalBytes,
    stderrBytes: job.stderr.totalBytes,
    stdoutTruncated: job.stdout.truncated || stdout.truncatedBeforeOffset,
    stderrTruncated: job.stderr.truncated || stderr.truncatedBeforeOffset,
    jobId: job.id,
    sessionId: job.sessionId,
    agentId: job.agentId,
    requestId: job.requestId,
    toolCallId: job.toolCallId,
    outputEncoding: offsets.outputEncoding ?? 'utf8',
    outputLimitBytes: maxOutputBytes,
    stdoutStartOffset: stdout.startOffset,
    stderrStartOffset: stderr.startOffset,
    stdoutHasMore: stdout.hasMore,
    stderrHasMore: stderr.hasMore,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stdoutRetentionStartByte: stdout.retentionStartByte,
    stderrRetentionStartByte: stderr.retentionStartByte,
    stdoutNextOffset: stdout.nextOffset,
    stderrNextOffset: stderr.nextOffset,
  }
}
