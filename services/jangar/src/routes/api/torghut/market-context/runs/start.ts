import { createFileRoute } from '@tanstack/react-router'

import { recordTorghutMarketContextRunEvent } from '~/server/metrics'
import { isMarketContextIngestAuthorized, startMarketContextProviderRun } from '~/server/torghut-market-context-agents'

export const Route = createFileRoute('/api/torghut/market-context/runs/start')({
  server: {
    handlers: {
      POST: async ({ request }) => postMarketContextRunStartHandler(request),
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

export const postMarketContextRunStartHandler = async (request: Request) => {
  if (!(await isMarketContextIngestAuthorized(request))) {
    recordTorghutMarketContextRunEvent({ endpoint: 'start', outcome: 'unauthorized' })
    return jsonResponse({ ok: false, message: 'unauthorized' }, 401)
  }

  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    recordTorghutMarketContextRunEvent({ endpoint: 'start', outcome: 'invalid_payload' })
    return jsonResponse({ ok: false, message: 'invalid JSON payload' }, 400)
  }

  try {
    const result = await startMarketContextProviderRun(payload)
    recordTorghutMarketContextRunEvent({ endpoint: 'start', outcome: 'accepted', domain: result.domain })
    return jsonResponse(result, 200)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to start market-context run'
    recordTorghutMarketContextRunEvent({ endpoint: 'start', outcome: 'error' })
    return jsonResponse({ ok: false, message }, 400)
  }
}
