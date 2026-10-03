import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { BoundedAuditWriter } from './audit-writer'
import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'
import { credentialValuesFromEnv, maskCredentialValues } from './credential-masker'

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
  /^(?:password|passwd|token|secret|access_token|accessToken|refresh_token|refreshToken|id_token|api_key|apiKey|client_secret|clientSecret|private_key|privateKey|authorization|proxy-authorization|cookie|set-cookie)$/i

export const sanitizeAuditPayload = (payload: Record<string, unknown>, maskedOutput = false) => {
  const secrets = credentialValuesFromEnv()
  let maskedValues = 0
  const visit = (value: unknown, key?: string): unknown => {
    if (key && credentialField.test(key) && value !== null && value !== undefined) {
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
      return value.map((item) => {
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
        if (
          typeof item === 'string' &&
          /^(?:--(?:password|passwd|token|api-key|client-secret|oauth2-bearer))$/i.test(item)
        )
          maskNext = true
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
  const sanitized = sanitizeAuditPayload(payload, event === 'process_output')
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
        .filter((key) => key in sanitized.payload)
        .map((key) => [key, sanitized.payload[key]]),
    ),
    payloadTruncated: false,
    maskedValues: sanitized.maskedValues,
  }
  const encoded = JSON.stringify(sanitized.payload)
  const frames =
    Buffer.byteLength(encoded) <= 12_000
      ? [{ ...envelope, payload: sanitized.payload }]
      : auditFragments(encoded).map((payloadFragment, fragmentIndex, fragments) => ({
          ...envelope,
          payloadFragment,
          fragmentIndex,
          fragmentCount: fragments.length,
          payloadBytes: Buffer.byteLength(encoded),
        }))
  const lines = frames.map((frame) => `${JSON.stringify({ ...frame, frameSignature: signFrame(frame) })}\n`)
  let sinkErrors = stdoutWriter.enqueue(lines)
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
