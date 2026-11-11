import {
  buildAgentsServiceUrl,
  fetchAgentsJsonEffect,
  postAgentsJsonEffect,
  requestAgentsJsonEffect,
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
  retiredAt: string | null
  retirementReason: string | null
  replacementId: string | null
  distance?: number
}

export type AgentsPersistMemoryNoteInput = {
  namespace?: string
  content: string
  summary?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
}

export type AgentsMemoryNoteFilters = {
  namespace?: string
  repository?: string
  tags?: string[]
  model?: string
  createdAfter?: string
  createdBefore?: string
  includeRetired?: boolean
  limit?: number
}

export type AgentsRetrieveMemoryNotesInput = AgentsMemoryNoteFilters & { query: string }
export type AgentsListMemoryNotesInput = AgentsMemoryNoteFilters
export type AgentsRetireMemoryNoteInput = { id: string; reason: string; replacementId?: string }

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

  const filters = parseMemoryNoteFilters(payload, fallbackLimit)
  return filters.ok ? { ok: true, value: { ...filters.value, query } } : filters
}

export const parseMemoryNoteFilters = (
  payload: Record<string, unknown>,
  fallbackLimit = DEFAULT_MEMORY_NOTE_LIMIT,
): ValidationResult<AgentsMemoryNoteFilters> => {
  if (
    payload.limit !== undefined &&
    ((typeof payload.limit !== 'number' && typeof payload.limit !== 'string') ||
      !/^\d+$/.test(String(payload.limit)) ||
      Number(payload.limit) < 1)
  ) {
    return { ok: false, message: 'limit must be a positive integer.' }
  }
  const dates: { createdAfter?: string; createdBefore?: string } = {}
  for (const key of ['createdAfter', 'createdBefore'] as const) {
    const raw = payload[key]
    if (raw == null || raw === '') continue
    if (
      typeof raw !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}(?:T.+(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw) ||
      !Number.isFinite(Date.parse(raw))
    ) {
      return { ok: false, message: `${key} must be an ISO date or timestamp.` }
    }
    const date = new Date(raw).toISOString()
    if (date.slice(0, 10) !== raw.slice(0, 10) && raw.length === 10) {
      return { ok: false, message: `${key} must be a valid date.` }
    }
    dates[key] = date
  }
  if (dates.createdAfter && dates.createdBefore && dates.createdAfter >= dates.createdBefore) {
    return { ok: false, message: 'createdAfter must precede createdBefore.' }
  }
  const repository = typeof payload.repository === 'string' ? payload.repository.trim() : undefined
  if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    return { ok: false, message: 'repository must be owner/name.' }
  }
  const includeRetired = payload.includeRetired
  if (
    includeRetired != null &&
    includeRetired !== true &&
    includeRetired !== false &&
    includeRetired !== 'true' &&
    includeRetired !== 'false'
  ) {
    return { ok: false, message: 'includeRetired must be boolean.' }
  }
  return {
    ok: true,
    value: {
      namespace: normalizeOptionalMemoryNoteNamespace(payload.namespace),
      repository: repository || undefined,
      tags: normalizeMemoryNoteTags(payload.tags),
      model: typeof payload.model === 'string' ? payload.model.trim() || undefined : undefined,
      ...dates,
      includeRetired: includeRetired === true || includeRetired === 'true',
      limit: clampMemoryNoteLimit(payload.limit, fallbackLimit),
    },
  }
}

export const parseRetireMemoryNoteInput = (
  payload: Record<string, unknown>,
): ValidationResult<AgentsRetireMemoryNoteInput> => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const id = typeof payload.id === 'string' ? payload.id : ''
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : ''
  const replacementId = typeof payload.replacementId === 'string' ? payload.replacementId : undefined
  if (!uuid.test(id) || (replacementId !== undefined && !uuid.test(replacementId))) {
    return { ok: false, message: 'id and replacementId must be UUIDs.' }
  }
  if (!reason || reason.length > 1_000) return { ok: false, message: 'reason must contain 1 to 1000 characters.' }
  if (id === replacementId) return { ok: false, message: 'A note cannot replace itself.' }
  return { ok: true, value: { id, reason, replacementId } }
}

export const appendMemoryNoteFilters = (url: URL, input: AgentsMemoryNoteFilters) => {
  for (const key of ['namespace', 'repository', 'model', 'createdAfter', 'createdBefore'] as const) {
    const value = input[key]?.trim()
    if (value) url.searchParams.set(key, value)
  }
  for (const tag of input.tags ?? []) url.searchParams.append('tag', tag)
  if (input.includeRetired) url.searchParams.set('includeRetired', 'true')
  if (input.limit) url.searchParams.set('limit', String(input.limit))
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
    signal: AbortSignal.timeout(30_000),
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
  appendMemoryNoteFilters(targetUrl, input)
  return requestAgentsJsonEffect<AgentsRetrieveMemoryNotesResult>({
    path: servicePath(targetUrl),
    method: 'GET',
    env,
    signal: AbortSignal.timeout(30_000),
  })
}

export const retrieveMemoryNotesFromAgentsService = async (
  input: AgentsRetrieveMemoryNotesInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsRetrieveMemoryNotesResult>> =>
  runAgentsJsonPromise(retrieveMemoryNotesFromAgentsServiceEffect(input, env))

export const listMemoryNotesFromAgentsService = (
  input: AgentsListMemoryNotesInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsRetrieveMemoryNotesResult>> => {
  const url = buildAgentsServiceUrl('/v1/memory-notes', env)
  url.searchParams.set('mode', 'latest')
  appendMemoryNoteFilters(url, input)
  return runAgentsJsonPromise(
    requestAgentsJsonEffect<AgentsRetrieveMemoryNotesResult>({
      path: servicePath(url),
      method: 'GET',
      env,
      signal: AbortSignal.timeout(30_000),
    }),
  )
}

export const retireMemoryNoteInAgentsService = (
  input: AgentsRetireMemoryNoteInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsPersistMemoryNoteResult>> =>
  runAgentsJsonPromise(
    postAgentsJsonEffect<AgentsPersistMemoryNoteResult>('/v1/memory-notes/retire', input, {
      env,
      signal: AbortSignal.timeout(30_000),
    }),
  )

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
