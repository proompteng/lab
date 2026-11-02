import { createFileRoute } from '@tanstack/react-router'
import { listTorghutTradingStrategies } from '~/server/torghut-trading'
import { resolveTorghutDb } from '~/server/torghut-trading-db'

export const Route = createFileRoute('/api/torghut/trading/strategies')({
  server: {
    handlers: {
      GET: async () => getStrategiesHandler(),
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

export const getStrategiesHandler = async () => {
  const torghut = resolveTorghutDb()
  if (!torghut.ok) return jsonResponse({ ok: false, disabled: true, message: torghut.message }, 503)

  try {
    const items = await listTorghutTradingStrategies({ pool: torghut.pool, limit: 500 })
    return jsonResponse({ ok: true, items })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Torghut query failed'
    return jsonResponse({ ok: false, message }, 500)
  }
}
