import { createFileRoute } from '@tanstack/react-router'

import { type CodexJudgeStore, createCodexJudgeStore } from '~/server/codex-judge-store'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

type RunsQuery = {
  repository: string
  issueNumber: number
  branch?: string
  limit: number
}

export const Route = createFileRoute('/api/codex/runs')({
  server: {
    handlers: {
      GET: async ({ request }) => getCodexRunsHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
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

const errorResponse = (message: string, status = 500) => jsonResponse({ ok: false, error: message }, status)

const resolveServiceError = (message: string) => {
  if (message.includes('DATABASE_URL')) return errorResponse(message, 503)
  return errorResponse(message, 500)
}

const clampLimit = (raw: string | null) => {
  if (!raw) return DEFAULT_LIMIT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, parsed))
}

const parseIssueNumber = (raw: string | null) => {
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

const parseRunsQuery = (request: Request): { ok: true; value: RunsQuery } | { ok: false; message: string } => {
  try {
    const url = new URL(request.url)
    const repository = (url.searchParams.get('repository') ?? '').trim()
    if (!repository) {
      return { ok: false, message: 'Repository is required.' }
    }

    const issueNumber =
      parseIssueNumber(url.searchParams.get('issueNumber')) ?? parseIssueNumber(url.searchParams.get('issue_number'))
    if (!issueNumber) {
      return { ok: false, message: 'Issue number is required.' }
    }

    const branch = (url.searchParams.get('branch') ?? '').trim() || undefined
    const limit = clampLimit(url.searchParams.get('limit'))

    return { ok: true, value: { repository, issueNumber, branch, limit } }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Invalid query parameters.' }
  }
}

let defaultStore: CodexJudgeStore | null = null

const getDefaultStore = () => {
  if (!defaultStore) {
    defaultStore = createCodexJudgeStore()
  }
  return defaultStore
}

export const getCodexRunsHandler = async (request: Request, store?: CodexJudgeStore) => {
  const parsed = parseRunsQuery(request)
  if (!parsed.ok) return errorResponse(parsed.message, 400)

  try {
    const resolvedStore = store ?? getDefaultStore()
    const { repository, issueNumber, branch, limit } = parsed.value
    const [runs, stats] = await Promise.all([
      resolvedStore.listRunHistory({ repository, issueNumber, branch, limit }),
      resolvedStore.getRunStats({ repository, issueNumber, branch }),
    ])

    return jsonResponse({
      ok: true,
      runs,
      stats: {
        completion_rate: stats.completionRate,
        avg_attempts_per_issue: stats.avgAttemptsPerIssue,
        failure_reason_counts: stats.failureReasonCounts,
        avg_ci_duration: stats.avgCiDuration,
        avg_judge_confidence: stats.avgJudgeConfidence,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return resolveServiceError(message)
  }
}
