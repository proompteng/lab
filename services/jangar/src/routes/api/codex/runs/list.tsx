import { createFileRoute } from '@tanstack/react-router'
import { errorResponse, okResponse } from '@proompteng/agent-contracts/json'

import { type CodexJudgeStore, createCodexJudgeStore } from '~/server/codex-judge-store'

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

type CodexRunsPageStore = Pick<CodexJudgeStore, 'listRunsPage' | 'close' | 'ready'>

export const getCodexRunsPageHandler = async (
  request: Request,
  storeFactory: () => CodexRunsPageStore = createCodexJudgeStore,
) => {
  const url = new URL(request.url)
  const repository = url.searchParams.get('repository')?.trim() ?? ''
  const page = parsePage(url.searchParams.get('page')) ?? 1
  const pageSize = parseLimit(url.searchParams.get('pageSize')) ?? 50

  const store = storeFactory()
  try {
    await store.ready
    const result = await store.listRunsPage({
      repository: repository || undefined,
      page,
      pageSize,
    })
    return okResponse({ ok: true, runs: result.runs, total: result.total })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}
