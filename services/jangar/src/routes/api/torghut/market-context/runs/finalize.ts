import { createFileRoute } from '@tanstack/react-router'

import { recordTorghutMarketContextRunEvent } from '~/server/metrics'
import {
  ingestMarketContextProviderResult,
  isMarketContextIngestAuthorized,
} from '~/server/torghut-market-context-agents'

export const Route = createFileRoute('/api/torghut/market-context/runs/finalize')({
  server: {
    handlers: {
      POST: async ({ request }) => postMarketContextRunFinalizeHandler(request),
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

export const postMarketContextRunFinalizeHandler = async (request: Request) => {
  if (!(await isMarketContextIngestAuthorized(request))) {
    recordTorghutMarketContextRunEvent({ endpoint: 'finalize', outcome: 'unauthorized' })
    return jsonResponse({ ok: false, message: 'unauthorized' }, 401)
  }

  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    recordTorghutMarketContextRunEvent({ endpoint: 'finalize', outcome: 'invalid_payload' })
    return jsonResponse({ ok: false, message: 'invalid JSON payload' }, 400)
  }

  try {
    const result = await ingestMarketContextProviderResult(payload)
    recordTorghutMarketContextRunEvent({ endpoint: 'finalize', outcome: 'accepted', domain: result.domain })
    return jsonResponse(result, 200)
  } catch (error) {
    const domain = typeof payload.domain === 'string' ? payload.domain : undefined
    recordTorghutMarketContextRunEvent({ endpoint: 'finalize', outcome: 'error', domain })
    const message = error instanceof Error ? error.message : 'market context ingest failed'
    return jsonResponse({ ok: false, message }, 400)
  }
}
