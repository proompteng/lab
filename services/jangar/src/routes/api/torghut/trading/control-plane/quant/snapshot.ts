import { createFileRoute } from '@tanstack/react-router'
import { parseQuantAccount, parseQuantStrategyId, parseQuantWindow } from '~/server/torghut-quant-http'
import { listQuantAlerts, listQuantLatestMetrics } from '~/server/torghut-quant-metrics-store'

export const Route = createFileRoute('/api/torghut/trading/control-plane/quant/snapshot')({
  server: {
    handlers: {
      GET: async ({ request }) => getQuantSnapshotHandler(request),
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

export const getQuantSnapshotHandler = async (request: Request) => {
  const url = new URL(request.url)
  const strategyIdResult = parseQuantStrategyId(url)
  if (!strategyIdResult.ok) return jsonResponse({ ok: false, message: strategyIdResult.message }, 400)

  const accountResult = parseQuantAccount(url)
  const windowResult = parseQuantWindow(url)
  if (!windowResult.ok) return jsonResponse({ ok: false, message: windowResult.message }, 400)

  try {
    const [metrics, alerts] = await Promise.all([
      listQuantLatestMetrics({
        strategyId: strategyIdResult.value,
        account: accountResult.value,
        window: windowResult.value,
      }),
      listQuantAlerts({ strategyId: strategyIdResult.value, state: 'open', limit: 1000 }),
    ])

    const frame = {
      strategyId: strategyIdResult.value,
      account: accountResult.value,
      window: windowResult.value,
      frameAsOf: new Date().toISOString(),
      metrics,
      alerts: alerts.filter((alert) => alert.window === windowResult.value && alert.account === accountResult.value),
    }

    return jsonResponse({ ok: true, frame })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Quant snapshot failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}
