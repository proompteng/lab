import { createFileRoute } from '@tanstack/react-router'
import { getMarketContextProviderResult } from '~/server/torghut-market-context-agents'

export const Route = createFileRoute('/api/torghut/market-context/providers/fundamentals')({
  server: {
    handlers: {
      GET: async ({ request }) => getFundamentalsProviderHandler(request),
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

export const getFundamentalsProviderHandler = async (request: Request) => {
  const url = new URL(request.url)
  const symbol = url.searchParams.get('symbol')?.trim() ?? ''
  if (!symbol) return jsonResponse({ ok: false, message: 'symbol is required' }, 400)

  try {
    const result = await getMarketContextProviderResult({ domain: 'fundamentals', symbolInput: symbol })
    return jsonResponse({ ok: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'fundamentals provider failed'
    return jsonResponse({ ok: false, message }, 500)
  }
}
