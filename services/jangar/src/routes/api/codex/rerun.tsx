import { createFileRoute } from '@tanstack/react-router'
import { errorResponse, okResponse, parseJsonBody } from '@proompteng/agent-contracts/json'

import { handleRerunRequest } from '~/server/codex-judge'

export const Route = createFileRoute('/api/codex/rerun')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postRerun(request),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

const postRerun = async (request: Request) => {
  try {
    const payload = await parseJsonBody(request)
    const result = await handleRerunRequest(payload)
    return okResponse({ ok: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500)
  }
}
