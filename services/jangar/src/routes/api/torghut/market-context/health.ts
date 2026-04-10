import { createFileRoute } from '@tanstack/react-router'
import { resolveTorghutEndpointsConfig } from '~/server/torghut-config'
import { getTorghutMarketContextHealth } from '~/server/torghut-market-context'
import { normalizeTorghutSymbol } from '~/server/torghut-symbols'

export const Route = createFileRoute('/api/torghut/market-context/health')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getMarketContextHealthHandler(request),
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

const resolveDefaultHealthSymbol = () =>
  normalizeTorghutSymbol(resolveTorghutEndpointsConfig(process.env).marketContextHealthDefaultSymbol)

export const getMarketContextHealthHandler = async (request: Request) => {
  const url = new URL(request.url)
  const rawSymbol = url.searchParams.get('symbol')?.trim()
  const symbol = rawSymbol && rawSymbol.length > 0 ? normalizeTorghutSymbol(rawSymbol) : resolveDefaultHealthSymbol()

  try {
    const health = await getTorghutMarketContextHealth(symbol)
    return jsonResponse({ ok: true, health })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'market context health failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}
