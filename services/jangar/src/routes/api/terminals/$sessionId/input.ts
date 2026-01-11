import { createFileRoute } from '@tanstack/react-router'
import { isTerminalBackendProxyEnabled } from '~/server/terminal-backend'
import { ensureTerminalSessionExists, formatSessionId, getTerminalSession, sendTerminalInput } from '~/server/terminals'

export const Route = createFileRoute('/api/terminals/$sessionId/input')({
  server: {
    handlers: {
      POST: async ({ params, request }) => postInputHandler(params.sessionId, request),
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

const postInputHandler = async (sessionId: string, request: Request) => {
  const normalized = formatSessionId(sessionId)
  const session = await getTerminalSession(normalized)
  if (!session) {
    console.warn('[terminals] input session not found', { sessionId: normalized })
    return jsonResponse({ ok: false, message: 'Session not found' }, 404)
  }
  if (session.status !== 'ready') {
    return jsonResponse({ ok: false, message: `Session not ready (${session.status}).` }, 409)
  }
  if (!isTerminalBackendProxyEnabled()) {
    const exists = await ensureTerminalSessionExists(normalized)
    if (!exists) {
      console.warn('[terminals] input session not ready', { sessionId: normalized })
      return jsonResponse({ ok: false, message: 'Session not ready.' }, 409)
    }
  }

  const payload: unknown = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') return jsonResponse({ ok: false, message: 'invalid JSON body' }, 400)

  const data = (payload as Record<string, unknown>).data
  if (typeof data !== 'string' || data.length === 0) {
    return jsonResponse({ ok: false, message: 'data is required' }, 400)
  }

  try {
    const decoded = Buffer.from(data, 'base64').toString('utf8')
    if (decoded.length === 0) return jsonResponse({ ok: true })
    await sendTerminalInput(normalized, decoded)
    return jsonResponse({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to send input'
    console.warn('[terminals] input failed', { sessionId: normalized, message })
    return jsonResponse({ ok: false, message }, 500)
  }
}
