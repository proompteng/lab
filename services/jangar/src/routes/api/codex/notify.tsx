import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/codex/notify')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postNotify(request),
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

export const postNotify = async (_request: Request) =>
  jsonResponse(
    {
      ok: false,
      error: 'Jangar no longer accepts Codex notify callbacks. Submit to Agents /api/agents/codex/notify.',
      replacement: '/api/agents/codex/notify',
    },
    410,
  )
