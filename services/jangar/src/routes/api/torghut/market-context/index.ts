import { createFileRoute } from '@tanstack/react-router'
import { getTorghutMarketContext } from '~/server/torghut-market-context'

export const Route = createFileRoute('/api/torghut/market-context/')({
  server: {
    handlers: {
      GET: async ({ request }) => getMarketContextHandler(request),
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

export const getMarketContextHandler = async (request: Request) => {
  const url = new URL(request.url)
  const symbol = url.searchParams.get('symbol')?.trim() ?? ''
  if (!symbol) return jsonResponse({ ok: false, message: 'symbol is required' }, 400)

  const asOfRaw = url.searchParams.get('asOf')?.trim() ?? ''
  let asOf: Date | undefined
  if (asOfRaw) {
    const parsed = new Date(asOfRaw)
    if (Number.isNaN(parsed.getTime()))
      return jsonResponse({ ok: false, message: 'asOf must be an ISO timestamp' }, 400)
    asOf = parsed
  }

  try {
    const context = await getTorghutMarketContext(symbol, { asOf })
    return jsonResponse({ ok: true, context })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'market context query failed'
    return jsonResponse({ ok: false, message }, 500)
  }
}
