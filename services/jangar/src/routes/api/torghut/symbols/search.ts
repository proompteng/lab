import { createFileRoute } from '@tanstack/react-router'

import { isValidTorghutSymbol, normalizeTorghutSymbol } from '~/server/torghut-symbols'

export const Route = createFileRoute('/api/torghut/symbols/search')({
  server: {
    handlers: {
      GET: async ({ request }) => searchTorghutSymbolsHandler(request),
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

const errorResponse = (message: string, status = 500) => jsonResponse({ ok: false, error: message }, status)

const parseLimit = (raw: string | null) => {
  if (!raw) return 25
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 25
  return Math.max(1, Math.min(Math.trunc(parsed), 50))
}

const parseAssetClass = (raw: string | null): 'equity' | 'crypto' => (raw === 'crypto' ? 'crypto' : 'equity')

const looksLikeExpectedAssetClass = (quoteType: string, assetClass: 'equity' | 'crypto') => {
  const normalized = quoteType.trim().toUpperCase()
  if (assetClass === 'crypto') {
    return normalized === 'CRYPTOCURRENCY'
  }
  return normalized === 'EQUITY' || normalized === 'ETF'
}

export const searchTorghutSymbolsHandler = async (request: Request) => {
  const url = new URL(request.url)
  const assetClass = parseAssetClass(url.searchParams.get('assetClass'))
  const limit = parseLimit(url.searchParams.get('limit'))
  const query = (url.searchParams.get('q') ?? '').trim()

  if (query.length === 0) {
    return jsonResponse({ ok: true, symbols: [] })
  }

  const searchUrl = new URL('https://query1.finance.yahoo.com/v1/finance/search')
  searchUrl.searchParams.set('q', query)
  searchUrl.searchParams.set('quotesCount', String(Math.min(limit * 4, 100)))
  searchUrl.searchParams.set('newsCount', '0')
  searchUrl.searchParams.set('listsCount', '0')
  searchUrl.searchParams.set('enableFuzzyQuery', 'false')

  try {
    const response = await fetch(searchUrl, {
      headers: {
        accept: 'application/json',
        'user-agent': 'jangar/torghut-symbols-search',
      },
    })

    if (!response.ok) {
      return errorResponse(`symbol_search_upstream_http_${response.status}`, 502)
    }

    const payload = (await response.json().catch(() => null)) as { quotes?: unknown[] } | null
    const quotes = Array.isArray(payload?.quotes) ? payload.quotes : []

    const symbols: string[] = []
    const seen = new Set<string>()

    for (const quote of quotes) {
      if (!quote || typeof quote !== 'object') continue
      const record = quote as Record<string, unknown>
      const symbolRaw = typeof record.symbol === 'string' ? record.symbol : ''
      const quoteTypeRaw = typeof record.quoteType === 'string' ? record.quoteType : ''
      if (!symbolRaw || !quoteTypeRaw) continue
      if (!looksLikeExpectedAssetClass(quoteTypeRaw, assetClass)) continue

      const symbol = normalizeTorghutSymbol(symbolRaw)
      if (!isValidTorghutSymbol(symbol, assetClass)) continue
      if (seen.has(symbol)) continue

      seen.add(symbol)
      symbols.push(symbol)
      if (symbols.length >= limit) break
    }

    return jsonResponse({ ok: true, symbols })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'symbol_search_upstream_error'
    return errorResponse(message, 502)
  }
}
