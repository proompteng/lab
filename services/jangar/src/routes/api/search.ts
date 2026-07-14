import { createFileRoute } from '@tanstack/react-router'

import { postCodeSearchHandler } from './code-search'

export const Route = createFileRoute('/api/search')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getAtlasSearchHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

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

const readJson = async (response: Response) => {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

export const getAtlasSearchHandler = async (request: Request) => {
  const url = new URL(request.url)
  const query = url.searchParams.get('query')?.trim() ?? ''
  if (!query) return jsonResponse({ ok: false, message: 'Query is required.', error: 'Query is required.' }, 400)
  if (url.searchParams.has('tags') || url.searchParams.has('kinds')) {
    const message = 'Atlas code search does not support legacy enrichment tag or kind filters.'
    return jsonResponse({ ok: false, message, error: message }, 400)
  }

  const payload = {
    query,
    limit: url.searchParams.get('limit') ?? undefined,
    repository: url.searchParams.get('repository') || undefined,
    ref: url.searchParams.get('ref') || undefined,
    pathPrefix: url.searchParams.get('pathPrefix') || undefined,
  }
  const codeSearchRequest = new Request(new URL('/api/code-search', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: request.signal,
  })
  const response = await postCodeSearchHandler(codeSearchRequest)
  const result = await readJson(response)
  if (!result || !response.ok) {
    return jsonResponse(
      result ?? { ok: false, message: `Atlas code search failed (${response.status})` },
      response.status,
    )
  }

  const items = Array.isArray(result.items) ? result.items : []
  return jsonResponse({
    ...result,
    matches: items,
    items,
    total: items.length,
  })
}
