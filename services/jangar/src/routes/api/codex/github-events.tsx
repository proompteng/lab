import { createFileRoute } from '@tanstack/react-router'

import { handleGithubWebhookEvent } from '~/server/codex-judge'

export const Route = createFileRoute('/api/codex/github-events')({
  server: {
    handlers: {
      POST: async ({ request }) => postGithubEvents(request),
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

const postGithubEvents = async (request: Request) => {
  try {
    const payload = (await request.json()) as Record<string, unknown>
    const result = await handleGithubWebhookEvent(payload)
    return jsonResponse({ ok: true, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonResponse({ ok: false, error: message }, 500)
  }
}
