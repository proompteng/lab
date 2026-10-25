import { createFileRoute } from '@tanstack/react-router'

import { recordTorghutMarketContextRunEvent } from '~/server/metrics'
import {
  ingestMarketContextProviderResult,
  isMarketContextIngestAuthorized,
} from '~/server/torghut-market-context-agents'

export const Route = createFileRoute('/api/torghut/market-context/runs/finalize')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postMarketContextRunFinalizeHandler(request),
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const parseText = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

const normalizeFinalizePayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const nested = payload.payload
  if (!isRecord(nested)) return payload

  const hasTopLevelDomain = !!parseText(payload.domain)
  const hasTopLevelSymbol = !!parseText(payload.symbol)
  if (hasTopLevelDomain || hasTopLevelSymbol) return payload

  const nestedDomain = parseText(nested.domain)
  const nestedSymbol = parseText(nested.symbol)
  if (!nestedDomain || !nestedSymbol) return payload

  const normalized: Record<string, unknown> = { ...nested }
  for (const key of ['requestId', 'provider', 'runName', 'runStatus', 'error']) {
    if (payload[key] !== undefined && normalized[key] === undefined) normalized[key] = payload[key]
  }

  if (isRecord(payload.metadata)) {
    normalized.metadata = isRecord(normalized.metadata)
      ? { ...payload.metadata, ...normalized.metadata }
      : payload.metadata
  }

  return normalized
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

  const normalizedPayload = normalizeFinalizePayload(payload as Record<string, unknown>)

  try {
    const result = await ingestMarketContextProviderResult(normalizedPayload)
    recordTorghutMarketContextRunEvent({ endpoint: 'finalize', outcome: 'accepted', domain: result.domain })
    return jsonResponse(result, 200)
  } catch (error) {
    const domain = typeof normalizedPayload.domain === 'string' ? normalizedPayload.domain : undefined
    recordTorghutMarketContextRunEvent({ endpoint: 'finalize', outcome: 'error', domain })
    const message = error instanceof Error ? error.message : 'market context ingest failed'
    return jsonResponse({ ok: false, message }, 400)
  }
}
