import { createFileRoute } from '@tanstack/react-router'

import { recordTorghutMarketContextRunEvent } from '~/server/metrics'
import {
  isMarketContextIngestAuthorized,
  recordMarketContextProviderRunProgress,
} from '~/server/torghut-market-context-agents'

export const Route = createFileRoute('/api/torghut/market-context/runs/progress')({
  server: {
    handlers: {
      POST: async ({ request }) => postMarketContextRunProgressHandler(request),
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

export const postMarketContextRunProgressHandler = async (request: Request) => {
  if (!(await isMarketContextIngestAuthorized(request))) {
    recordTorghutMarketContextRunEvent({ endpoint: 'progress', outcome: 'unauthorized' })
    return jsonResponse({ ok: false, message: 'unauthorized' }, 401)
  }

  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    recordTorghutMarketContextRunEvent({ endpoint: 'progress', outcome: 'invalid_payload' })
    return jsonResponse({ ok: false, message: 'invalid JSON payload' }, 400)
  }

  try {
    const result = await recordMarketContextProviderRunProgress(payload)
    recordTorghutMarketContextRunEvent({ endpoint: 'progress', outcome: 'accepted', domain: result.domain })
    return jsonResponse(result, 200)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to record market-context progress'
    if (message.includes('run not found')) {
      recordTorghutMarketContextRunEvent({ endpoint: 'progress', outcome: 'not_found' })
      return jsonResponse({ ok: false, message }, 404)
    }
    recordTorghutMarketContextRunEvent({ endpoint: 'progress', outcome: 'error' })
    return jsonResponse({ ok: false, message }, 400)
  }
}
