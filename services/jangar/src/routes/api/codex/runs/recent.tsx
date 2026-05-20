import { createFileRoute } from '@tanstack/react-router'
import { errorResponse, okResponse } from '@proompteng/agent-contracts/json'

import { type CodexJudgeStore, createCodexJudgeStore } from '~/server/codex-judge-store'

export const Route = createFileRoute('/api/codex/runs/recent')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getCodexRecentRunsHandler(request),
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

type CodexRecentRunsStore = Pick<CodexJudgeStore, 'listRecentRuns' | 'close' | 'ready'>

export const getCodexRecentRunsHandler = async (
  request: Request,
  storeFactory: () => CodexRecentRunsStore = createCodexJudgeStore,
) => {
  const url = new URL(request.url)
  const repository = url.searchParams.get('repository')?.trim() ?? ''
  const limit = parseLimit(url.searchParams.get('limit'))

  const store = storeFactory()
  try {
    await store.ready
    const runs = await store.listRecentRuns({
      repository: repository || undefined,
      limit: limit ?? undefined,
    })
    return okResponse({ ok: true, runs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}
