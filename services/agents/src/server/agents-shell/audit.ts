import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { auditPayloadBudget } from './audit-budget'
import { BoundedAuditWriter } from './audit-writer'
import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'
export type ToolAuditContext = { requestId: string; toolCallId: string; tool: string }
export const toolAuditContext = new AsyncLocalStorage<ToolAuditContext>()

// An explicit Writable sink gives every event family real, bounded backpressure in Node and Bun.
export const auditStdout = { write: (line: string) => process.stdout.write(line) }
const stdoutWriter = new BoundedAuditWriter(process.stdout, (line) => auditStdout.write(line))
export const flushAuditLog = () => stdoutWriter.flush()
let sinkWarningEmitted = false

// A process-private signature distinguishes our emitted frames from ordinary JSON printed by a command.
const frameKey = randomBytes(32)
const signFrame = (frame: unknown) => createHmac('sha256', frameKey).update(JSON.stringify(frame)).digest('hex')
export const isOwnAuditFrame = (line: string) => {
  try {
    const start = line.indexOf('{')
    if (start < 0) return false
    const { frameSignature, ...frame } = JSON.parse(line.slice(start))
    return (
      frame.msg === 'agents-shell audit' &&
      frame.schemaVersion === 2 &&
      typeof frameSignature === 'string' &&
      frameSignature === signFrame(frame)
    )
  } catch {
    return false
  }
}

// Admission bounds traversal before copying. Operational values are exported verbatim.
export const prepareAuditPayload = (payload: Record<string, unknown>) => {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value))
      return Array.from({ length: value.length }, (_, index) =>
        visit(Object.getOwnPropertyDescriptor(value, String(index))?.value),
      )
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .filter((name) => name !== '_meta')
          .map((name) => [name, visit(Object.getOwnPropertyDescriptor(value, name)?.value)]),
      )
    return value
  }
  return { payload: visit(payload) as Record<string, unknown>, payloadTruncated: false, maskedValues: 0 }
}

// Split by code points before serialization. Even all-control-character input remains below 16 KiB per frame.
export const auditFragments = (text: string) => {
  const fragments: string[] = []
  let fragment = ''
  for (const char of text) {
    if (fragment.length + char.length > 1800) {
      fragments.push(fragment)
      fragment = ''
    }
    fragment += char
  }
  if (fragment || !fragments.length) fragments.push(fragment)
  return fragments
}

export const writeAuditLog = (
  config: AgentsShellConfig,
  event: string,
  auth: AuthContext | null,
  payload: Record<string, unknown>,
  context = toolAuditContext.getStore() ?? null,
) => {
  const sourceBudget = auditPayloadBudget(payload)
  let prepared = { payload: {} as Record<string, unknown>, payloadTruncated: true, maskedValues: 0 }
  let budget = sourceBudget
  if (sourceBudget.accepted) {
    try {
      prepared = prepareAuditPayload(payload)
      budget = auditPayloadBudget(prepared.payload)
    } catch {
      budget = { ...sourceBudget, accepted: false, reason: 'payload_preparation_failed' }
    }
  }
  const captureIncomplete = !budget.accepted
  if (captureIncomplete)
    prepared.payload = {
      captureIncomplete: true,
      rejection: budget,
      originalResultUnchanged: true,
      retrieval: 'Original MCP result and existing authorized retention are unchanged',
    }

  const envelope = {
    msg: 'agents-shell audit',
    schemaVersion: 2,
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    event,
    ...context,
    subjectHash: auth?.subject ? createHash('sha256').update(auth.subject).digest('hex') : null,
    ...Object.fromEntries(
      ['jobId', 'sessionId', 'agentId', 'stream', 'sequence', 'byteStart', 'byteEnd']
        .filter((key) => {
          const value = prepared.payload[key]
          return typeof value === 'string' ? value.length <= 256 : typeof value === 'number' && Number.isFinite(value)
        })
        .map((key) => [key, prepared.payload[key]]),
    ),
    payloadTruncated: captureIncomplete,
    captureIncomplete,
    maskedValues: prepared.maskedValues,
  }
  const encoded = JSON.stringify(prepared.payload)
  const payloadBytes = Buffer.byteLength(encoded)
  const frames =
    payloadBytes <= 12_000
      ? [{ ...envelope, payload: prepared.payload }]
      : auditFragments(encoded).map((payloadFragment, fragmentIndex, fragments) => ({
          ...envelope,
          payloadFragment,
          fragmentIndex,
          fragmentCount: fragments.length,
          payloadBytes,
        }))
  const lines = frames.map((frame) => `${JSON.stringify({ ...frame, frameSignature: signFrame(frame) })}\n`)
  let sinkErrors = stdoutWriter.enqueue(lines) + Number(captureIncomplete)
  for (const line of lines) {
    if (config.auditLogPath) {
      try {
        mkdirSync(dirname(config.auditLogPath), { recursive: true })
        appendFileSync(config.auditLogPath, line, { mode: 0o600 })
      } catch {
        sinkErrors += 1
      }
    }
  }
  if (sinkErrors && !sinkWarningEmitted) {
    sinkWarningEmitted = true
    console.warn(
      JSON.stringify({
        msg: 'agents-shell audit sink failure; further failures are counted in MCP audit metadata',
        eventId: envelope.eventId,
        sinkErrors,
      }),
    )
  }
  return sinkErrors
}
