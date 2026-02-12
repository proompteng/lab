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

const parseState = (value: string | null) => {
  if (!value) return { ok: true as const, value: null }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'open') return { ok: true as const, value: 'open' as const }
  if (normalized === 'resolved') return { ok: true as const, value: 'resolved' as const }
  return { ok: false as const, message: 'state must be one of: open, resolved' }
}

export const getQuantAlertsHandler = async (request: Request) => {
  const url = new URL(request.url)

  const stateResult = parseState(url.searchParams.get('state'))
  if (!stateResult.ok) return jsonResponse({ ok: false, message: stateResult.message }, 400)

  const rawStrategy = url.searchParams.get('strategy_id') ?? url.searchParams.get('strategyId')
  let strategyId: string | undefined
  if (rawStrategy?.trim()) {
    const parsed = parseQuantStrategyId(url)
    if (!parsed.ok) return jsonResponse({ ok: false, message: parsed.message }, 400)
    strategyId = parsed.value
  }

  try {
    const alerts = await listQuantAlerts({ strategyId, state: stateResult.value ?? undefined })
    return jsonResponse({ ok: true, alerts })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Quant alerts failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}
