import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { auditPayloadBudget } from './audit-budget'
import { BoundedAuditWriter } from './audit-writer'
import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'
import {
  isSecretRead,
  maskKubernetesSecretCreationArgs,
  maskKubernetesSecretCreationCommand,
  maskKubernetesSecretText,
  secretCaptureMode,
  secretCreationCredentialValues,
} from './kubernetes-secret-masker'
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
  /^(?:password|passwd|token|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|authorization|proxy[-_]authorization|http_authorization|cookie|set-cookie|secret[_-]?access[_-]?key|secret[_-]?key|session[_-]?token|auth[_-]?token|reconnect[_-]?token|github[_-]?token|db[_-]?password|admin[_-]?password|nats[_-]?password|discord[_-]?bot[_-]?token|bot[_-]?token|github[_-]?webhook[_-]?secret|linear[_-]?webhook[_-]?secret|webhook[_-]?secret|openai[_-]?api[_-]?key|bedrock[_-]?api[_-]?key|cloud[_-]?api[_-]?key|principal[_-]?api[_-]?key|personal[_-]?access[_-]?token|ssh[_-]?private[_-]?key|root[_-]?password|loki[_-]?secret[_-]?key|tempo[_-]?secret[_-]?key|mimir[_-]?secret[_-]?key|auth[_-]?key|tailscale[_-]?auth[_-]?key|signing[_-]?passphrase|passphrase|client-key-data|_authToken|_auth|_password)$/i

export const sanitizeAuditPayload = (payload: Record<string, unknown>, maskedOutput = false, tool?: string) => {
  const secrets = credentialValuesFromEnv()
  const commands = new WeakMap<object, ReturnType<typeof maskKubernetesSecretCreationCommand>>()
  const argumentsMasks = new WeakMap<object, ReturnType<typeof maskKubernetesSecretCreationArgs>>()
  const creationValues = new Set<string>()
  let creationCharacters = 0
  const collectCreationValues = (values: string[]) => {
    for (const value of values) {
      if (creationValues.has(value)) continue
      creationValues.add(value)
      creationCharacters += value.length
      if (creationValues.size > 256 || creationCharacters > 65_536)
        throw new Error('Secret creation literals exceeded bounded payload capture')
    }
  }
  const trustedArguments =
    tool === 'kubectl' || tool === 'kubectl_admin' ? Object.getOwnPropertyDescriptor(payload, 'arguments')?.value : null
  const inspect = (value: unknown) => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1)
        inspect(Object.getOwnPropertyDescriptor(value, String(index))?.value)
      return
    }
    const command = Object.getOwnPropertyDescriptor(value, 'command')?.value
    if (typeof command === 'string') {
      const masked = maskKubernetesSecretCreationCommand(command)
      commands.set(value, masked)
      collectCreationValues(masked.values)
    }
    const args = Object.getOwnPropertyDescriptor(value, 'args')?.value
    if (Array.isArray(args) && (value === trustedArguments || commands.get(value)?.maskedValues)) {
      const strings = Array.from(
        { length: args.length },
        (_, index) => Object.getOwnPropertyDescriptor(args, String(index))?.value,
      )
      if (strings.every((item): item is string => typeof item === 'string')) {
        const masked = maskKubernetesSecretCreationArgs(strings)
        argumentsMasks.set(args, masked)
        collectCreationValues(masked.values)
      }
    }
    for (const key of Object.keys(value)) {
      if (key !== '_meta') inspect(Object.getOwnPropertyDescriptor(value, key)?.value)
    }
  }
  inspect(payload)
  // A short literal cannot be replaced globally without erasing ordinary text. Omit capture explicitly instead.
  if ([...creationValues].some((value) => value.length < 4))
    throw new Error('Short Secret literal output cannot be safely captured')
  const outputSecrets = [...secrets, ...secretCreationCredentialValues([...creationValues])]
  let maskedValues = 0
  const visit = (value: unknown, key?: string, secretSource: string | null = null, secretItem = false): unknown => {
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
      const structural = maskKubernetesSecretText(
        value,
        secretSource !== null ? secretCaptureMode(secretSource) : null,
        key === 'stderr',
      )
      maskedValues += structural.maskedValues
      const masked = maskCredentialValues(
        structural.text,
        key === 'command' || key === 'args' ? secrets : outputSecrets,
      )
      maskedValues += masked.maskedValues
      return masked.text
    }
    if (Array.isArray(value)) {
      const secretArgs = argumentsMasks.get(value)
      if (secretArgs) {
        maskedValues += secretArgs.maskedValues
      }
      const items = secretArgs?.args ?? value
      let maskNext = false
      let userNext = false
      return Array.from({ length: items.length }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(items, String(index))?.value
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
        return visit(item, key, secretSource, secretItem)
      })
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const secretCommand = commands.get(record)
      const kind = Object.getOwnPropertyDescriptor(record, 'kind')?.value
      const secret = kind === 'Secret' || secretItem
      const command = Object.getOwnPropertyDescriptor(record, 'command')?.value
      const envName = Object.getOwnPropertyDescriptor(record, 'name')?.value
      const maskContainer = (entry: unknown): unknown => {
        if (entry === null || entry === undefined) return entry
        if (typeof entry === 'object') {
          if (Array.isArray(entry))
            return Array.from({ length: entry.length }, (_, index) =>
              maskContainer(Object.getOwnPropertyDescriptor(entry, String(index))?.value),
            )
          return Object.fromEntries(
            Object.keys(entry).map((key) => [key, maskContainer(Object.getOwnPropertyDescriptor(entry, key)?.value)]),
          )
        }
        maskedValues += 1
        return '[REDACTED_CREDENTIAL]'
      }
      return Object.fromEntries(
        Object.keys(record)
          .filter((name) => name !== '_meta')
          .map((name) => {
            const item = Object.getOwnPropertyDescriptor(record, name)?.value
            const safeItem = name === 'command' && secretCommand ? secretCommand.text : item
            if (name === 'command' && secretCommand) maskedValues += secretCommand.maskedValues
            const credentialName =
              name === 'value' &&
              typeof envName === 'string' &&
              (credentialField.test(envName) || credentialEnv.test(envName))
                ? envName
                : name
            return [
              name,
              secret && (name === 'data' || name === 'stringData')
                ? maskContainer(item)
                : visit(
                    safeItem,
                    credentialName,
                    (name === 'stdout' || name === 'stderr') && typeof command === 'string' && isSecretRead(command)
                      ? command
                      : null,
                    kind === 'SecretList' && name === 'items',
                  ),
            ]
          }),
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
      sanitized = sanitizeAuditPayload(payload, event === 'process_output', context?.tool)
      budget = auditPayloadBudget(sanitized.payload)
    } catch {
      budget = { ...sourceBudget, accepted: false, reason: 'credential_capture_unavailable' }
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
