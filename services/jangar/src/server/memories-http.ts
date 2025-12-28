import type { PersistMemoryInput, RetrieveMemoryInput } from './memories-store'

export const DEFAULT_NAMESPACE = 'default'
export const DEFAULT_LIMIT = 10

export const MAX_CONTENT_CHARS = 50_000
export const MAX_QUERY_CHARS = 10_000
export const MAX_SUMMARY_CHARS = 5_000
export const MAX_NAMESPACE_CHARS = 200
export const MAX_TAGS = 50

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

type ParseLimitInput = unknown

const clampLimit = (value: ParseLimitInput, fallback = DEFAULT_LIMIT) => {
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

export const normalizeNamespace = (namespace: unknown) => {
  const raw = typeof namespace === 'string' ? namespace.trim() : ''
  const resolved = raw.length > 0 ? raw : DEFAULT_NAMESPACE
  return resolved.slice(0, MAX_NAMESPACE_CHARS)
}

export const normalizeOptionalNamespace = (namespace: unknown) => {
  const raw = typeof namespace === 'string' ? namespace.trim() : ''
  return raw.length > 0 ? raw.slice(0, MAX_NAMESPACE_CHARS) : undefined
}

export const normalizeTags = (tags: unknown): string[] => {
  if (!Array.isArray(tags)) return []
  return tags
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, MAX_TAGS)
}

export const normalizeMetadata = (metadata: unknown): Record<string, unknown> | undefined => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined
  }
  return metadata as Record<string, unknown>
}

export const parsePersistMemoryInput = (payload: Record<string, unknown>): ValidationResult<PersistMemoryInput> => {
  const content = typeof payload.content === 'string' ? payload.content.trim() : ''
  if (!content) return { ok: false, message: 'Content is required.' }
  if (content.length > MAX_CONTENT_CHARS) {
    return { ok: false, message: `Content is too large (max ${MAX_CONTENT_CHARS} chars).` }
  }

  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : null
  if (summary && summary.length > MAX_SUMMARY_CHARS) {
    return { ok: false, message: `Summary is too large (max ${MAX_SUMMARY_CHARS} chars).` }
  }

  const namespace = normalizeNamespace(payload.namespace)
  const tags = normalizeTags(payload.tags)
  const metadata = normalizeMetadata(payload.metadata)

  return {
    ok: true,
    value: {
      namespace,
      content,
      summary,
      tags,
      metadata,
    },
  }
}

export const parseRetrieveMemoryInput = (
  payload: Record<string, unknown>,
  fallbackLimit = DEFAULT_LIMIT,
): ValidationResult<RetrieveMemoryInput> => {
  const query = typeof payload.query === 'string' ? payload.query.trim() : ''
  if (!query) return { ok: false, message: 'Query is required.' }
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, message: `Query is too large (max ${MAX_QUERY_CHARS} chars).` }
  }

  const namespace = normalizeNamespace(payload.namespace)
  const limit = clampLimit(payload.limit, fallbackLimit)

  return {
    ok: true,
    value: {
      namespace,
      query,
      limit,
    },
  }
}
