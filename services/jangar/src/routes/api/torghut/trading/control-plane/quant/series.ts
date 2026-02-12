import { createFileRoute } from '@tanstack/react-router'
import {
  parseIsoUtc,
  parseMetricList,
  parseQuantAccount,
  parseQuantStrategyId,
  parseQuantWindow,
} from '~/server/torghut-quant-http'
import { listQuantSeriesMetrics } from '~/server/torghut-quant-metrics-store'
import { computeWindowBoundsUtc } from '~/server/torghut-quant-windows'

export const Route = createFileRoute('/api/torghut/trading/control-plane/quant/series')({
  server: {
    handlers: {
      GET: async ({ request }) => getQuantSeriesHandler(request),
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

export const getQuantSeriesHandler = async (request: Request) => {
  const url = new URL(request.url)
  const strategyIdResult = parseQuantStrategyId(url)
  if (!strategyIdResult.ok) return jsonResponse({ ok: false, message: strategyIdResult.message }, 400)

  const accountResult = parseQuantAccount(url)
  const windowResult = parseQuantWindow(url)
  if (!windowResult.ok) return jsonResponse({ ok: false, message: windowResult.message }, 400)

  const metrics = parseMetricList(url.searchParams.get('metrics'))
  if (metrics.length === 0) {
    return jsonResponse({ ok: false, message: 'Missing required query param: metrics' }, 400)
  }

  const now = new Date()
  const defaultBounds = computeWindowBoundsUtc(windowResult.value, now)
  const fromUtc = parseIsoUtc(url.searchParams.get('from')) ?? defaultBounds.startUtc
  const toUtc = parseIsoUtc(url.searchParams.get('to')) ?? defaultBounds.endUtc

  try {
    const rows = await listQuantSeriesMetrics({
      strategyId: strategyIdResult.value,
      account: accountResult.value,
      window: windowResult.value,
      metricNames: metrics,
      fromUtc,
      toUtc,
    })

    const series: Record<
      string,
      Array<{ asOf: string; valueNumeric: number | null; quality: string; status: string }>
    > = {}
    for (const row of rows) {
      if (!series[row.metricName]) series[row.metricName] = []
      series[row.metricName].push({
        asOf: row.asOf,
        valueNumeric: row.valueNumeric,
        quality: row.quality,
        status: row.status,
      })
    }

    return jsonResponse({
      ok: true,
      strategyId: strategyIdResult.value,
      account: accountResult.value,
      window: windowResult.value,
      fromUtc,
      toUtc,
      series,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Quant series failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}
