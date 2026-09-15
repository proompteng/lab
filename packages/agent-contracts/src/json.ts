export type JsonRecord = Record<string, unknown>

const jsonByteLength = (value: string) => new TextEncoder().encode(value).byteLength

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': jsonByteLength(body).toString(),
    },
  })
}

export const okResponse = (payload: unknown, status = 200) => jsonResponse(payload, status)

export const errorResponse = (message: string, status = 400, details?: JsonRecord) =>
  jsonResponse({ ok: false, error: message, ...(details ? { details } : {}) }, status)

export const parseJsonBody = async (request: Request) => {
  try {
    const payload = (await request.json()) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('invalid JSON body')
    }
    return payload as JsonRecord
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'invalid JSON body')
  }
}

export const requireIdempotencyKey = (request: Request) => {
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!key) {
    throw new Error('Idempotency-Key header is required')
  }
  return key
}

export const normalizeNamespace = (value?: string | null, fallback = 'agents') => {
  if (!value) return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

export const asString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

export const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null

export const readNested = (value: unknown, path: string[]) => {
  let cursor: unknown = value
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as JsonRecord)[key]
  }
  return cursor ?? null
}

export const canonicalizeForJsonHash = (value: unknown): unknown => {
  if (value == null) return null
  if (Array.isArray(value)) return value.map((entry) => canonicalizeForJsonHash(entry))
  if (typeof value !== 'object') return value

  const record = asRecord(value)
  if (!record) return value

  const output: JsonRecord = {}
  for (const key of Object.keys(record).sort()) {
    const entry = record[key]
    if (entry === undefined) continue
    output[key] = canonicalizeForJsonHash(entry)
  }
  return output
}

export const stableJsonStringifyForHash = (value: unknown) => JSON.stringify(canonicalizeForJsonHash(value))
