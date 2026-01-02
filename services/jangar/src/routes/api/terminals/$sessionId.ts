import { createFileRoute } from '@tanstack/react-router'
import { formatSessionId, getTerminalSession } from '~/server/terminals'

export const Route = createFileRoute('/api/terminals/$sessionId')({
  server: {
    handlers: {
      GET: async ({ params }) => getSessionHandler(params.sessionId),
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

const getSessionHandler = async (sessionId: string) => {
  const normalized = formatSessionId(sessionId)
  const session = await getTerminalSession(normalized)
  if (!session) return jsonResponse({ ok: false, message: 'Session not found' }, 404)
  return jsonResponse({ ok: true, session })
}
