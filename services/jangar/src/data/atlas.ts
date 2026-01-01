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
  fileVersionId?: string
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

export type AtlasFilePreview =
  | { ok: true; repository?: string; ref?: string; path?: string; content: string; truncated?: boolean }
  | { ok: false; message: string }

export type AtlasAstFact = {
  nodeType: string
  matchText: string
  startLine: number | null
  endLine: number | null
}

export type AtlasAstPreview =
  | { ok: true; fileVersionId?: string; summary?: string; facts: AtlasAstFact[] }
  | { ok: false; message: string }

export type AtlasSearchResult =
  | { ok: true; items: AtlasFileItem[]; raw: unknown; total?: number }
  | { ok: false; items: AtlasFileItem[]; message: string; raw?: unknown; total?: number }

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
    fileVersionId:
      parseString(record.fileVersionId) ??
      parseString(record.file_version_id) ??
      parseString(file.id) ??
      parseString(file.fileVersionId) ??
      parseString(metadata.fileVersionId),
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

const extractAtlasTotal = (payload: unknown): number | undefined => {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  const raw =
    parseNumber(record.total) ??
    parseNumber(record.count) ??
    parseNumber(record.totalMatches) ??
    parseNumber(record.total_matches) ??
    record.total ??
    record.count ??
    record.totalMatches ??
    record.total_matches
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
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

  const total = extractAtlasTotal(payload)

  if (!response.ok) {
    return {
      ok: false,
      items: extractAtlasItems(payload),
      raw: payload ?? undefined,
      total,
      message: `Search failed (${response.status})`,
    }
  }

  return { ok: true, items: extractAtlasItems(payload), raw: payload, total }
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

export const getAtlasFilePreview = async (params: {
  repository?: string
  ref?: string
  path?: string
  signal?: AbortSignal
}): Promise<AtlasFilePreview> => {
  const searchParams = new URLSearchParams()
  if (params.repository) searchParams.set('repository', params.repository)
  if (params.ref) searchParams.set('ref', params.ref)
  if (params.path) searchParams.set('path', params.path)

  const url = `/api/atlas/file${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  const response = await fetch(url, { signal: params.signal })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload ? String(payload.message) : 'File preview failed'
    return { ok: false, message }
  }

  if (!payload || typeof payload !== 'object') return { ok: false, message: 'Invalid preview response.' }
  const record = payload as Record<string, unknown>

  return {
    ok: true,
    repository: parseString(record.repository),
    ref: parseString(record.ref),
    path: parseString(record.path),
    content: parseString(record.content) ?? '',
    truncated: typeof record.truncated === 'boolean' ? record.truncated : undefined,
  }
}

export const getAtlasAstPreview = async (params: {
  fileVersionId?: string
  limit?: number
  signal?: AbortSignal
}): Promise<AtlasAstPreview> => {
  const searchParams = new URLSearchParams()
  if (params.fileVersionId) searchParams.set('fileVersionId', params.fileVersionId)
  if (params.limit !== undefined) searchParams.set('limit', params.limit.toString())

  const url = `/api/atlas/ast${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  const response = await fetch(url, { signal: params.signal })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload ? String(payload.message) : 'AST preview failed'
    return { ok: false, message }
  }

  if (!payload || typeof payload !== 'object') return { ok: false, message: 'Invalid AST response.' }
  const record = payload as Record<string, unknown>
  const facts = Array.isArray(record.facts)
    ? record.facts
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map((item) => {
          const startLine = typeof item.startLine === 'number' ? item.startLine : null
          const endLine = typeof item.endLine === 'number' ? item.endLine : null
          const altStart = typeof item.start_line === 'number' ? item.start_line : null
          const altEnd = typeof item.end_line === 'number' ? item.end_line : null

          return {
            nodeType: parseString(item.nodeType) ?? parseString(item.node_type) ?? 'node',
            matchText: parseString(item.matchText) ?? parseString(item.match_text) ?? '',
            startLine: startLine ?? altStart,
            endLine: endLine ?? altEnd,
          }
        })
    : []

  return {
    ok: true,
    fileVersionId: parseString(record.fileVersionId) ?? parseString(record.file_version_id),
    summary: parseString(record.summary) ?? undefined,
    facts,
  }
}
