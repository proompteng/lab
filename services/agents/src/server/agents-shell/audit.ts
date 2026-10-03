import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { auditPayloadBudget } from './audit-budget'
import { BoundedAuditWriter } from './audit-writer'
import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'
import {
  credentialEnv,
  credentialOptionNames,
  credentialValuesFromEnv,
  maskCredentialValues,
} from './credential-masker'

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

// These are credential containers, not ordinary identifiers such as tokenCount or key paths.
const credentialField =
  /^(?:password|passwd|token|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|authorization|proxy[-_]authorization|http_authorization|cookie|set-cookie|secret[_-]?access[_-]?key|secret[_-]?key|session[_-]?token|auth[_-]?token|reconnect[_-]?token|github[_-]?token|db[_-]?password|admin[_-]?password|nats[_-]?password|discord[_-]?bot[_-]?token|bot[_-]?token|github[_-]?webhook[_-]?secret|linear[_-]?webhook[_-]?secret|webhook[_-]?secret)$/i

export const sanitizeAuditPayload = (payload: Record<string, unknown>, maskedOutput = false) => {
  const secrets = credentialValuesFromEnv()
  let maskedValues = 0
  const visit = (value: unknown, key?: string): unknown => {
    if (
      key &&
      (credentialField.test(key) || credentialEnv.test(key)) &&
      (typeof value === 'string' || typeof value === 'number')
    ) {
      maskedValues += 1
      return '[REDACTED_CREDENTIAL]'
    }
    if (typeof value === 'string') {
      if (maskedOutput && key === 'text') return value
      const masked = maskCredentialValues(value, secrets)
      maskedValues += masked.maskedValues
      return masked.text
    }
    if (Array.isArray(value)) {
      let maskNext = false
      let userNext = false
      return Array.from({ length: value.length }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(value, String(index))?.value
        if (userNext) {
          userNext = false
          if (typeof item === 'string' && item.includes(':')) {
            maskedValues += 1
            return `${item.slice(0, item.indexOf(':') + 1)}[REDACTED_CREDENTIAL]`
          }
        }
        if (item === '--user' || item === '-u') userNext = true
        if (maskNext && item !== '=') {
          maskNext = false
          maskedValues += 1
          return '[REDACTED_CREDENTIAL]'
        }
        if (typeof item === 'string' && new RegExp(`^--(?:${credentialOptionNames})$`, 'i').test(item)) maskNext = true
        return visit(item)
      })
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([name]) => name !== '_meta')
          .map(([name, item]) => [name, visit(item, name)]),
      )
    }
    return value
  }
  return { payload: visit(payload) as Record<string, unknown>, payloadTruncated: false, maskedValues }
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
  let sanitized = { payload: {} as Record<string, unknown>, payloadTruncated: true, maskedValues: 0 }
  let budget = sourceBudget
  if (sourceBudget.accepted) {
    try {
      sanitized = sanitizeAuditPayload(payload, event === 'process_output')
      budget = auditPayloadBudget(sanitized.payload)
    } catch {
      budget = { ...sourceBudget, accepted: false, reason: 'credential_scanner_capacity_exceeded' }
    }
  }
  const captureIncomplete = !budget.accepted
  if (captureIncomplete)
    sanitized.payload = {
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
          const value = sanitized.payload[key]
          return typeof value === 'string' ? value.length <= 256 : typeof value === 'number' && Number.isFinite(value)
        })
        .map((key) => [key, sanitized.payload[key]]),
    ),
    payloadTruncated: captureIncomplete,
    captureIncomplete,
    maskedValues: sanitized.maskedValues,
  }
  const encoded = JSON.stringify(sanitized.payload)
  const payloadBytes = Buffer.byteLength(encoded)
  const frames =
    payloadBytes <= 12_000
      ? [{ ...envelope, payload: sanitized.payload }]
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
