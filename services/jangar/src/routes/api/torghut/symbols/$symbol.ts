import { createFileRoute } from '@tanstack/react-router'
import { getDb } from '~/server/db'
import { deleteTorghutSymbol, setTorghutSymbolEnabled } from '~/server/torghut-symbols'

export const Route = createFileRoute('/api/torghut/symbols/$symbol')({
  server: {
    handlers: {
      PATCH: async ({ params, request }: JangarServerRouteArgs) => patchSymbolHandler(params.symbol, request),
      DELETE: async ({ params, request }: JangarServerRouteArgs) => deleteSymbolHandler(params.symbol, request),
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

export const patchSymbolHandler = async (symbol: string, request: Request) => {
  const db = getDb()
  if (!db) return jsonResponse({ error: 'DATABASE_URL is not configured' }, 503)

  const payload: unknown = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') return jsonResponse({ error: 'invalid JSON body' }, 400)
  const enabled = (payload as Record<string, unknown>).enabled
  if (enabled !== true && enabled !== false) return jsonResponse({ error: 'enabled must be boolean' }, 400)
  const assetClass = (payload as Record<string, unknown>).assetClass
  if (assetClass !== undefined && assetClass !== 'equity' && assetClass !== 'crypto') {
    return jsonResponse({ error: 'assetClass must be equity or crypto' }, 400)
  }

  await setTorghutSymbolEnabled({ db, symbol, enabled, assetClass })
  return jsonResponse({ ok: true })
}

export const deleteSymbolHandler = async (symbol: string, request: Request) => {
  const db = getDb()
  if (!db) return jsonResponse({ error: 'DATABASE_URL is not configured' }, 503)

  const url = new URL(request.url)
  const assetClassRaw = url.searchParams.get('assetClass')
  const assetClass = assetClassRaw === 'crypto' ? 'crypto' : assetClassRaw === 'equity' ? 'equity' : undefined

  const deleted = await deleteTorghutSymbol({ db, symbol, assetClass })
  if (deleted < 1) return jsonResponse({ error: `${symbol} was not found` }, 404)
  return jsonResponse({ ok: true, deleted })
}
