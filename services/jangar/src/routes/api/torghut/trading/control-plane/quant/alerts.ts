import { createFileRoute } from '@tanstack/react-router'
import { parseQuantStrategyId } from '~/server/torghut-quant-http'
import { listQuantAlerts } from '~/server/torghut-quant-metrics-store'

export const Route = createFileRoute('/api/torghut/trading/control-plane/quant/alerts')({
  server: {
    handlers: {
      GET: async ({ request }) => getQuantAlertsHandler(request),
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

const parseState = (value: string | null): 'open' | 'resolved' | null => {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'open') return 'open'
  if (normalized === 'resolved') return 'resolved'
  return null
}

export const getQuantAlertsHandler = async (request: Request) => {
  const url = new URL(request.url)

  const state = parseState(url.searchParams.get('state'))
  const rawStrategy = url.searchParams.get('strategy_id') ?? url.searchParams.get('strategyId')
  const strategyId = rawStrategy?.trim()
    ? (() => {
        const parsed = parseQuantStrategyId(url)
        return parsed.ok ? parsed.value : null
      })()
    : undefined

  try {
    const alerts = await listQuantAlerts({ strategyId: strategyId ?? undefined, state: state ?? undefined })
    return jsonResponse({ ok: true, alerts })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Quant alerts failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}
