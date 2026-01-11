import { createFileRoute } from '@tanstack/react-router'
import { isTerminalBackendProxyEnabled } from '~/server/terminal-backend'
import {
  ensureTerminalSessionExists,
  formatSessionId,
  getTerminalSession,
  resizeTerminalSession,
} from '~/server/terminals'

export const Route = createFileRoute('/api/terminals/$sessionId/resize')({
  server: {
    handlers: {
      POST: async ({ params, request }) => postResizeHandler(params.sessionId, request),
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

const postResizeHandler = async (sessionId: string, request: Request) => {
  const normalized = formatSessionId(sessionId)
  const session = await getTerminalSession(normalized)
  if (!session) return jsonResponse({ ok: false, message: 'Session not found' }, 404)
  if (session.status !== 'ready') {
    return jsonResponse({ ok: false, message: `Session not ready (${session.status}).` }, 409)
  }
  if (!isTerminalBackendProxyEnabled()) {
    const exists = await ensureTerminalSessionExists(normalized)
    if (!exists) return jsonResponse({ ok: false, message: 'Session not ready.' }, 409)
  }

  const payload: unknown = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') return jsonResponse({ ok: false, message: 'invalid JSON body' }, 400)

  const cols = (payload as Record<string, unknown>).cols
  const rows = (payload as Record<string, unknown>).rows
  if (typeof cols !== 'number' || typeof rows !== 'number') {
    return jsonResponse({ ok: false, message: 'cols and rows must be numbers' }, 400)
  }

  try {
    await resizeTerminalSession(normalized, cols, rows)
    return jsonResponse({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to resize terminal'
    return jsonResponse({ ok: false, message }, 500)
  }
}
