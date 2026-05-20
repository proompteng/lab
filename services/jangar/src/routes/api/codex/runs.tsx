import { createFileRoute } from '@tanstack/react-router'
import { fetchCodexRunHistoryFromAgentsService } from '@proompteng/agent-contracts/codex-runs-client'
import { errorResponse, okResponse } from '@proompteng/agent-contracts/json'

export const Route = createFileRoute('/api/codex/runs')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getCodexRunsHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

const parseIssueNumber = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const parseLimit = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(Math.floor(parsed), 100)
}

type CodexRunsClient = typeof fetchCodexRunHistoryFromAgentsService

export const getCodexRunsHandler = async (
  request: Request,
  client: CodexRunsClient = fetchCodexRunHistoryFromAgentsService,
) => {
  const url = new URL(request.url)
  const repository = url.searchParams.get('repository')?.trim() ?? ''
  const issueNumber =
    parseIssueNumber(url.searchParams.get('issueNumber')) ?? parseIssueNumber(url.searchParams.get('issue_number'))
  const branch = url.searchParams.get('branch')?.trim() ?? null
  const limit = parseLimit(url.searchParams.get('limit'))

  if (!repository) {
    return errorResponse('repository is required')
  }
  if (!issueNumber) {
    return errorResponse('issueNumber is required')
  }

  try {
    const result = await client({
      repository,
      issueNumber,
      branch: branch || undefined,
      limit: limit ?? undefined,
    })
    if (!result.ok) {
      return errorResponse(
        result.error ?? `Agents Codex runs request failed with HTTP ${result.status}`,
        result.status || 502,
      )
    }
    return okResponse(result.body, result.status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500)
  }
}
