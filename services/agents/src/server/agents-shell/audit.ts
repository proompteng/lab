import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'

export type ToolAuditContext = { requestId: string; toolCallId: string; tool: string }

export const toolAuditContext = new AsyncLocalStorage<ToolAuditContext>()

const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|apikey|accesskey|privatekey|credential)s?$/i
const SECRET_OPTION =
  /^(?:--?[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credential|authorization)[\w-]*|-[up]|--user)$/i
const OMITTED_BODY = /^(?:patch|content|task|acceptanceCriteria|stdin|payload|_meta)$/i
const MAX_PAYLOAD_BYTES = 12_000
const MAX_FIELD_BYTES = 4_000
const PRIVATE_KUBERNETES_KIND = /(?:^|[{\s,])["']?kind["']?\s*:\s*["']?((?:Secret|AgentRun)(?:List)?)["']?(?=[\s,}]|$)/i
const PRIVATE_KUBERNETES_RESOURCE = /\b(secrets?|sec|agentruns?)(?=[\s/.,"';]|$)/i

const bodyOmission = (kind: unknown) => {
  switch (typeof kind === 'string' ? kind.toLowerCase() : '') {
    case 'secret':
    case 'secrets':
    case 'secretlist':
    case 'sec':
      return '[OMITTED_KUBERNETES_SECRET]'
    case 'agentrun':
    case 'agentruns':
    case 'agentrunlist':
      return '[OMITTED_AGENT_RUN]'
    default:
      return undefined
  }
}

const redactText = (value: string, secrets: string[]) => {
  const omitted = bodyOmission(value.match(PRIVATE_KUBERNETES_KIND)?.[1])
  if (omitted) return omitted
  let text = value
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]')
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, '[REDACTED]')
    .replace(/((?:authorization|(?:set-)?cookie)\s*:\s*)[^"'\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/[^\s"'<>]+/gi, '[REDACTED_CONNECTION]')
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
      '[REDACTED]',
    )
    .replace(
      /((?:^|[\s"'({,;])[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credential|authorization|cookie)[\w-]*["']?\s*(?:[:=]\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:^|\s)(?:-[up]\s*|--user(?:=|\s+)))(?:"[^"]*"|'[^']*'|[^\s;]+)/g, '$1[REDACTED]')
    .replace(/(^|[^A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '$1[REDACTED_EMAIL]')
}

export const sanitizeAuditPayload = (payload: Record<string, unknown>) => {
  const secrets = Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|DB_URL|CONNECTION_STRING)/i.test(
          key,
        ) &&
        value &&
        value.length >= 4,
    )
    .flatMap(([, value]) => (value ? [value, encodeURIComponent(value)] : []))
    .sort((a, b) => b.length - a.length)
  let remaining = MAX_PAYLOAD_BYTES
  let truncated = false
  const sanitize = (value: unknown, depth: number): unknown => {
    if (remaining <= 0 || depth > 4) {
      truncated = true
      return '[TRUNCATED]'
    }
    if (typeof value === 'string') {
      const text = redactText(value, secrets)
      const limit = Math.min(remaining, MAX_FIELD_BYTES)
      let end = text.length
      if (Buffer.byteLength(JSON.stringify(text)) > limit) {
        truncated = true
        let low = 0
        let high = end
        while (low < high) {
          const mid = Math.ceil((low + high) / 2)
          if (Buffer.byteLength(JSON.stringify(`${text.slice(0, mid)}[TRUNCATED]`)) <= limit) low = mid
          else high = mid - 1
        }
        end = low
      }
      const result = end < text.length ? `${text.slice(0, end)}[TRUNCATED]` : text
      remaining -= Buffer.byteLength(JSON.stringify(result))
      return result
    }
    if (Array.isArray(value)) {
      const result: unknown[] = []
      let redactNext = false
      for (const item of value.slice(0, 20)) {
        if (remaining <= 0) break
        result.push(sanitize(redactNext ? '[REDACTED]' : item, depth + 1))
        redactNext = typeof item === 'string' && SECRET_OPTION.test(item)
      }
      if (result.length < value.length) truncated = true
      return result
    }
    if (value !== null && typeof value === 'object') {
      const omitted = 'kind' in value ? bodyOmission(value.kind) : undefined
      if (omitted) return omitted
      const omittedOutput =
        'command' in value && typeof value.command === 'string' && /\bkubectl\b/.test(value.command)
          ? bodyOmission(value.command.match(PRIVATE_KUBERNETES_RESOURCE)?.[1])
          : undefined
      const result: Record<string, unknown> = {}
      const entries = Object.entries(value)
      for (const [key, item] of entries.slice(0, 30)) {
        if (remaining <= 0) break
        const loggedKey = redactText(key, secrets).slice(0, 128)
        remaining -= Buffer.byteLength(JSON.stringify(loggedKey)) + 1
        result[loggedKey] = SECRET_KEY.test(key.replaceAll(/[^a-z]/gi, ''))
          ? '[REDACTED]'
          : OMITTED_BODY.test(key)
            ? '[OMITTED]'
            : omittedOutput && (key === 'stdout' || key === 'stderr')
              ? omittedOutput
              : sanitize(item, depth + 1)
      }
      if (Object.keys(result).length < entries.length) truncated = true
      return result
    }
    remaining -= 8
    return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : null
  }
  const result = sanitize(payload, 0)
  return { payload: result, payloadTruncated: truncated }
}

export const writeAuditLog = (
  config: AgentsShellConfig,
  event: string,
  auth: AuthContext | null,
  payload: Record<string, unknown>,
  context = toolAuditContext.getStore() ?? null,
) => {
  const sanitized = sanitizeAuditPayload(payload)
  const line = JSON.stringify({
    msg: 'agents-shell audit',
    schemaVersion: 1,
    ts: new Date().toISOString(),
    event,
    ...context,
    subjectHash: auth?.subject ? createHash('sha256').update(auth.subject).digest('hex') : null,
    ...sanitized,
  })
  try {
    console.log(line)
  } catch {
    console.warn('[agents-shell] stdout audit write failed')
  }
  if (!config.auditLogPath) return
  try {
    mkdirSync(dirname(config.auditLogPath), { recursive: true })
    appendFileSync(config.auditLogPath, `${line}\n`)
  } catch {
    console.warn('[agents-shell] file audit write failed')
  }
}
