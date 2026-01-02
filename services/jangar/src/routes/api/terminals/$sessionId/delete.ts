import { createFileRoute } from '@tanstack/react-router'
import { deleteTerminalSession, formatSessionId } from '~/server/terminals'

export const Route = createFileRoute('/api/terminals/$sessionId/delete')({
  server: {
    handlers: {
      POST: async ({ params }) => deleteSessionHandler(params.sessionId),
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

const deleteSessionHandler = async (sessionId: string) => {
  const normalized = formatSessionId(sessionId)
  try {
    await deleteTerminalSession(normalized)
    return jsonResponse({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to delete terminal session'
    return jsonResponse({ ok: false, message }, 500)
  }
}
