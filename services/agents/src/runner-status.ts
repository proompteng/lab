import { createHash } from 'node:crypto'
import { z } from 'zod'

export const RUNNER_TERMINATION_BYTES = 4096
export const RUNNER_STATUS_LOG_BYTES = 1_048_576
export const RUNNER_STATUS_EVENT = 'runner_terminal_status'
export const runnerStatusReferenceSchema = z.object({ runnerStatusDigest: z.string().regex(/^[a-f0-9]{64}$/) })

export const runnerStatusDigest = (status: object) => createHash('sha256').update(JSON.stringify(status)).digest('hex')

export const encodeRunnerStatus = (status: object) => {
  const message = `${JSON.stringify(status)}\n`
  if (Buffer.byteLength(message) <= RUNNER_TERMINATION_BYTES) return { message, logLine: null }
  const logLine = `${JSON.stringify({ event: { type: RUNNER_STATUS_EVENT, status } })}\n`
  if (Buffer.byteLength(logLine) > RUNNER_STATUS_LOG_BYTES) throw new Error('runner status exceeds the log byte budget')
  return {
    message: `${JSON.stringify({ runnerStatusDigest: runnerStatusDigest(status) })}\n`,
    logLine,
  }
}
