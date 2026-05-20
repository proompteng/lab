import { Data, Effect } from 'effect'

import {
  createCodexRunProjectionStore,
  type CodexRunProjectionStore,
  type CodexRunRecord,
} from '../codex-run-projection-store'
import { errorResponse, okResponse, parseJsonBody } from '../http'

type CodexGithubEventsStore = Pick<
  CodexRunProjectionStore,
  | 'ready'
  | 'close'
  | 'listRunsByBranch'
  | 'listRunsByCommitSha'
  | 'listRunsByPrNumber'
  | 'updateCiStatus'
  | 'updateReviewStatus'
  | 'updateRunPrInfo'
>

export type CodexGithubEventsApiDependencies = {
  storeFactory?: () => CodexGithubEventsStore
}

class CodexGithubEventRequestError extends Data.TaggedError('CodexGithubEventRequestError')<{
  readonly message: string
  readonly status: 400 | 422
}> {}

class CodexGithubEventStorageError extends Data.TaggedError('CodexGithubEventStorageError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

type CodexGithubEventError = CodexGithubEventRequestError | CodexGithubEventStorageError

type GithubWebhookStreamEvent = {
  event: string
  action: string | null
  deliveryId: string | null
  repository: string | null
  payload: Record<string, unknown>
}

const SUPPORTED_EVENTS = new Set([
  'check_run',
  'check_suite',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
])

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const normalizeOptionalString = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeOptionalNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const normalizeSha = (value: unknown) => {
  const normalized = normalizeOptionalString(value)
  return normalized && /^[a-f0-9]{7,40}$/i.test(normalized) ? normalized : null
}

const extractRepositoryFromWebhookPayload = (payload: Record<string, unknown>) => {
  if (isRecord(payload.repository)) {
    const fullName = payload.repository.full_name
    if (typeof fullName === 'string' && fullName.trim().length > 0) return fullName.trim()
  }
  if (
    isRecord(payload.pull_request) &&
    isRecord(payload.pull_request.base) &&
    isRecord(payload.pull_request.base.repo)
  ) {
    const fullName = payload.pull_request.base.repo.full_name
    if (typeof fullName === 'string' && fullName.trim().length > 0) return fullName.trim()
  }
  if (isRecord(payload.issue) && typeof payload.issue.repository_url === 'string') {
    try {
      const parsed = new URL(payload.issue.repository_url)
      const segments = parsed.pathname.split('/').filter(Boolean)
      const owner = segments.at(-2)
      const repo = segments.at(-1)
      if (owner && repo) return `${owner}/${repo}`
    } catch {
      return null
    }
  }
  return null
}

const parseGithubWebhookEvent = (payload: Record<string, unknown>): GithubWebhookStreamEvent => {
  const rawPayload = isRecord(payload.payload) ? payload.payload : payload
  return {
    event:
      normalizeOptionalString(
        payload.event ?? payload.event_type ?? payload.eventType ?? payload.name ?? payload['x-github-event'],
      ) ?? '',
    action:
      normalizeOptionalString(
        payload.action ?? payload.event_action ?? payload.eventAction ?? payload['x-github-action'],
      ) ?? null,
    deliveryId:
      normalizeOptionalString(
        payload.deliveryId ?? payload.delivery_id ?? payload['x-github-delivery'] ?? payload.id ?? payload.key,
      ) ?? null,
    repository:
      normalizeOptionalString(payload.repository) ??
      normalizeOptionalString(payload.repository_full_name) ??
      extractRepositoryFromWebhookPayload(rawPayload),
    payload: rawPayload,
  }
}

const extractPullRequestInfo = (payload: Record<string, unknown>) => {
  const pr = isRecord(payload.pull_request) ? payload.pull_request : null
  if (!pr) return { number: null, url: null, headSha: null, headRef: null, state: null, merged: null }
  const number = normalizeOptionalNumber(pr.number)
  const url = normalizeOptionalString(pr.html_url ?? pr.url)
  const head = isRecord(pr.head) ? pr.head : null
  const headSha = head ? normalizeSha(head.sha) : null
  const headRef = head ? normalizeOptionalString(head.ref) : null
  const state = normalizeOptionalString(pr.state)
  const merged = typeof pr.merged === 'boolean' ? pr.merged : null
  return { number, url, headSha, headRef, state, merged }
}

const extractCheckPayload = (payload: Record<string, unknown>) => {
  if (isRecord(payload.check_run)) return payload.check_run
  if (isRecord(payload.check_suite)) return payload.check_suite
  return null
}

const extractCheckPullRequests = (check: Record<string, unknown>) => {
  const pullRequests = Array.isArray(check.pull_requests) ? check.pull_requests : []
  return pullRequests
    .map((entry) => (isRecord(entry) ? normalizeOptionalNumber(entry.number) : null))
    .filter((value): value is number => value != null)
}

const deriveCiStatus = (status: string | null, conclusion: string | null) => {
  if ((status?.trim().toLowerCase() ?? '') !== 'completed') return 'pending'
  const normalizedConclusion = conclusion?.trim().toLowerCase() ?? ''
  if (!normalizedConclusion) return 'pending'
  if (normalizedConclusion === 'success' || normalizedConclusion === 'skipped') return 'success'
  return 'failure'
}

const isPullRequestIssueComment = (payload: Record<string, unknown>) =>
  Boolean(isRecord(payload.issue) && payload.issue.pull_request)

const extractIssueCommentPrNumber = (payload: Record<string, unknown>) =>
  isRecord(payload.issue) ? normalizeOptionalNumber(payload.issue.number) : null

const dedupeRuns = (runs: CodexRunRecord[]) => {
  const seen = new Map<string, CodexRunRecord>()
  for (const run of runs) {
    seen.set(run.id, run)
  }
  return [...seen.values()]
}

const openStore = (deps: CodexGithubEventsApiDependencies = {}) =>
  Effect.try({
    try: () => (deps.storeFactory ?? createCodexRunProjectionStore)(),
    catch: (cause) => new CodexGithubEventStorageError({ operation: 'open-codex-run-projection-store', cause }),
  })

const readyStore = (store: CodexGithubEventsStore) =>
  Effect.tryPromise({
    try: () => store.ready,
    catch: (cause) => new CodexGithubEventStorageError({ operation: 'ready-codex-run-projection-store', cause }),
  })

const closeStore = (store: CodexGithubEventsStore) =>
  Effect.promise(() =>
    store.close().catch((error) => {
      console.warn('[agents] failed to close Codex GitHub event projection store', error)
    }),
  )

const listRunsByPrNumbers = (store: CodexGithubEventsStore, repository: string, prNumbers: number[]) =>
  Effect.tryPromise({
    try: async () => {
      const runs: CodexRunRecord[] = []
      for (const prNumber of prNumbers) {
        runs.push(...(await store.listRunsByPrNumber(repository, prNumber)))
      }
      return dedupeRuns(runs)
    },
    catch: (cause) => new CodexGithubEventStorageError({ operation: 'list-codex-runs-by-pr', cause }),
  })

const resolveRunsForCommitOrPr = (
  store: CodexGithubEventsStore,
  repository: string,
  commitSha: string | null,
  prNumbers: number[],
) =>
  Effect.gen(function* () {
    if (commitSha) {
      const byCommit = yield* Effect.tryPromise({
        try: () => store.listRunsByCommitSha(repository, commitSha),
        catch: (cause) => new CodexGithubEventStorageError({ operation: 'list-codex-runs-by-commit', cause }),
      })
      if (byCommit.length > 0) return dedupeRuns(byCommit)
    }
    return yield* listRunsByPrNumbers(store, repository, prNumbers)
  })

const handleCheckEvent = (store: CodexGithubEventsStore, event: GithubWebhookStreamEvent) =>
  Effect.gen(function* () {
    const repository = event.repository
    const check = extractCheckPayload(event.payload)
    if (!repository || !check) return { updatedRunIds: [] as string[], status: null as string | null }
    const commitSha = normalizeSha(check.head_sha ?? check.headSha)
    const prNumbers = extractCheckPullRequests(check)
    const ciStatus = deriveCiStatus(normalizeOptionalString(check.status), normalizeOptionalString(check.conclusion))
    const ciUrl = normalizeOptionalString(check.html_url ?? check.details_url ?? check.url)
    const runs = yield* resolveRunsForCommitOrPr(store, repository, commitSha, prNumbers)
    const updatedRunIds: string[] = []
    for (const run of runs) {
      const updated = yield* Effect.tryPromise({
        try: () => store.updateCiStatus({ runId: run.id, status: ciStatus, url: ciUrl, commitSha }),
        catch: (cause) => new CodexGithubEventStorageError({ operation: 'update-codex-ci-projection', cause }),
      })
      if (updated) updatedRunIds.push(updated.id)
    }
    return { updatedRunIds, status: ciStatus }
  })

const handlePullRequestEvent = (store: CodexGithubEventsStore, event: GithubWebhookStreamEvent) =>
  Effect.gen(function* () {
    const repository = event.repository
    const pr = extractPullRequestInfo(event.payload)
    if (!repository || !pr.number) return { updatedRunIds: [] as string[] }
    const byBranch = pr.headRef
      ? yield* Effect.tryPromise({
          try: () => store.listRunsByBranch(repository, pr.headRef as string),
          catch: (cause) => new CodexGithubEventStorageError({ operation: 'list-codex-runs-by-branch', cause }),
        })
      : []
    const byCommit =
      byBranch.length === 0 && pr.headSha
        ? yield* Effect.tryPromise({
            try: () => store.listRunsByCommitSha(repository, pr.headSha as string),
            catch: (cause) => new CodexGithubEventStorageError({ operation: 'list-codex-runs-by-commit', cause }),
          })
        : []
    const byPr =
      byBranch.length === 0 && byCommit.length === 0 ? yield* listRunsByPrNumbers(store, repository, [pr.number]) : []
    const runs = dedupeRuns([...byBranch, ...byCommit, ...byPr])
    const prUrl = pr.url ?? `https://github.com/${repository}/pull/${pr.number}`
    const updatedRunIds: string[] = []
    for (const run of runs) {
      const updated = yield* Effect.tryPromise({
        try: () => store.updateRunPrInfo(run.id, pr.number as number, prUrl, pr.headSha, pr.state, pr.merged),
        catch: (cause) => new CodexGithubEventStorageError({ operation: 'update-codex-pr-projection', cause }),
      })
      if (updated) updatedRunIds.push(updated.id)
    }
    return { updatedRunIds }
  })

const handleReviewEvent = (store: CodexGithubEventsStore, event: GithubWebhookStreamEvent) =>
  Effect.gen(function* () {
    const repository = event.repository
    if (!repository) return { updatedRunIds: [] as string[] }
    if (event.event === 'issue_comment' && !isPullRequestIssueComment(event.payload)) {
      return { updatedRunIds: [] as string[] }
    }
    const pr = extractPullRequestInfo(event.payload)
    const prNumber = pr.number ?? extractIssueCommentPrNumber(event.payload)
    if (!prNumber) return { updatedRunIds: [] as string[] }
    const runs = yield* listRunsByPrNumbers(store, repository, [prNumber])
    const reviewStatus =
      event.event === 'pull_request_review'
        ? (normalizeOptionalString(isRecord(event.payload.review) ? event.payload.review.state : null) ?? 'reviewed')
        : 'commented'
    const updatedRunIds: string[] = []
    for (const run of runs) {
      const updated = yield* Effect.tryPromise({
        try: () =>
          store.updateReviewStatus({
            runId: run.id,
            status: reviewStatus,
            summary: { event: event.event, action: event.action, deliveryId: event.deliveryId },
          }),
        catch: (cause) => new CodexGithubEventStorageError({ operation: 'update-codex-review-projection', cause }),
      })
      if (updated) updatedRunIds.push(updated.id)
    }
    return { updatedRunIds }
  })

export const ingestCodexGithubEventEffect = (request: Request, deps: CodexGithubEventsApiDependencies = {}) =>
  Effect.gen(function* () {
    const payload = yield* Effect.tryPromise({
      try: () => parseJsonBody(request),
      catch: (cause) => new CodexGithubEventRequestError({ message: toErrorMessage(cause), status: 400 }),
    })
    const event = parseGithubWebhookEvent(payload)
    if (!SUPPORTED_EVENTS.has(event.event)) {
      return yield* Effect.fail(
        new CodexGithubEventRequestError({
          message: `unsupported GitHub event: ${event.event || 'unknown'}`,
          status: 422,
        }),
      )
    }

    return yield* Effect.acquireUseRelease(
      openStore(deps),
      (store) =>
        Effect.gen(function* () {
          yield* readyStore(store)
          const result =
            event.event === 'check_run' || event.event === 'check_suite'
              ? yield* handleCheckEvent(store, event)
              : event.event === 'pull_request'
                ? yield* handlePullRequestEvent(store, event)
                : yield* handleReviewEvent(store, event)
          return { ok: true, event: event.event, action: event.action, ...result }
        }),
      closeStore,
    )
  })

const describeGithubEventError = (error: CodexGithubEventError) => {
  if (error instanceof CodexGithubEventRequestError) return error.message
  return `Codex GitHub event projection ${error.operation} failed: ${toErrorMessage(error.cause)}`
}

const githubEventStatus = (error: CodexGithubEventError) => {
  if (error instanceof CodexGithubEventRequestError) return error.status
  return toErrorMessage(error.cause).includes('DATABASE_URL') ? 503 : 500
}

export const postCodexGithubEventsHandler = async (request: Request, deps: CodexGithubEventsApiDependencies = {}) => {
  const result = await Effect.runPromise(ingestCodexGithubEventEffect(request, deps).pipe(Effect.either))
  if (result._tag === 'Right') return okResponse(result.right, 202)
  return errorResponse(describeGithubEventError(result.left), githubEventStatus(result.left))
}

export const __test__ = {
  parseGithubWebhookEvent,
}
