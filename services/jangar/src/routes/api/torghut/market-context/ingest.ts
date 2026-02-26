import { createFileRoute } from '@tanstack/react-router'
import { ingestMarketContextProviderResult } from '~/server/torghut-market-context-agents'

export const Route = createFileRoute('/api/torghut/market-context/ingest')({
  server: {
    handlers: {
      POST: async ({ request }) => postMarketContextIngestHandler(request),
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

const resolveBearerToken = (request: Request) => {
  const raw = request.headers.get('authorization')?.trim()
  if (!raw) return null
  const [scheme, ...rest] = raw.split(/\s+/g)
  if (scheme.toLowerCase() !== 'bearer') return null
  const token = rest.join(' ').trim()
  return token.length > 0 ? token : null
}

const isIngestAuthorized = (request: Request) => {
  const expected = process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN?.trim()
  if (!expected) return true
  const actual = resolveBearerToken(request)
  return actual === expected
}

export const postMarketContextIngestHandler = async (request: Request) => {
  if (!isIngestAuthorized(request)) {
    return jsonResponse({ ok: false, message: 'unauthorized' }, 401)
  }

  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse({ ok: false, message: 'invalid JSON payload' }, 400)
  }

  try {
    const result = await ingestMarketContextProviderResult(payload)
    return jsonResponse(result, 202)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'market context ingest failed'
    return jsonResponse({ ok: false, message }, 400)
  }
}
