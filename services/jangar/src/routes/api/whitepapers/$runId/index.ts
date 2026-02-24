import { createFileRoute } from '@tanstack/react-router'
import { resolveTorghutDb } from '~/server/torghut-trading-db'
import { getTorghutWhitepaperDetail } from '~/server/torghut-whitepapers'

export const Route = createFileRoute('/api/whitepapers/$runId/')({
  server: {
    handlers: {
      GET: async ({ params }) => getWhitepaperDetailHandler(params.runId),
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

export const getWhitepaperDetailHandler = async (runIdRaw: string) => {
  const torghut = resolveTorghutDb()
  if (!torghut.ok) return jsonResponse({ ok: false, disabled: true, message: torghut.message }, 503)

  const runId = runIdRaw.trim()
  if (!runId) return jsonResponse({ ok: false, message: 'run id is required' }, 400)

  try {
    const item = await getTorghutWhitepaperDetail({ pool: torghut.pool, runId })
    if (!item) return jsonResponse({ ok: false, message: 'whitepaper run not found' }, 404)

    return jsonResponse({ ok: true, item })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load whitepaper run'
    return jsonResponse({ ok: false, message }, 500)
  }
}
