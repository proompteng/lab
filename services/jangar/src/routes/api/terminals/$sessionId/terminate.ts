import { createFileRoute } from '@tanstack/react-router'
import { formatSessionId, getTerminalSession, terminateTerminalSession } from '~/server/terminals'

export const Route = createFileRoute('/api/terminals/$sessionId/terminate')({
  server: {
    handlers: {
      POST: async ({ params }) => postTerminateHandler(params.sessionId),
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

const postTerminateHandler = async (sessionId: string) => {
  const normalized = formatSessionId(sessionId)
  const session = await getTerminalSession(normalized)
  if (!session) return jsonResponse({ ok: false, message: 'Session not found' }, 404)
  if (session.status === 'creating') {
    return jsonResponse({ ok: false, message: 'Session is still provisioning' }, 409)
  }

  try {
    await terminateTerminalSession(normalized)
    return jsonResponse({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to terminate session'
    return jsonResponse({ ok: false, message }, 500)
  }
}
