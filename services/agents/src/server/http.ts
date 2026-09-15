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
