import { createFileRoute } from '@tanstack/react-router'
import { fetchCodexIssuesFromAgentsService } from '@proompteng/agent-contracts/codex-runs-client'
import { errorResponse, okResponse } from '@proompteng/agent-contracts/json'

export const Route = createFileRoute('/api/codex/issues')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getCodexIssuesHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

const parseLimit = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(Math.floor(parsed), 500)
}

type CodexIssuesClient = typeof fetchCodexIssuesFromAgentsService

export const getCodexIssuesHandler = async (
  request: Request,
  client: CodexIssuesClient = fetchCodexIssuesFromAgentsService,
) => {
  const url = new URL(request.url)
  const repository = url.searchParams.get('repository')?.trim() ?? ''
  const limit = parseLimit(url.searchParams.get('limit'))

  if (!repository) {
    return errorResponse('repository is required')
  }

  try {
    const result = await client({ repository, limit: limit ?? undefined })
    if (!result.ok) {
      return errorResponse(
        result.error ?? `Agents Codex issues request failed with HTTP ${result.status}`,
        result.status || 502,
      )
    }
    return okResponse(result.body, result.status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500)
  }
}
