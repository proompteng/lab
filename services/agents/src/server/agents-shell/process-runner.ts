import type { OutputTail } from './jobs'
import { outputFromOffset } from './jobs'

export type ProcessResult = {
  ok: boolean
  command: string
  cwd: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export const formatCommand = (command: string, args: string[]) =>
  [command, ...args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg))].join(' ')

export const toProcessResult = (
  command: string,
  cwd: string,
  exitCode: number | null,
  signal: string | null,
  timedOut: boolean,
  stdout: OutputTail,
  stderr: OutputTail,
  maxOutputBytes: number,
  okExitCodes = new Set([0]),
): ProcessResult => {
  const stdoutOutput = outputFromOffset(stdout, null, maxOutputBytes)
  const stderrOutput = outputFromOffset(stderr, null, maxOutputBytes)
  return {
    ok: exitCode != null ? okExitCodes.has(exitCode) : false,
    command,
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
