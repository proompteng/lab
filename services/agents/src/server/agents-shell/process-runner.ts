import type { OutputTail } from './jobs'
import { outputFromOffset, previewCommand } from './jobs'
import { createHash } from 'node:crypto'
import type { CommandResultSchema } from './schemas'

export type ProcessResult = typeof CommandResultSchema.Type

export const formatCommand = (command: string, args: string[]) =>
  [command, ...args]
    .map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`))
    .join(' ')

export const toProcessResult = (
  command: string,
  cwd: string,
  exitCode: number | null,
  signal: string | null,
  timedOut: boolean,
  stdout: OutputTail,
  stderr: OutputTail,
  maxOutputBytes: number,
  capture: { jobId: string; sessionId: string | null; outputCaptureError: string | null; auditErrors: number },
  okExitCodes = new Set([0]),
): ProcessResult => {
  const stdoutOutput = outputFromOffset(stdout, null, maxOutputBytes)
  const stderrOutput = outputFromOffset(stderr, null, maxOutputBytes)
  return {
    ok: exitCode != null ? okExitCodes.has(exitCode) : false,
    commandPreview: previewCommand(command),
    commandHash: createHash('sha256').update(command).digest('hex'),
    ...capture,
    taskId: capture.sessionId ?? capture.jobId,
    captureIncomplete: capture.outputCaptureError !== null || capture.auditErrors > 0,
    cwd,
    exitCode,
    signal,
    timedOut,
    stdout: stdoutOutput.text,
    stderr: stderrOutput.text,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
    stdoutTruncated: stdout.truncated || stdoutOutput.truncatedBeforeOffset,
    stderrTruncated: stderr.truncated || stderrOutput.truncatedBeforeOffset,
  }
}
