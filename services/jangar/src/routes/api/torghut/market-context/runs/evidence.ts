import { createFileRoute } from '@tanstack/react-router'

import { recordTorghutMarketContextRunEvent } from '~/server/metrics'
import {
  isMarketContextIngestAuthorized,
  recordMarketContextProviderEvidence,
} from '~/server/torghut-market-context-agents'

export const Route = createFileRoute('/api/torghut/market-context/runs/evidence')({
  server: {
    handlers: {
      POST: async ({ request }) => postMarketContextRunEvidenceHandler(request),
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

export const postMarketContextRunEvidenceHandler = async (request: Request) => {
  if (!(await isMarketContextIngestAuthorized(request))) {
    recordTorghutMarketContextRunEvent({ endpoint: 'evidence', outcome: 'unauthorized' })
    return jsonResponse({ ok: false, message: 'unauthorized' }, 401)
  }

  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    recordTorghutMarketContextRunEvent({ endpoint: 'evidence', outcome: 'invalid_payload' })
    return jsonResponse({ ok: false, message: 'invalid JSON payload' }, 400)
  }

  try {
    const result = await recordMarketContextProviderEvidence(payload)
    recordTorghutMarketContextRunEvent({ endpoint: 'evidence', outcome: 'accepted', domain: result.domain })
    return jsonResponse(result, 200)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to record market-context evidence'
    if (message.includes('run not found')) {
      recordTorghutMarketContextRunEvent({ endpoint: 'evidence', outcome: 'not_found' })
      return jsonResponse({ ok: false, message }, 404)
    }
    recordTorghutMarketContextRunEvent({ endpoint: 'evidence', outcome: 'error' })
    return jsonResponse({ ok: false, message }, 400)
  }
}
