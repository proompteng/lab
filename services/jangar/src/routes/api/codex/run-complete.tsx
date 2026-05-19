import { createFileRoute } from '@tanstack/react-router'

import { handleRunComplete } from '~/server/codex-judge'
import { submitCodexCallbackToAgentsService, type AgentsCodexCallbackSubmitter } from '~/server/agents-service-proxy'

type PostRunCompleteDeps = {
  submitCodexCallback?: AgentsCodexCallbackSubmitter
  handleRunComplete?: (payload: Record<string, unknown>) => Promise<unknown>
}

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

export const postRunComplete = async (request: Request, deps: PostRunCompleteDeps = {}) => {
  try {
    const payload = (await request.json()) as Record<string, unknown>
    const agentsResult = await (deps.submitCodexCallback ?? submitCodexCallbackToAgentsService)({
      kind: 'run-complete',
      payload,
    })
    if (!agentsResult.ok) {
      return jsonResponse(
        {
          ok: false,
          error: agentsResult.error ?? 'Agents service Codex callback ingestion failed',
          agentsStatus: agentsResult.status,
        },
        agentsResult.status > 0 ? agentsResult.status : 502,
      )
    }

    const run = await (deps.handleRunComplete ?? handleRunComplete)(payload)
    return jsonResponse({ ok: true, agents: agentsResult.body, run })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonResponse({ ok: false, error: message }, 500)
  }
}
