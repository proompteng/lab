import { createFileRoute } from '@tanstack/react-router'
import { getDb } from '~/server/db'
import { listTorghutSymbols, upsertTorghutSymbols } from '~/server/torghut-symbols'

export const Route = createFileRoute('/api/torghut/symbols')({
  server: {
    handlers: {
      GET: async ({ request }) => getSymbolsHandler(request),
      POST: async ({ request }) => upsertSymbolsHandler(request),
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

const parseBool = (raw: string | null) => {
  if (!raw) return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

export const getSymbolsHandler = async (request: Request) => {
  const db = getDb()
  if (!db) return jsonResponse({ error: 'DATABASE_URL is not configured' }, 503)

  const url = new URL(request.url)
  const assetClass = url.searchParams.get('assetClass') === 'crypto' ? 'crypto' : 'equity'
  const includeDisabled = parseBool(url.searchParams.get('includeDisabled')) ?? false
  const format = url.searchParams.get('format') ?? 'compact'

  const items = await listTorghutSymbols({ db, assetClass, includeDisabled })
  if (format === 'full') return jsonResponse({ items })
  return jsonResponse({ symbols: items.filter((item) => item.enabled).map((item) => item.symbol) })
}

const coerceSymbols = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/g)
      .map((symbol) => symbol.trim())
      .filter((symbol) => symbol.length > 0)
  }
  return []
}

export const upsertSymbolsHandler = async (request: Request) => {
  const db = getDb()
  if (!db) return jsonResponse({ error: 'DATABASE_URL is not configured' }, 503)

  const payload: unknown = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') return jsonResponse({ error: 'invalid JSON body' }, 400)

  const symbols = coerceSymbols(
    (payload as Record<string, unknown>).symbols ?? (payload as Record<string, unknown>).symbolsText,
  )
  const enabled = ((payload as Record<string, unknown>).enabled ?? true) === true
  const assetClass = (payload as Record<string, unknown>).assetClass === 'crypto' ? 'crypto' : 'equity'

  const result = await upsertTorghutSymbols({ db, symbols, enabled, assetClass })
  return jsonResponse(result)
}
