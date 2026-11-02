import { z } from 'zod'

export const jsonResponse = (payload: unknown, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  })
}

export const methodNotAllowed = () => jsonResponse({ error: 'method not allowed' }, { status: 405 })

export const badRequest = (message: string, details?: unknown) =>
  jsonResponse({ error: message, details }, { status: 400 })

export const notFound = (message = 'not found') => jsonResponse({ error: message }, { status: 404 })

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return badRequest('invalid json body')
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) return badRequest('invalid request body', z.treeifyError(parsed.error))

  return { ok: true, value: parsed.data }
}
