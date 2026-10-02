import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'

export type ToolAuditContext = { requestId: string; toolCallId: string; tool: string }

export const toolAuditContext = new AsyncLocalStorage<ToolAuditContext>()

const MAX_PAYLOAD_BYTES = 12_000
const OMITTED_FIELDS = new Set([
  'arguments',
  'args',
  'command',
  'stdout',
  'stderr',
  'content',
  'path',
  'cwd',
  'changedFiles',
  'branch',
  'baseBranch',
  'headBranch',
  'worktree',
  'agentRunName',
  'task',
  'acceptanceCriteria',
  'patch',
  'stdin',
  '_meta',
])
const NUMBER_FIELDS = new Set([
  'durationMs',
  'exitCode',
  'timeoutSeconds',
  'stdoutBytes',
  'stderrBytes',
  'bytes',
  'ahead',
  'behind',
  'stdoutRetentionStartByte',
  'stderrRetentionStartByte',
  'stdoutNextOffset',
  'stderrNextOffset',
])
const BOOLEAN_FIELDS = new Set([
  'authorized',
  'ok',
  'timedOut',
  'stdoutTruncated',
  'stderrTruncated',
  'truncated',
  'dirty',
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OUTCOMES = new Set(['succeeded', 'failed', 'running', 'error'])
const STATUSES = new Set(['running', 'exited', 'killed', 'timed_out'])

export const sanitizeAuditPayload = (payload: Record<string, unknown>) => {
  let remaining = MAX_PAYLOAD_BYTES
  let truncated = false
  const charge = (value: unknown) => {
    remaining -= Buffer.byteLength(JSON.stringify(value))
    return value
  }
  const metadata = (value: Record<string, unknown>, depth: number): Record<string, unknown> => {
    if (depth > 4 || remaining <= 0) {
      truncated = true
      return {}
    }
    const result: Record<string, unknown> = {}
    const entries = Object.entries(value)
    for (const [key, item] of entries.slice(0, 30)) {
      if (remaining <= 0) {
        truncated = true
        break
      }
      let retained: unknown
      if (OMITTED_FIELDS.has(key)) retained = '[OMITTED]'
      else if (NUMBER_FIELDS.has(key) && (item === null || (typeof item === 'number' && Number.isFinite(item))))
        retained = item
      else if (BOOLEAN_FIELDS.has(key) && typeof item === 'boolean') retained = item
      else if (key === 'result' && item !== null && typeof item === 'object' && !Array.isArray(item))
        retained = metadata(item as Record<string, unknown>, depth + 1)
      else if (key === 'jobs' && Array.isArray(item)) {
        retained = item
          .slice(0, 20)
          .flatMap((job) =>
            job !== null && typeof job === 'object' && !Array.isArray(job)
              ? [metadata(job as Record<string, unknown>, depth + 1)]
              : [],
          )
        if (item.length > 20) truncated = true
      } else if (typeof item === 'string') {
        if ((key === 'jobId' || key === 'sessionId') && UUID.test(item)) retained = item
        else if ((key === 'baseSha' || key === 'headSha') && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(item))
          retained = item
        else if (key === 'outcome' && OUTCOMES.has(item)) retained = item
        else if (key === 'status' && STATUSES.has(item)) retained = item
        else if (key === 'signal' && /^SIG[A-Z0-9]{1,8}$/.test(item)) retained = item
        else if (
          /^(?:startedAt|finishedAt|createdAt|closedAt)$/.test(key) &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) &&
          Number.isFinite(Date.parse(item))
        )
          retained = item
      } else if (item === null && (key === 'signal' || key === 'finishedAt')) retained = null
      if (retained !== undefined) {
        charge(key)
        result[key] = key === 'result' || key === 'jobs' ? retained : charge(retained)
      }
    }
    if (entries.length > 30) truncated = true
    return result
  }
  return { payload: metadata(payload, 0), payloadTruncated: truncated }
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
