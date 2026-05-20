import { createFileRoute } from '@tanstack/react-router'
import { submitAgentRunRerunToAgentsService } from '@proompteng/agent-contracts/agent-run-reruns-client'
import { errorResponse, okResponse, parseJsonBody } from '@proompteng/agent-contracts/json'

import { resolveAgentRunRerunForwardingPayload } from '~/server/codex-rerun-forwarding'

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
    const forwarding = await resolveAgentRunRerunForwardingPayload(payload)
    const result = await submitAgentRunRerunToAgentsService({
      agentRunId: forwarding.agentRunId,
      deliveryId: forwarding.deliveryId,
      payload: forwarding.payload,
    })
    if (!result.ok) {
      return errorResponse(
        result.error ?? `Agents rerun submit failed with HTTP ${result.status}`,
        result.status || 502,
      )
    }
    return okResponse(result.body, result.status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500)
  }
}
