import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import type { ProcessResult } from './process-runner'

export type ShellJobStatus = 'running' | 'exited' | 'killed' | 'timed_out'

export type OutputTail = {
  totalBytes: number
  truncated: boolean
  buffer: Buffer
}

export type ShellJob = {
  id: string
  command: string
  cwd: string
  process: ChildProcessByStdio<null, Readable, Readable>
  startedAt: string
  finishedAt: string | null
  status: ShellJobStatus
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  timeout: ReturnType<typeof setTimeout> | null
  stdout: OutputTail
  stderr: OutputTail
}

export type CommandInput = {
  command: string
  cwd: string
  timeoutSeconds: number
  maxOutputBytes: number
}

export type ShellJobSummary = ProcessResult & {
  jobId: string
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
    return this.jobs.get(jobId)
  }

  set(jobId: string, job: ShellJob) {
    this.jobs.set(jobId, job)
    return this
  }

  values() {
    return this.jobs.values()
  }
}

export const tail = (): OutputTail => ({ totalBytes: 0, truncated: false, buffer: Buffer.alloc(0) })

export const appendTail = (output: OutputTail, chunk: Buffer, maxBytes: number) => {
  output.totalBytes += chunk.length
  const merged = Buffer.concat([output.buffer, chunk])
  if (merged.length > maxBytes) {
    output.buffer = merged.subarray(merged.length - maxBytes)
    output.truncated = true
    return
  }
  output.buffer = merged
}

export const outputFromOffset = (output: OutputTail, offset: number | null, maxBytes: number) => {
  const retentionStart = Math.max(0, output.totalBytes - output.buffer.length)
  const safeOffset = offset ?? retentionStart
  const start = Math.max(0, safeOffset - retentionStart)
  let buffer = output.buffer.subarray(Math.min(start, output.buffer.length))
  let truncatedBeforeOffset = safeOffset < retentionStart
  if (buffer.length > maxBytes) {
    buffer = buffer.subarray(buffer.length - maxBytes)
    truncatedBeforeOffset = true
  }
  return {
    text: buffer.toString('utf8'),
    retentionStartByte: retentionStart,
    nextOffset: output.totalBytes,
    truncatedBeforeOffset,
  }
}

export const summarizeJob = (
  job: ShellJob,
  maxOutputBytes: number,
  offsets: { stdoutOffset?: number | null; stderrOffset?: number | null } = {},
): ShellJobSummary => {
  const stdout = outputFromOffset(job.stdout, offsets.stdoutOffset ?? null, maxOutputBytes)
  const stderr = outputFromOffset(job.stderr, offsets.stderrOffset ?? null, maxOutputBytes)
  return {
    ok: job.exitCode === 0 && !job.timedOut,
    command: job.command,
    cwd: job.cwd,
    exitCode: job.exitCode,
    signal: job.signal,
    timedOut: job.timedOut,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: job.stdout.totalBytes,
    stderrBytes: job.stderr.totalBytes,
    stdoutTruncated: job.stdout.truncated || stdout.truncatedBeforeOffset,
    stderrTruncated: job.stderr.truncated || stderr.truncatedBeforeOffset,
    jobId: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stdoutRetentionStartByte: stdout.retentionStartByte,
    stderrRetentionStartByte: stderr.retentionStartByte,
    stdoutNextOffset: stdout.nextOffset,
    stderrNextOffset: stderr.nextOffset,
  }
}
