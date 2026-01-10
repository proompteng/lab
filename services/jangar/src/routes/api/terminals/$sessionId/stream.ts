import { createFileRoute } from '@tanstack/react-router'
import { fetchTerminalBackend, isTerminalBackendProxyEnabled } from '~/server/terminal-backend'
import { formatSessionId, getTerminalSession, getTerminalSnapshot } from '~/server/terminals'

export const Route = createFileRoute('/api/terminals/$sessionId/stream')({
  server: {
    handlers: {
      GET: async ({ params, request }) => streamHandler(params.sessionId, request),
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

const streamHandler = async (sessionId: string, _request: Request) => {
  if (isTerminalBackendProxyEnabled()) {
    const response = await fetchTerminalBackend(
      `api/terminals/${encodeURIComponent(sessionId)}/stream`,
      { method: 'GET' },
      0,
    )
    return response
  }

  const normalized = formatSessionId(sessionId)
  const session = await getTerminalSession(normalized)
  if (!session) {
    console.warn('[terminals] stream session not found', { sessionId: normalized })
    return jsonResponse({ ok: false, message: 'Session not found' }, 404)
  }
  if (session.status !== 'ready') {
    return jsonResponse({ ok: false, message: `Session not ready (${session.status}).` }, 409)
  }

  const snapshot = await getTerminalSnapshot(normalized)
  const body = snapshot ?? ''
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
