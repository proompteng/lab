import { createFileRoute } from '@tanstack/react-router'
import { fetchCodexRunsPageFromAgentsService } from '@proompteng/agent-contracts/codex-runs-client'
import { errorResponse, okResponse } from '@proompteng/agent-contracts/json'

export const Route = createFileRoute('/api/codex/runs/list')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getCodexRunsPageHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

const parseLimit = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(Math.floor(parsed), 200)
}

const parsePage = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}

type CodexRunsPageClient = typeof fetchCodexRunsPageFromAgentsService

export const getCodexRunsPageHandler = async (
  request: Request,
  client: CodexRunsPageClient = fetchCodexRunsPageFromAgentsService,
) => {
  const url = new URL(request.url)
  const repository = url.searchParams.get('repository')?.trim() ?? ''
  const page = parsePage(url.searchParams.get('page')) ?? 1
  const pageSize = parseLimit(url.searchParams.get('pageSize')) ?? 50

  try {
    const result = await client({
      repository: repository || undefined,
      page,
      pageSize,
    })
    if (!result.ok) {
      return errorResponse(
        result.error ?? `Agents Codex runs page request failed with HTTP ${result.status}`,
        result.status || 502,
      )
    }
    return okResponse(result.body, result.status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500)
  }
}
