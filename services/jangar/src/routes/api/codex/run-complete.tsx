import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/codex/run-complete')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postRunComplete(request),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
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

export const postRunComplete = async (_request: Request) =>
  jsonResponse(
    {
      ok: false,
      error: 'Jangar no longer accepts Codex run-complete callbacks. Submit to Agents /api/agents/codex/run-complete.',
      replacement: '/api/agents/codex/run-complete',
    },
    410,
  )
