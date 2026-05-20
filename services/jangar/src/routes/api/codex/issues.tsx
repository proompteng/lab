import { createFileRoute } from '@tanstack/react-router'
import { errorResponse, okResponse } from '@proompteng/agent-contracts/json'

import { type CodexJudgeStore, createCodexJudgeStore } from '~/server/codex-judge-store'

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

type CodexIssuesStore = Pick<CodexJudgeStore, 'listIssueSummaries' | 'close' | 'ready'>

export const getCodexIssuesHandler = async (
  request: Request,
  storeFactory: () => CodexIssuesStore = createCodexJudgeStore,
) => {
  const url = new URL(request.url)
  const repository = url.searchParams.get('repository')?.trim() ?? ''
  const limit = parseLimit(url.searchParams.get('limit'))

  if (!repository) {
    return errorResponse('repository is required')
  }

  const store = storeFactory()
  try {
    await store.ready
    const issues = await store.listIssueSummaries(repository, limit ?? undefined)
    return okResponse({ ok: true, issues })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}
