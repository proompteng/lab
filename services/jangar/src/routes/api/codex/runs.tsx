import { createFileRoute } from '@tanstack/react-router'
import { errorResponse, okResponse } from '@proompteng/agent-contracts/json'

import { type CodexJudgeStore, createCodexJudgeStore } from '~/server/codex-judge-store'

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

type CodexRunsStore = Pick<CodexJudgeStore, 'getRunHistory' | 'close' | 'ready'>

export const getCodexRunsHandler = async (
  request: Request,
  storeFactory: () => CodexRunsStore = createCodexJudgeStore,
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

  const store = storeFactory()
  try {
    await store.ready
    const history = await store.getRunHistory({
      repository,
      issueNumber,
      branch: branch || undefined,
      limit: limit ?? undefined,
    })
    return okResponse({ ok: true, ...history })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}
