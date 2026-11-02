import {
  buildAgentsServiceUrl,
  fetchAgentsJsonEffect,
  postAgentsJsonEffect,
  runAgentsJsonPromise,
  servicePath,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

export type { AgentsServiceJsonResult } from './agents-http'

export const DEFAULT_MEMORY_NOTE_NAMESPACE = 'default'
export const DEFAULT_MEMORY_NOTE_LIMIT = 10

export const MAX_MEMORY_NOTE_CONTENT_CHARS = 50_000
export const MAX_MEMORY_NOTE_QUERY_CHARS = 10_000
export const MAX_MEMORY_NOTE_SUMMARY_CHARS = 5_000
export const MAX_MEMORY_NOTE_NAMESPACE_CHARS = 200
export const MAX_MEMORY_NOTE_TAGS = 50

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

type ParseLimitInput = unknown

const clampMemoryNoteLimit = (value: ParseLimitInput, fallback = DEFAULT_MEMORY_NOTE_LIMIT) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(50, Math.floor(value)))
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(50, parsed))
    }
  }
  return Math.max(1, Math.min(50, fallback))
}

export const normalizeMemoryNoteNamespace = (namespace: unknown) => {
  const raw = typeof namespace === 'string' ? namespace.trim() : ''
  const resolved = raw.length > 0 ? raw : DEFAULT_MEMORY_NOTE_NAMESPACE
  return resolved.slice(0, MAX_MEMORY_NOTE_NAMESPACE_CHARS)
}

export const normalizeOptionalMemoryNoteNamespace = (namespace: unknown) => {
  const raw = typeof namespace === 'string' ? namespace.trim() : ''
  return raw.length > 0 ? raw.slice(0, MAX_MEMORY_NOTE_NAMESPACE_CHARS) : undefined
}

export const normalizeMemoryNoteTags = (tags: unknown): string[] => {
  if (!Array.isArray(tags)) return []
  return tags
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, MAX_MEMORY_NOTE_TAGS)
}

export const normalizeMemoryNoteMetadata = (metadata: unknown): Record<string, unknown> | undefined => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined
  }
  return metadata as Record<string, unknown>
}

export type AgentsMemoryNoteRecord = {
  id: string
  namespace: string
  content: string
  summary: string | null
  tags: string[]
  metadata: Record<string, unknown>
  createdAt: string
  distance?: number
}

export type AgentsPersistMemoryNoteInput = {
  namespace?: string
  content: string
  summary?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
}

export type AgentsRetrieveMemoryNotesInput = {
  namespace?: string
  query: string
  limit?: number
}

export type AgentsMemoryNotesStatsInput = {
  namespace?: string
  days?: number
  topNamespaces?: number
}

export type AgentsMemoryNotesStats = {
  range: {
    days: number
    from: string
    to: string
  }
  byDay: { day: string; count: number }[]
  topNamespaces: { namespace: string; count: number }[]
}

export type AgentsPersistMemoryNoteResult = {
  ok: boolean
  memory?: AgentsMemoryNoteRecord
}

export type AgentsRetrieveMemoryNotesResult = {
  ok: boolean
  memories?: AgentsMemoryNoteRecord[]
}

export type AgentsMemoryNotesCountResult = {
  ok: boolean
  count: number
}

export type AgentsMemoryNotesStatsResult = AgentsMemoryNotesStats & {
  ok: boolean
}

export const parsePersistMemoryNoteInput = (
  payload: Record<string, unknown>,
): ValidationResult<AgentsPersistMemoryNoteInput> => {
  const content = typeof payload.content === 'string' ? payload.content.trim() : ''
  if (!content) return { ok: false, message: 'Content is required.' }
  if (content.length > MAX_MEMORY_NOTE_CONTENT_CHARS) {
    return { ok: false, message: `Content is too large (max ${MAX_MEMORY_NOTE_CONTENT_CHARS} chars).` }
  }

  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : null
  if (summary && summary.length > MAX_MEMORY_NOTE_SUMMARY_CHARS) {
    return { ok: false, message: `Summary is too large (max ${MAX_MEMORY_NOTE_SUMMARY_CHARS} chars).` }
  }

  return {
    ok: true,
    value: {
      namespace: normalizeMemoryNoteNamespace(payload.namespace),
      content,
      summary,
      tags: normalizeMemoryNoteTags(payload.tags),
      metadata: normalizeMemoryNoteMetadata(payload.metadata),
    },
  }
}

export const parseRetrieveMemoryNotesInput = (
  payload: Record<string, unknown>,
  fallbackLimit = DEFAULT_MEMORY_NOTE_LIMIT,
): ValidationResult<AgentsRetrieveMemoryNotesInput> => {
  const query = typeof payload.query === 'string' ? payload.query.trim() : ''
  if (!query) return { ok: false, message: 'Query is required.' }
  if (query.length > MAX_MEMORY_NOTE_QUERY_CHARS) {
    return { ok: false, message: `Query is too large (max ${MAX_MEMORY_NOTE_QUERY_CHARS} chars).` }
  }

  return {
    ok: true,
    value: {
      namespace: normalizeOptionalMemoryNoteNamespace(payload.namespace),
      query,
      limit: clampMemoryNoteLimit(payload.limit, fallbackLimit),
    },
  }
}

const appendOptionalMemoryNoteNamespace = (targetUrl: URL, namespace: string | null | undefined) => {
  const normalized = namespace?.trim()
  if (normalized) targetUrl.searchParams.set('namespace', normalized)
}

export const persistMemoryNoteToAgentsServiceEffect = (
  input: AgentsPersistMemoryNoteInput,
  env: EnvSource = process.env,
) =>
  postAgentsJsonEffect<AgentsPersistMemoryNoteResult>('/v1/memory-notes', input, {
    env,
  })

export const persistMemoryNoteToAgentsService = async (
  input: AgentsPersistMemoryNoteInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsPersistMemoryNoteResult>> =>
  runAgentsJsonPromise(persistMemoryNoteToAgentsServiceEffect(input, env))

export const retrieveMemoryNotesFromAgentsServiceEffect = (
  input: AgentsRetrieveMemoryNotesInput,
  env: EnvSource = process.env,
) => {
  const targetUrl = buildAgentsServiceUrl('/v1/memory-notes', env)
  targetUrl.searchParams.set('query', input.query)
  if (input.limit && input.limit > 0) targetUrl.searchParams.set('limit', String(Math.trunc(input.limit)))
  appendOptionalMemoryNoteNamespace(targetUrl, input.namespace)
  return fetchAgentsJsonEffect<AgentsRetrieveMemoryNotesResult>(servicePath(targetUrl), env)
}

export const retrieveMemoryNotesFromAgentsService = async (
  input: AgentsRetrieveMemoryNotesInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsRetrieveMemoryNotesResult>> =>
  runAgentsJsonPromise(retrieveMemoryNotesFromAgentsServiceEffect(input, env))

export const countMemoryNotesFromAgentsServiceEffect = (
  input: { namespace?: string | null } = {},
  env: EnvSource = process.env,
) => {
  const targetUrl = buildAgentsServiceUrl('/v1/memory-notes/count', env)
  appendOptionalMemoryNoteNamespace(targetUrl, input.namespace)
  return fetchAgentsJsonEffect<AgentsMemoryNotesCountResult>(servicePath(targetUrl), env)
}

export const countMemoryNotesFromAgentsService = async (
  input: { namespace?: string | null } = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsMemoryNotesCountResult>> =>
  runAgentsJsonPromise(countMemoryNotesFromAgentsServiceEffect(input, env))

export const fetchMemoryNotesStatsFromAgentsServiceEffect = (
  input: AgentsMemoryNotesStatsInput = {},
  env: EnvSource = process.env,
) => {
  const targetUrl = buildAgentsServiceUrl('/v1/memory-notes/stats', env)
  appendOptionalMemoryNoteNamespace(targetUrl, input.namespace)
  if (input.days && input.days > 0) targetUrl.searchParams.set('days', String(Math.trunc(input.days)))
  if (input.topNamespaces && input.topNamespaces > 0) {
    targetUrl.searchParams.set('topNamespaces', String(Math.trunc(input.topNamespaces)))
  }
  return fetchAgentsJsonEffect<AgentsMemoryNotesStatsResult>(servicePath(targetUrl), env)
}

export const fetchMemoryNotesStatsFromAgentsService = async (
  input: AgentsMemoryNotesStatsInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsMemoryNotesStatsResult>> =>
  runAgentsJsonPromise(fetchMemoryNotesStatsFromAgentsServiceEffect(input, env))

export type AgentsMemoryResourceInput = {
  name: string
  namespace?: string | null
}

export type AgentsMemoryResource = Record<string, unknown>

export type AgentsMemoryResourceResult = {
  ok: boolean
  kind?: 'Memory' | string | null
  namespace?: string | null
  resource?: AgentsMemoryResource | null
}

export const fetchMemoryResourceFromAgentsServiceEffect = (
  input: AgentsMemoryResourceInput,
  env: EnvSource = process.env,
) => {
  const targetUrl = buildAgentsServiceUrl('/v1/memories/resources', env)
  targetUrl.searchParams.set('name', input.name)
  const namespace = input.namespace?.trim()
  if (namespace) targetUrl.searchParams.set('namespace', namespace)
  return fetchAgentsJsonEffect<AgentsMemoryResourceResult>(servicePath(targetUrl), env)
}

export const fetchMemoryResourceFromAgentsService = async (
  input: AgentsMemoryResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsMemoryResourceResult>> =>
  runAgentsJsonPromise(fetchMemoryResourceFromAgentsServiceEffect(input, env))

export type AgentsMemoryOperation =
  | {
      operation: 'event'
      eventType: string
      payload?: Record<string, unknown>
    }
  | {
      operation: 'kv'
      key: string
      value: Record<string, unknown>
    }
  | {
      operation: 'embedding'
      key: string
      text: string
      metadata?: Record<string, unknown>
    }
  | {
      operation: 'query'
      query: string
      limit?: number | null
    }

export type AgentsMemoryOperationInput = {
  deliveryId: string
  memoryRef: string
  namespace?: string | null
  operation: AgentsMemoryOperation
}

export type AgentsMemoryOperationResult = {
  ok: boolean
  operation?: string | null
  memoryRef?: string | null
  namespace?: string | null
  results?: { key: string; score: number | null; metadata: Record<string, unknown> }[]
}

export const submitMemoryOperationToAgentsServiceEffect = (
  input: AgentsMemoryOperationInput,
  env: EnvSource = process.env,
) => {
  const payload = {
    memoryRef: input.memoryRef,
    ...(input.namespace ? { namespace: input.namespace } : {}),
    ...input.operation,
  }

  return postAgentsJsonEffect<AgentsMemoryOperationResult>('/v1/memory-operations', payload, {
    env,
    idempotencyKey: input.deliveryId,
  })
}

export const submitMemoryOperationToAgentsService = async (
  input: AgentsMemoryOperationInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsMemoryOperationResult>> =>
  runAgentsJsonPromise(submitMemoryOperationToAgentsServiceEffect(input, env))
