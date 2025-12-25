import { randomUuid } from '@/lib/uuid'

export type AtlasSearchParams = {
  query?: string
  limit?: number
  repository?: string
  ref?: string
  pathPrefix?: string
  tags?: string[]
  kinds?: string[]
}

export type AtlasFileItem = {
  repository?: string
  ref?: string
  commit?: string
  path?: string
  contentHash?: string
  updatedAt?: string
  score?: number
  summary?: string
  tags?: string[]
}

export type AtlasSearchResult =
  | { ok: true; items: AtlasFileItem[]; raw: unknown }
  | { ok: false; items: AtlasFileItem[]; message: string; raw?: unknown }

export type AtlasEnrichInput = {
  repository: string
  ref: string
  path: string
  commit?: string
  contentHash?: string
  metadata?: Record<string, unknown>
}

export type AtlasRepositoryEnrichInput = {
  repository: string
  ref: string
  commit?: string
  pathPrefix?: string
  maxFiles?: number
  context?: string
}

export type AtlasEnrichResult =
  | { ok: true; status: number; result: unknown }
  | { ok: false; status?: number; message: string }

export type AtlasRepositoryEnrichResult =
  | { ok: true; status: number; result: unknown }
  | { ok: false; status?: number; message: string }

export type AtlasPathLookupParams = {
  repository?: string
  ref?: string
  query?: string
  limit?: number
  signal?: AbortSignal
}

export type AtlasPathLookupResult = { ok: true; paths: string[] } | { ok: false; message: string }

const parseString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const parseNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const parseStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((entry): entry is string => typeof entry === 'string')
  return items.length ? items : undefined
}

const normalizeAtlasItem = (raw: unknown): AtlasFileItem => {
  if (!raw || typeof raw !== 'object') return {}
  const record = raw as Record<string, unknown>
  const file =
    (record.file as Record<string, unknown> | undefined) ??
    (record.fileVersion as Record<string, unknown> | undefined) ??
    (record.file_version as Record<string, unknown> | undefined) ??
    (record.fileKey as Record<string, unknown> | undefined) ??
    (record.file_key as Record<string, unknown> | undefined) ??
    record
  const metadata =
    (record.metadata as Record<string, unknown> | undefined) ??
    (file.metadata as Record<string, unknown> | undefined) ??
    {}

  return {
    repository:
      parseString(record.repository) ??
      parseString(file.repository) ??
      parseString(metadata.repository) ??
      parseString(metadata.repo),
    ref:
      parseString(record.ref) ??
      parseString(record.branch) ??
      parseString(file.ref) ??
      parseString(file.branch) ??
      parseString(metadata.ref),
    commit:
      parseString(record.commit) ??
      parseString(record.sha) ??
      parseString(file.commit) ??
      parseString(file.sha) ??
      parseString(metadata.commit),
    path:
      parseString(record.path) ??
      parseString(record.filePath) ??
      parseString(record.file_path) ??
      parseString(file.path) ??
      parseString(file.filePath) ??
      parseString(file.file_path) ??
      parseString(metadata.path),
    contentHash:
      parseString(record.contentHash) ??
      parseString(record.content_hash) ??
      parseString(file.contentHash) ??
      parseString(file.content_hash) ??
      parseString(metadata.contentHash),
    updatedAt:
      parseString(record.updatedAt) ??
      parseString(record.updated_at) ??
      parseString(file.updatedAt) ??
      parseString(file.updated_at) ??
      parseString(metadata.updatedAt) ??
      parseString(metadata.updated_at),
    score:
      parseNumber(record.score) ??
      parseNumber(record.rank) ??
      parseNumber(record.similarity) ??
      parseNumber(file.score),
    summary: parseString(record.summary) ?? parseString(record.snippet) ?? parseString(file.summary),
    tags: parseStringArray(record.tags) ?? parseStringArray(file.tags) ?? parseStringArray(metadata.tags),
  }
}

const extractAtlasItems = (payload: unknown): AtlasFileItem[] => {
  if (Array.isArray(payload)) {
    return payload.map(normalizeAtlasItem)
  }
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const candidates =
    (record.items as unknown[]) ??
    (record.results as unknown[]) ??
    (record.files as unknown[]) ??
    (record.data as unknown[]) ??
    []
  if (!Array.isArray(candidates)) return []
  return candidates.map(normalizeAtlasItem)
}

export const searchAtlas = async (params: AtlasSearchParams): Promise<AtlasSearchResult> => {
  const searchParams = new URLSearchParams()
  if (params.query !== undefined) searchParams.set('query', params.query)
  if (params.limit !== undefined) searchParams.set('limit', params.limit.toString())
  if (params.repository) searchParams.set('repository', params.repository)
  if (params.ref) searchParams.set('ref', params.ref)
  if (params.pathPrefix) searchParams.set('pathPrefix', params.pathPrefix)
  params.tags?.forEach((tag) => {
    searchParams.append('tags', tag)
  })
  params.kinds?.forEach((kind) => {
    searchParams.append('kinds', kind)
  })

  const url = `/api/search${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  const response = await fetch(url)
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false,
      items: extractAtlasItems(payload),
      raw: payload ?? undefined,
      message: `Search failed (${response.status})`,
    }
  }

  return { ok: true, items: extractAtlasItems(payload), raw: payload }
}

export const listAtlasIndexedFiles = async (
  params: Pick<AtlasSearchParams, 'limit' | 'repository' | 'ref' | 'pathPrefix'> = {},
): Promise<AtlasSearchResult> => {
  const searchParams = new URLSearchParams()
  if (params.limit !== undefined) searchParams.set('limit', params.limit.toString())
  if (params.repository) searchParams.set('repository', params.repository)
  if (params.ref) searchParams.set('ref', params.ref)
  if (params.pathPrefix) searchParams.set('pathPrefix', params.pathPrefix)

  const url = `/api/atlas/indexed${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  const response = await fetch(url)
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false,
      items: extractAtlasItems(payload),
      raw: payload ?? undefined,
      message: `Indexed files failed (${response.status})`,
    }
  }

  return { ok: true, items: extractAtlasItems(payload), raw: payload }
}

export const enrichAtlas = async (input: AtlasEnrichInput): Promise<AtlasEnrichResult> => {
  const response = await fetch('/api/enrich', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUuid(),
    },
    body: JSON.stringify(input),
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: `Enrich failed (${response.status})`,
    }
  }

  return { ok: true, status: response.status, result: payload }
}

export const enrichAtlasRepository = async (
  input: AtlasRepositoryEnrichInput,
): Promise<AtlasRepositoryEnrichResult> => {
  const response = await fetch('/api/enrich', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUuid(),
    },
    body: JSON.stringify({
      mode: 'repository',
      ...input,
    }),
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: `Enrich failed (${response.status})`,
    }
  }

  return { ok: true, status: response.status, result: payload }
}

export const listAtlasPaths = async (params: AtlasPathLookupParams): Promise<AtlasPathLookupResult> => {
  const searchParams = new URLSearchParams()
  if (params.repository) searchParams.set('repository', params.repository)
  if (params.ref) searchParams.set('ref', params.ref)
  if (params.query) searchParams.set('query', params.query)
  if (params.limit) searchParams.set('limit', params.limit.toString())

  const url = `/api/atlas/paths${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  const response = await fetch(url, { signal: params.signal })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload ? String(payload.message) : 'Path lookup failed'
    return { ok: false, message }
  }

  if (!payload || typeof payload !== 'object') return { ok: true, paths: [] }
  const record = payload as Record<string, unknown>
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((item): item is string => typeof item === 'string')
    : []
  return { ok: true, paths }
}
