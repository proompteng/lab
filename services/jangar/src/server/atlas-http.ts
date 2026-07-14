export const DEFAULT_REF = 'main'
export const DEFAULT_LIMIT = 10

export const MAX_REPOSITORY_CHARS = 200
export const MAX_REF_CHARS = 200
export const MAX_PATH_CHARS = 2048
export const MAX_QUERY_CHARS = 10_000
export const MAX_SEARCH_LIMIT = 200

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

export type AtlasCodeSearchInput = {
  query: string
  limit?: number
  repository?: string
  ref?: string
  pathPrefix?: string
  language?: string
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

const normalizeLimit = (value: unknown, fallback = DEFAULT_LIMIT) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(value)))
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(MAX_SEARCH_LIMIT, parsed))
    }
  }
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, fallback))
}

export const parseAtlasCodeSearchInput = (
  payload: Record<string, unknown>,
  fallbackLimit = DEFAULT_LIMIT,
): ValidationResult<AtlasCodeSearchInput> => {
  try {
    const query = normalizeRequiredText(payload.query, 'Query', MAX_QUERY_CHARS)
    if (!query) return { ok: false, message: 'Query is required.' }

    const limit = normalizeLimit(payload.limit, fallbackLimit)
    const repository = normalizeOptionalText(payload.repository, MAX_REPOSITORY_CHARS)
    const ref = normalizeOptionalText(payload.ref, MAX_REF_CHARS)
    const pathPrefix = normalizeOptionalText(payload.pathPrefix, MAX_PATH_CHARS)
    const language = normalizeOptionalText(payload.language, 100)

    return {
      ok: true,
      value: {
        query,
        limit,
        repository,
        ref,
        pathPrefix,
        language,
      },
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid Atlas code search input.',
    }
  }
}
