const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

export const okResponse = (payload: unknown, status = 200) => jsonResponse(payload, status)

export const errorResponse = (message: string, status = 400, details?: Record<string, unknown>) =>
  jsonResponse({ ok: false, error: message, ...(details ? { details } : {}) }, status)

export const parseJsonBody = async (request: Request) => {
  try {
    const payload = (await request.json()) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('invalid JSON body')
    }
    return payload as Record<string, unknown>
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

export const normalizeNamespace = (value?: string | null, fallback = 'jangar') => {
  if (!value) return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

export const asString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

export const asRecord = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

export const readNested = (value: unknown, path: string[]) => {
  let cursor: unknown = value
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor ?? null
}
