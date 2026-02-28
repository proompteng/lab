import { createFileRoute } from '@tanstack/react-router'

import { recordTorghutMarketContextRunEvent } from '~/server/metrics'
import {
  getMarketContextProviderRunStatus,
  isMarketContextIngestAuthorized,
} from '~/server/torghut-market-context-agents'

export const Route = createFileRoute('/api/torghut/market-context/runs/$requestId')({
  server: {
    handlers: {
      GET: async ({ params, request }) => getMarketContextRunStatusHandler(params.requestId, request),
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

export const getMarketContextRunStatusHandler = async (requestId: string, request: Request) => {
  if (!(await isMarketContextIngestAuthorized(request))) {
    recordTorghutMarketContextRunEvent({ endpoint: 'status', outcome: 'unauthorized' })
    return jsonResponse({ ok: false, message: 'unauthorized' }, 401)
  }

  try {
    const result = await getMarketContextProviderRunStatus(requestId)
    recordTorghutMarketContextRunEvent({ endpoint: 'status', outcome: 'accepted', domain: result.domain })
    return jsonResponse(result, 200)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to read market-context run status'
    if (message.includes('run not found')) {
      recordTorghutMarketContextRunEvent({ endpoint: 'status', outcome: 'not_found' })
      return jsonResponse({ ok: false, message }, 404)
    }
    recordTorghutMarketContextRunEvent({ endpoint: 'status', outcome: 'error' })
    return jsonResponse({ ok: false, message }, 400)
  }
}
