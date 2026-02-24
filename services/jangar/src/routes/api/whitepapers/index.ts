import { createFileRoute } from '@tanstack/react-router'
import { resolveTorghutDb } from '~/server/torghut-trading-db'
import { listTorghutWhitepapers } from '~/server/torghut-whitepapers'

export const Route = createFileRoute('/api/whitepapers/')({
  server: {
    handlers: {
      GET: async ({ request }) => getWhitepapersHandler(request),
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

export const getWhitepapersHandler = async (request: Request) => {
  const torghut = resolveTorghutDb()
  if (!torghut.ok) return jsonResponse({ ok: false, disabled: true, message: torghut.message }, 503)

  const url = new URL(request.url)
  const limit = parseInteger(url.searchParams.get('limit'))
  const offset = parseInteger(url.searchParams.get('offset'))
  const query = parseFilterValue(url.searchParams.get('q'))
  const status = parseFilterValue(url.searchParams.get('status'))
  const verdict = parseFilterValue(url.searchParams.get('verdict'))

  try {
    const result = await listTorghutWhitepapers({
      pool: torghut.pool,
      limit,
      offset,
      query,
      status,
      verdict,
    })

    return jsonResponse({
      ok: true,
      ...result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load whitepaper library'
    return jsonResponse({ ok: false, message }, 500)
  }
}
