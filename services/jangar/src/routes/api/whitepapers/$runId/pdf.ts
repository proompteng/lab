import { createFileRoute } from '@tanstack/react-router'
import { resolveTorghutDb } from '~/server/torghut-trading-db'
import { getTorghutWhitepaperPdfLocator, streamTorghutWhitepaperPdf } from '~/server/torghut-whitepapers'

export const Route = createFileRoute('/api/whitepapers/$runId/pdf')({
  server: {
    handlers: {
      GET: async ({ params }) => getWhitepaperPdfHandler(params.runId),
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

export const getWhitepaperPdfHandler = async (runIdRaw: string) => {
  const torghut = resolveTorghutDb()
  if (!torghut.ok) return jsonResponse({ ok: false, disabled: true, message: torghut.message }, 503)

  const runId = runIdRaw.trim()
  if (!runId) return jsonResponse({ ok: false, message: 'run id is required' }, 400)

  try {
    const locator = await getTorghutWhitepaperPdfLocator({ pool: torghut.pool, runId })
    if (!locator) return jsonResponse({ ok: false, message: 'whitepaper run not found' }, 404)

    const response = await streamTorghutWhitepaperPdf(locator)
    if (response) return response

    return jsonResponse({ ok: false, message: 'whitepaper pdf unavailable' }, 502)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to stream whitepaper pdf'
    return jsonResponse({ ok: false, message }, 500)
  }
}
