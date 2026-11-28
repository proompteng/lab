import { createHash, randomUUID } from 'node:crypto'

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { asRecord } from '../server/primitives'
import { COLAB_DISCOVERY_TIMEOUT_MS } from './config'
import { ColabError } from './errors'
import { creationRejected, toolPayload, type ColabUpstream, type UpstreamContext } from './upstream'

const MAX_RUNTIME_ID_LENGTH = 63
const OWNER_PREFIX_RE = /^run-[0-9a-f]{12}-/
const OWNED_RUNTIME_SUFFIX_RE = /^[a-z0-9][a-z0-9-]*$/
const SESSION_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const runtimeIdSchema = z.string().regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
const runtimeNameSchema = z
  .string()
  .startsWith('runtimes/')
  .min('runtimes/'.length + 1)
const createArgsSchema = z.strictObject({
  runtime: z.record(z.string(), z.unknown()),
  runtimeId: runtimeIdSchema.optional(),
  requestId: z.uuidv4().optional(),
})
const admissionRuntimeListSchema = z.union([
  z.strictObject({ runtimes: z.array(z.object({ name: runtimeNameSchema })) }),
  z.strictObject({}), // Protobuf JSON may omit an empty repeated field.
])

const GLOBAL_READ_TOOLS = new Set(['list_runtime_specs', 'get_subscription'])
const RUNTIME_TARGET_KEYS = ['name', 'runtime', 'runtimeName', 'runtime_name'] as const
const RUNTIME_PARENT_KEYS = ['parent', 'runtime', 'name', 'runtimeName', 'runtime_name'] as const
const SESSION_RUNTIME_KEYS = ['parent', 'runtime', 'runtimeName', 'runtime_name'] as const
const SESSION_REF_KEYS = ['name', 'session', 'sessionName', 'session_name'] as const
const SESSION_ID_KEYS = ['sessionId', 'session_id'] as const
const DISALLOWED_RUNTIME_ID_KEYS = ['runtimeId', 'runtime_id'] as const

const ALLOWED_LIST_TOP_KEYS = new Set(['runtimes', 'nextPageToken', 'next_page_token', 'unreachable'])
const REDACTED_KEYS = new Set([
  'connectioninfo',
  'connection_info',
  'token',
  'proxytoken',
  'proxy_token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'authheader',
  'auth_header',
  'credentials',
])

type Reservation = {
  phase: 'creating' | 'unobserved'
  requestId: string
  runtimeSpec: string
  caller: string
}

const forbidden = () =>
  new ColabError('colab_runtime_forbidden', 'Access denied: Colab resources are scoped to the owning AgentRun.')

const requireCaller = (caller: string): string => {
  const normalized = caller.trim()
  if (!normalized) {
    throw new ColabError('colab_caller_required', 'A verified AgentRun caller identity is required.')
  }
  return normalized
}

export const ownerPrefix = (caller: string): string => {
  const normalized = requireCaller(caller)
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  return `run-${digest}-`
}

export const isOwnedRuntimeName = (resourceName: string, caller: string): boolean => {
  const normalized = caller.trim()
  if (!normalized) return false
  const prefix = `runtimes/${ownerPrefix(normalized)}`
  if (!resourceName.startsWith(prefix)) return false
  return OWNED_RUNTIME_SUFFIX_RE.test(resourceName.slice(prefix.length))
}

const isSafeSessionSegment = (segment: string): boolean => SESSION_SEGMENT_RE.test(segment) && !segment.includes('..')

export const isOwnedSessionName = (resourceName: string, caller: string): boolean => {
  const normalized = caller.trim()
  if (!normalized) return false
  const parts = resourceName.split('/')
  if (parts.length !== 4 || parts[0] !== 'runtimes' || parts[2] !== 'sessions') return false
  const runtimeResource = `${parts[0]}/${parts[1]}`
  const sessionId = parts[3] ?? ''
  return isOwnedRuntimeName(runtimeResource, normalized) && isSafeSessionSegment(sessionId)
}

export const isOwnedSessionOrRuntimeRef = (ref: string, caller: string): boolean =>
  isOwnedRuntimeName(ref, caller) || isOwnedSessionName(ref, caller)

export const scopeRuntimeId = (requestedId: string | undefined, requestId: string, caller: string): string => {
  const prefix = ownerPrefix(caller)
  if (!requestedId) return `${prefix}${requestId}`
  if (requestedId.startsWith(prefix)) {
    if (!isOwnedRuntimeName(`runtimes/${requestedId}`, caller)) throw forbidden()
    return requestedId
  }
  if (OWNER_PREFIX_RE.test(requestedId)) throw forbidden()
  const maxSuffixLength = MAX_RUNTIME_ID_LENGTH - prefix.length
  if (requestedId.length <= maxSuffixLength) return `${prefix}${requestedId}`
  const hash = createHash('sha256').update(requestedId).digest('hex').slice(0, 8)
  const head = requestedId.slice(0, maxSuffixLength - hash.length - 1).replace(/-+$/, '')
  return `${prefix}${head}-${hash}`
}

const hasOwnDefined = (record: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(record, key) && record[key] !== undefined

const forbidKeys = (args: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    if (hasOwnDefined(args, key)) throw forbidden()
  }
}

const readSingleConsistentString = (args: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  let found: string | undefined
  for (const key of keys) {
    if (!hasOwnDefined(args, key)) continue
    const value = args[key]
    if (typeof value !== 'string') throw forbidden()
    if (found !== undefined && found !== value) throw forbidden()
    found = value
  }
  return found
}

const requireOwnedRuntimeTarget = (args: Record<string, unknown>, caller: string): string => {
  forbidKeys(args, [
    ...DISALLOWED_RUNTIME_ID_KEYS,
    'parent',
    'session',
    'sessionName',
    'session_name',
    ...SESSION_ID_KEYS,
  ])
  const target = readSingleConsistentString(args, RUNTIME_TARGET_KEYS)
  if (!target || !isOwnedRuntimeName(target, caller)) throw forbidden()
  return target
}

const requireOwnedRuntimeParent = (args: Record<string, unknown>, caller: string, allowSessionFields: boolean) => {
  if (allowSessionFields) {
    forbidKeys(args, [...DISALLOWED_RUNTIME_ID_KEYS, 'sessionName', 'session_name'])
  } else {
    forbidKeys(args, [...DISALLOWED_RUNTIME_ID_KEYS, 'session', 'sessionName', 'session_name', ...SESSION_ID_KEYS])
  }
  const parent = readSingleConsistentString(args, RUNTIME_PARENT_KEYS)
  if (!parent || !isOwnedRuntimeName(parent, caller)) throw forbidden()
  if (!allowSessionFields) return parent

  if (hasOwnDefined(args, 'session')) {
    if (typeof args.session === 'string') {
      if (!isOwnedSessionName(args.session, caller) || !args.session.startsWith(`${parent}/sessions/`)) {
        throw forbidden()
      }
    } else {
      const sessionObj = asRecord(args.session)
      if (!sessionObj) throw forbidden()
      if (hasOwnDefined(sessionObj, 'name')) {
        if (
          typeof sessionObj.name !== 'string' ||
          !isOwnedSessionName(sessionObj.name, caller) ||
          !sessionObj.name.startsWith(`${parent}/sessions/`)
        ) {
          throw forbidden()
        }
      }
      for (const key of ['parent', 'runtime', 'runtimeName', 'runtime_name']) {
        if (hasOwnDefined(sessionObj, key) && sessionObj[key] !== parent) throw forbidden()
      }
    }
  }
  const sessionId = readSingleConsistentString(args, SESSION_ID_KEYS)
  if (sessionId !== undefined && !isSafeSessionSegment(sessionId)) throw forbidden()
  return parent
}

const validateSessionToolArgs = (
  args: Record<string, unknown>,
  caller: string,
  options: { requireSession: boolean },
) => {
  forbidKeys(args, DISALLOWED_RUNTIME_ID_KEYS)
  const runtimeRef = readSingleConsistentString(args, SESSION_RUNTIME_KEYS)
  if (runtimeRef !== undefined && !isOwnedRuntimeName(runtimeRef, caller)) throw forbidden()
  const targetRef = readSingleConsistentString(args, SESSION_REF_KEYS)
  const sessionId = readSingleConsistentString(args, SESSION_ID_KEYS)
  if (sessionId !== undefined && !isSafeSessionSegment(sessionId)) throw forbidden()

  if (targetRef !== undefined) {
    if (isOwnedSessionName(targetRef, caller)) {
      if (runtimeRef !== undefined && !targetRef.startsWith(`${runtimeRef}/sessions/`)) throw forbidden()
      if (sessionId !== undefined && targetRef.split('/')[3] !== sessionId) throw forbidden()
      return
    }
    if (!options.requireSession && isOwnedRuntimeName(targetRef, caller)) {
      if (hasOwnDefined(args, 'session') || hasOwnDefined(args, 'sessionName') || hasOwnDefined(args, 'session_name')) {
        throw forbidden()
      }
      if (runtimeRef !== undefined && targetRef !== runtimeRef) throw forbidden()
      return
    }
    if (runtimeRef !== undefined && isSafeSessionSegment(targetRef)) {
      if (hasOwnDefined(args, 'name')) throw forbidden()
      if (sessionId !== undefined && sessionId !== targetRef) throw forbidden()
      return
    }
    throw forbidden()
  }

  if (runtimeRef === undefined) throw forbidden()
  if (options.requireSession && sessionId === undefined) throw forbidden()
}

const redactSensitiveFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSensitiveFields)
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(key.toLowerCase())) continue
      sanitized[key] = redactSensitiveFields(entry)
    }
    return sanitized
  }
  return value
}

const assertReturnedRuntimeOwned = (payload: unknown, caller: string, allowNonRuntimeName = false) => {
  const record = asRecord(payload)
  if (!record) return
  if (typeof record.name === 'string') {
    if ((!allowNonRuntimeName || record.name.startsWith('runtimes/')) && !isOwnedRuntimeName(record.name, caller)) {
      throw forbidden()
    }
  }
  const nested = asRecord(record.runtime)
  if (nested && typeof nested.name === 'string' && !isOwnedRuntimeName(nested.name, caller)) throw forbidden()
}

const filterOwnedRuntimeListPayload = (payload: unknown, caller: string): Record<string, unknown> => {
  const record = asRecord(payload)
  if (!record) throw new ColabError('colab_runtime_list_invalid', 'Could not filter Colab runtime list.')
  for (const key of Object.keys(record)) {
    if (!ALLOWED_LIST_TOP_KEYS.has(key)) {
      throw new ColabError('colab_runtime_list_invalid', 'Could not filter Colab runtime list.')
    }
  }
  const sanitized: Record<string, unknown> = {}
  if (record.runtimes !== undefined) {
    if (!Array.isArray(record.runtimes)) {
      throw new ColabError('colab_runtime_list_invalid', 'Could not filter Colab runtime list.')
    }
    const owned: unknown[] = []
    for (const item of record.runtimes) {
      const runtime = asRecord(item)
      if (!runtime || typeof runtime.name !== 'string') {
        throw new ColabError('colab_runtime_list_invalid', 'Could not filter Colab runtime list.')
      }
      if (isOwnedRuntimeName(runtime.name, caller)) {
        owned.push(redactSensitiveFields(runtime))
      }
    }
    sanitized.runtimes = owned
  }
  if (record.nextPageToken !== undefined) {
    if (typeof record.nextPageToken !== 'string') {
      throw new ColabError('colab_runtime_list_invalid', 'Could not filter Colab runtime list.')
    }
    sanitized.nextPageToken = record.nextPageToken
  }
  if (record.next_page_token !== undefined) {
    if (typeof record.next_page_token !== 'string') {
      throw new ColabError('colab_runtime_list_invalid', 'Could not filter Colab runtime list.')
    }
    sanitized.next_page_token = record.next_page_token
  }
  if (record.unreachable !== undefined) {
    if (!Array.isArray(record.unreachable) || !record.unreachable.every((entry) => typeof entry === 'string')) {
      throw new ColabError('colab_runtime_list_invalid', 'Could not filter Colab runtime list.')
    }
    sanitized.unreachable = record.unreachable.filter((entry) => isOwnedRuntimeName(entry, caller))
  }
  return sanitized
}

const sanitizeRuntimeResult = (
  result: CallToolResult,
  caller: string,
  options: { enforceOwnedName?: boolean; allowNonRuntimeName?: boolean } = {},
): CallToolResult => {
  const structuredContent =
    result.structuredContent !== undefined
      ? (() => {
          if (!result.isError && options.enforceOwnedName) {
            assertReturnedRuntimeOwned(result.structuredContent, caller, options.allowNonRuntimeName)
          }
          return redactSensitiveFields(result.structuredContent) as Record<string, unknown>
        })()
      : undefined
  const content = result.content.map((block) => {
    if (block.type !== 'text') {
      if (result.isError) return block
      throw new ColabError('colab_runtime_response_invalid', 'Could not sanitize Colab runtime response.')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(block.text)
    } catch {
      if (result.isError) return block
      throw new ColabError('colab_runtime_response_invalid', 'Could not sanitize Colab runtime response.')
    }
    if (!result.isError && options.enforceOwnedName) {
      assertReturnedRuntimeOwned(parsed, caller, options.allowNonRuntimeName)
    }
    return { ...block, text: JSON.stringify(redactSensitiveFields(parsed)) }
  })
  const sanitized: CallToolResult = { ...result, content }
  if (structuredContent !== undefined) sanitized.structuredContent = structuredContent
  if (result._meta !== undefined) sanitized._meta = redactSensitiveFields(result._meta) as Record<string, unknown>
  return sanitized
}

const sanitizeListRuntimesResult = (result: CallToolResult, caller: string): CallToolResult => {
  if (result.isError) return sanitizeRuntimeResult(result, caller)
  if (result.structuredContent === undefined && result.content.length === 0) {
    throw new ColabError('colab_runtime_list_invalid', 'Could not filter Colab runtime list.')
  }
  const structuredContent =
    result.structuredContent !== undefined ? filterOwnedRuntimeListPayload(result.structuredContent, caller) : undefined
  const content = result.content.map((block) => {
    if (block.type !== 'text') {
      throw new ColabError('colab_runtime_list_invalid', 'Could not filter Colab runtime list.')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(block.text)
    } catch {
      throw new ColabError('colab_runtime_list_invalid', 'Could not filter Colab runtime list.')
    }
    return { ...block, text: JSON.stringify(filterOwnedRuntimeListPayload(parsed, caller)) }
  })
  const sanitized: CallToolResult = { ...result, content }
  if (structuredContent !== undefined) sanitized.structuredContent = structuredContent
  if (result._meta !== undefined) sanitized._meta = redactSensitiveFields(result._meta) as Record<string, unknown>
  return sanitized
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const createColabRuntimePolicy = (upstream: ColabUpstream, maxConcurrentRuntimes: number) => {
  // Keep reservations after the call returns until Google lists the runtime or confirms a rejection.
  const reservations = new Map<string, Reservation>()
  let admission = Promise.resolve()

  return async (name: string, args: Record<string, unknown>, context: UpstreamContext, caller = '') => {
    const normalizedCaller = requireCaller(caller)

    if (GLOBAL_READ_TOOLS.has(name)) {
      const token = await upstream.getToken()
      return upstream.callTool(name, args, token, context)
    }

    if (name === 'list_runtimes') {
      const token = await upstream.getToken()
      const result = await upstream.callTool(name, args, token, context)
      return sanitizeListRuntimesResult(result, normalizedCaller)
    }

    if (name === 'get_runtime') {
      requireOwnedRuntimeTarget(args, normalizedCaller)
      const token = await upstream.getToken()
      const result = await upstream.callTool(name, args, token, context)
      return sanitizeRuntimeResult(result, normalizedCaller, { enforceOwnedName: true })
    }

    if (name === 'delete_runtime') {
      const targetRuntime = requireOwnedRuntimeTarget(args, normalizedCaller)
      const token = await upstream.getToken()
      const result = await upstream.callTool(name, args, token, context)
      const reservation = reservations.get(targetRuntime)
      if (
        !result.isError &&
        reservation?.phase === 'unobserved' &&
        reservation.caller === normalizedCaller &&
        !args.allowMissing &&
        !args.allow_missing
      ) {
        reservations.delete(targetRuntime)
      }
      return result
    }

    if (name === 'list_sessions' || name === 'create_session') {
      requireOwnedRuntimeParent(args, normalizedCaller, name === 'create_session')
      const token = await upstream.getToken()
      const result = await upstream.callTool(name, args, token, context)
      return sanitizeRuntimeResult(result, normalizedCaller)
    }

    if (name === 'delete_session' || name === 'execute_code') {
      validateSessionToolArgs(args, normalizedCaller, { requireSession: name === 'delete_session' })
      const token = await upstream.getToken()
      return upstream.callTool(name, args, token, context)
    }

    if (name !== 'create_runtime') {
      throw new ColabError('colab_tool_not_allowed', `Colab tool "${name}" is not allowed.`)
    }

    const parsed = createArgsSchema.safeParse(args)
    if (!parsed.success) throw new ColabError('colab_invalid_runtime_arguments', 'Invalid create_runtime arguments.')
    const requestId = parsed.data.requestId?.toLowerCase() ?? randomUUID()
    const id = scopeRuntimeId(parsed.data.runtimeId, requestId, normalizedCaller)
    const resource = `runtimes/${id}`
    if (hasOwnDefined(parsed.data.runtime, 'name') && parsed.data.runtime.name !== resource) {
      throw forbidden()
    }
    const runtimeSpec = canonicalJson(parsed.data.runtime)
    const token = await upstream.getToken()
    let isRetry = false
    const check = admission.then(async () => {
      context.signal.throwIfAborted()
      const list = await upstream.callTool('list_runtimes', {}, token, context, COLAB_DISCOVERY_TIMEOUT_MS)
      const payload = admissionRuntimeListSchema.safeParse(toolPayload(list))
      if (list.isError || !payload.success) {
        throw new ColabError('colab_runtime_count_unavailable', 'Could not verify the current Colab runtime count.')
      }
      const active = new Set('runtimes' in payload.data ? payload.data.runtimes.map((runtime) => runtime.name) : [])
      const existing = reservations.get(resource)
      const matchingRetry =
        existing !== undefined &&
        existing.phase === 'unobserved' &&
        existing.requestId === requestId &&
        existing.runtimeSpec === runtimeSpec &&
        existing.caller === normalizedCaller
      let unlisted = 0
      for (const [reserved, entry] of reservations) {
        if (!active.has(reserved)) unlisted++
        else if (entry.phase === 'unobserved' && !(reserved === resource && matchingRetry)) {
          reservations.delete(reserved)
        }
      }
      if (!matchingRetry) {
        if (active.has(resource) || reservations.has(resource)) {
          throw new ColabError(
            'colab_runtime_already_reserved',
            'That Colab runtime already exists or is being created.',
          )
        }
        if (active.size + unlisted >= maxConcurrentRuntimes) {
          throw new ColabError(
            'colab_runtime_limit_reached',
            `Colab allows at most ${maxConcurrentRuntimes} concurrent runtimes. Reuse an active runtime or call delete_runtime first.`,
          )
        }
      }
      context.signal.throwIfAborted()
      isRetry = matchingRetry
      reservations.set(resource, { phase: 'creating', requestId, runtimeSpec, caller: normalizedCaller })
    })
    // Only admission takes the lock. The slow creates can run concurrently up to the available slots.
    admission = check.then(
      () => undefined,
      () => undefined,
    )
    await check

    let rejected = false
    let result: CallToolResult
    try {
      result = await upstream.callTool(name, { ...parsed.data, requestId, runtimeId: id }, token, context)
      // A retry rejection (e.g. HTTP 429/401 or error) does not cancel an original in-flight creation at Google;
      // retain the uncertain reservation so the concurrency cap cannot be exceeded.
      rejected = !isRetry && result.isError === true && creationRejected(toolPayload(result))
    } catch (error) {
      if (error instanceof ColabError && error.creationRejected) {
        rejected = !isRetry
        throw error
      }
      throw new ColabError(
        'colab_runtime_creation_unconfirmed',
        `Colab did not confirm creation of ${resource}. Check list_runtimes before trying again.`,
      )
    } finally {
      if (rejected) reservations.delete(resource)
      else reservations.set(resource, { phase: 'unobserved', requestId, runtimeSpec, caller: normalizedCaller })
    }
    return sanitizeRuntimeResult(result, normalizedCaller, { enforceOwnedName: true, allowNonRuntimeName: true })
  }
}
