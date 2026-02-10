import { createFileRoute } from '@tanstack/react-router'
import { buildTorghutTradingSummary, parseTorghutTradingStrategyId } from '~/server/torghut-trading'
import { resolveTorghutDb } from '~/server/torghut-trading-db'
import { resolveTradingDayInterval } from '~/server/torghut-trading-time'

export const Route = createFileRoute('/api/torghut/trading/summary')({
  server: {
    handlers: {
      GET: async ({ request }) => getSummaryHandler(request),
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

export const getSummaryHandler = async (request: Request) => {
  const torghut = resolveTorghutDb()
  if (!torghut.ok) return jsonResponse({ ok: false, disabled: true, message: torghut.message }, 503)

  const url = new URL(request.url)
  const intervalResult = resolveTradingDayInterval(url)
  if (!intervalResult.ok) return jsonResponse({ ok: false, message: intervalResult.message }, 400)

  const strategyIdResult = parseTorghutTradingStrategyId(url)
  if (!strategyIdResult.ok) return jsonResponse({ ok: false, message: strategyIdResult.message }, 400)

  try {
    const summary = await buildTorghutTradingSummary({
      pool: torghut.pool,
      interval: intervalResult.value,
      strategyId: strategyIdResult.value,
    })
    return jsonResponse({ ok: true, summary })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Torghut query failed'
    return jsonResponse({ ok: false, message }, 500)
  }
}
