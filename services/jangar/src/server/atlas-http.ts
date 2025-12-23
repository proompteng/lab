export const DEFAULT_REF = 'main'
export const DEFAULT_LIMIT = 10

export const MAX_REPOSITORY_CHARS = 200
export const MAX_REF_CHARS = 200
export const MAX_COMMIT_CHARS = 200
export const MAX_PATH_CHARS = 2048
export const MAX_CONTENT_HASH_CHARS = 200
export const MAX_QUERY_CHARS = 10_000
export const MAX_TAGS = 50
export const MAX_KINDS = 50

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

export type AtlasIndexInput = {
  repository: string
  ref: string
  commit?: string
  path: string
  contentHash?: string
  metadata?: Record<string, unknown>
}

export type AtlasSearchInput = {
  query: string
  limit?: number
  repository?: string
  ref?: string
  pathPrefix?: string
  tags?: string[]
  kinds?: string[]
}

const normalizeRequiredText = (value: unknown, field: string, max: number, fallback?: string): string | null => {
  const raw = typeof value === 'string' ? value.trim() : ''
  const resolved = raw.length > 0 ? raw : (fallback ?? '')
  if (resolved.length === 0) return null
  if (resolved.length > max) {
    throw new Error(`${field} is too large (max ${max} chars).`)
  }
  return resolved
}

const normalizeOptionalText = (value: unknown, max: number): string | undefined => {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return undefined
  if (raw.length > max) {
    throw new Error(`Value is too large (max ${max} chars).`)
  }
  return raw
}

const normalizeStringArray = (value: unknown, maxItems: number) => {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, maxItems)
}

const normalizeLimit = (value: unknown, fallback = DEFAULT_LIMIT) => {
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

const normalizeMetadata = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export const parseAtlasIndexInput = (payload: Record<string, unknown>): ValidationResult<AtlasIndexInput> => {
  try {
    const repository = normalizeRequiredText(payload.repository, 'Repository', MAX_REPOSITORY_CHARS)
    if (!repository) return { ok: false, message: 'Repository is required.' }

    const ref = normalizeRequiredText(payload.ref, 'Ref', MAX_REF_CHARS, DEFAULT_REF)
    if (!ref) return { ok: false, message: 'Ref is required.' }

    const path = normalizeRequiredText(payload.path, 'Path', MAX_PATH_CHARS)
    if (!path) return { ok: false, message: 'Path is required.' }

    const commit = normalizeOptionalText(payload.commit, MAX_COMMIT_CHARS)
    const contentHash = normalizeOptionalText(payload.contentHash, MAX_CONTENT_HASH_CHARS)

    if (!commit && !contentHash) {
      return { ok: false, message: 'Commit or content hash is required.' }
    }

    const metadata = normalizeMetadata(payload.metadata)

    return {
      ok: true,
      value: {
        repository,
        ref,
        commit,
        path,
        contentHash,
        metadata,
      },
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid Atlas index input.',
    }
  }
}

export const parseAtlasSearchInput = (
  payload: Record<string, unknown>,
  fallbackLimit = DEFAULT_LIMIT,
): ValidationResult<AtlasSearchInput> => {
  try {
    const query = normalizeRequiredText(payload.query, 'Query', MAX_QUERY_CHARS)
    if (!query) return { ok: false, message: 'Query is required.' }

    const limit = normalizeLimit(payload.limit, fallbackLimit)
    const repository = normalizeOptionalText(payload.repository, MAX_REPOSITORY_CHARS)
    const ref = normalizeOptionalText(payload.ref, MAX_REF_CHARS)
    const pathPrefix = normalizeOptionalText(payload.pathPrefix, MAX_PATH_CHARS)
    const tags = normalizeStringArray(payload.tags, MAX_TAGS)
    const kinds = normalizeStringArray(payload.kinds, MAX_KINDS)

    return {
      ok: true,
      value: {
        query,
        limit,
        repository,
        ref,
        pathPrefix,
        tags: tags.length > 0 ? tags : undefined,
        kinds: kinds.length > 0 ? kinds : undefined,
      },
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid Atlas search input.',
    }
  }
}
