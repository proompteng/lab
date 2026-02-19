import { createFileRoute } from '@tanstack/react-router'
import { getTorghutMarketContextHealth } from '~/server/torghut-market-context'

export const Route = createFileRoute('/api/torghut/market-context/health')({
  server: {
    handlers: {
      GET: async ({ request }) => getMarketContextHealthHandler(request),
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

export const getMarketContextHealthHandler = async (request: Request) => {
  const url = new URL(request.url)
  const symbol = url.searchParams.get('symbol')?.trim() || 'SPY'

  try {
    const health = await getTorghutMarketContextHealth(symbol)
    return jsonResponse({ ok: true, health })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'market context health failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}
