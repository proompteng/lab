import { createFileRoute } from '@tanstack/react-router'
import { postCodexGithubEventToAgentsService } from '@proompteng/agent-contracts/codex-runs-client'
import { errorResponse, okResponse, parseJsonBody } from '@proompteng/agent-contracts/json'

export const Route = createFileRoute('/api/codex/github-events')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postGithubEventsHandler(request),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

type CodexGithubEventsClient = typeof postCodexGithubEventToAgentsService

export const postGithubEventsHandler = async (
  request: Request,
  client: CodexGithubEventsClient = postCodexGithubEventToAgentsService,
) => {
  try {
    const payload = await parseJsonBody(request)
    const result = await client(payload)
    if (!result.ok) {
      return errorResponse(result.error ?? 'Agents Codex GitHub event forwarding failed', result.status || 502)
    }
    return okResponse(result.body, result.status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500)
  }
}
