import { createFileRoute } from '@tanstack/react-router'
import { createTerminalSession, listTerminalSessions } from '~/server/terminals'

export const Route = createFileRoute('/api/terminals')({
  server: {
    handlers: {
      GET: async ({ request }) => listSessionsHandler(request),
      POST: async ({ request }) => createSessionHandler(request),
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

const listSessionsHandler = async (request: Request) => {
  try {
    const url = new URL(request.url)
    if (url.searchParams.get('create') === '1') {
      const session = await createTerminalSession()
      const status = session.status === 'creating' ? 202 : 201
      return jsonResponse({ ok: true, session }, status)
    }
    const sessions = await listTerminalSessions()
    return jsonResponse({ ok: true, sessions })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to list terminal sessions'
    return jsonResponse({ ok: false, message }, 500)
  }
}

const createSessionHandler = async (request: Request) => {
  try {
    await request.text().catch(() => '')
    const session = await createTerminalSession()
    const status = session.status === 'creating' ? 202 : 201
    return jsonResponse({ ok: true, session }, status)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create terminal session'
    return jsonResponse({ ok: false, message }, 500)
  }
}
