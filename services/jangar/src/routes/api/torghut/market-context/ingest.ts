import { createFileRoute } from '@tanstack/react-router'

import {
  ingestMarketContextProviderResult,
  isMarketContextIngestAuthorized,
} from '~/server/torghut-market-context-agents'

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

export const postMarketContextIngestHandler = async (request: Request) => {
  if (!(await isMarketContextIngestAuthorized(request))) {
    return jsonResponse({ ok: false, message: 'unauthorized' }, 401)
  }

  const payload = await request.json().catch(() => null)
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
