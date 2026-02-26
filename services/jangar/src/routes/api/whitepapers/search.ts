import { createFileRoute } from '@tanstack/react-router'
import { searchTorghutWhitepapersSemantic } from '~/server/torghut-whitepapers'

export const Route = createFileRoute('/api/whitepapers/search')({
  server: {
    handlers: {
      GET: async ({ request }) => getWhitepaperSemanticSearchHandler(request),
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

const parseInteger = (value: string | null | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

const parseFilterValue = (value: string | null): string | undefined => {
  if (value === null) return undefined
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

const inferStatusCode = (message: string): number => {
  const matched = message.match(/whitepaper_semantic_search_failed:(\d{3}):/)
  if (!matched) return 502
  const parsed = Number.parseInt(matched[1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : 502
}

export const getWhitepaperSemanticSearchHandler = async (request: Request) => {
  const url = new URL(request.url)
  const query = parseFilterValue(url.searchParams.get('q'))
  if (!query) return jsonResponse({ ok: false, message: 'q is required' }, 400)

  const limit = parseInteger(url.searchParams.get('limit'))
  const offset = parseInteger(url.searchParams.get('offset'))
  const status = parseFilterValue(url.searchParams.get('status'))
  const subject = parseFilterValue(url.searchParams.get('subject'))
  const scopeRaw = parseFilterValue(url.searchParams.get('scope'))
  const scope = scopeRaw === 'all' || scopeRaw === 'full_text' || scopeRaw === 'synthesis' ? scopeRaw : undefined

  try {
    const result = await searchTorghutWhitepapersSemantic({
      query,
      limit,
      offset,
      status,
      scope,
      subject,
    })
    return jsonResponse({ ok: true, ...result }, 200)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Whitepaper semantic search failed'
    return jsonResponse({ ok: false, message }, inferStatusCode(message))
  }
}
