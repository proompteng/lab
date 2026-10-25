import { Data, Effect } from 'effect'

import { type CodexRunProjectionStore, type CodexRunRecord } from '../codex-run-projection-store'
import { errorResponse, okResponse, parseJsonBody } from '../http'

import {
  CodexRunProjectionStorageError,
  CodexRunProjectionStoreService,
  type CodexRunProjectionStoreServiceDefinition,
  describeCodexRunProjectionStorageError,
  makeCodexRunProjectionStoreLayer,
} from './codex-run-projection-store'

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

type CodexGithubEventError = CodexGithubEventRequestError | CodexRunProjectionStorageError

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

const EVENT_METADATA_KEYS = [
  'event',
  'event_type',
  'eventType',
  'name',
  'x-github-event',
  'xgithubevent',
  'github_event',
  'githubEvent',
  'kafkaheaderxgithubevent',
  'kafka_header_x_github_event',
]

const ACTION_METADATA_KEYS = [
  'action',
  'event_action',
  'eventAction',
  'x-github-action',
  'xgithubaction',
  'github_action',
  'githubAction',
  'kafkaheaderxgithubaction',
  'kafka_header_x_github_action',
]

const DELIVERY_METADATA_KEYS = [
  'deliveryId',
  'delivery_id',
  'x-github-delivery',
  'xgithubdelivery',
  'github_delivery',
  'githubDelivery',
  'kafkaheaderxgithubdelivery',
  'kafka_header_x_github_delivery',
]

const DELIVERY_FALLBACK_METADATA_KEYS = ['id', 'key']

const EVENT_HEADER_KEYS = [
  'x-github-event',
  'github-event',
  'ce-x-github-event',
  'ce-xgithubevent',
  'ce-githubevent',
  'ce-github-event',
  'ce-kafkaheaderxgithubevent',
]

const ACTION_HEADER_KEYS = [
  'x-github-action',
  'github-action',
  'ce-x-github-action',
  'ce-xgithubaction',
  'ce-githubaction',
  'ce-github-action',
  'ce-kafkaheaderxgithubaction',
]

const DELIVERY_HEADER_KEYS = [
  'x-github-delivery',
  'github-delivery',
  'ce-x-github-delivery',
  'ce-xgithubdelivery',
  'ce-githubdelivery',
  'ce-github-delivery',
  'ce-kafkaheaderxgithubdelivery',
  'ce-id',
]

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

const normalizeEventName = (value: unknown) => {
  const normalized = normalizeOptionalString(value)?.toLowerCase()
  if (!normalized) return null
  if (SUPPORTED_EVENTS.has(normalized)) return normalized
  const suffix = normalized.split(/[.:/]/).at(-1)
  return suffix && SUPPORTED_EVENTS.has(suffix) ? suffix : normalized
}

const readRecordString = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = normalizeOptionalString(record[key])
    if (value) return value
  }
  return null
}

const readHeaderString = (headers: Headers | undefined, keys: string[]) => {
  if (!headers) return null
  for (const key of keys) {
    const value = normalizeOptionalString(headers.get(key))
    if (value) return value
  }
  return null
}

const metadataRecords = (payload: Record<string, unknown>) => {
  const records: Record<string, unknown>[] = [payload]
  for (const key of ['headers', 'kafkaHeaders', 'kafka_headers', 'extensions', 'attributes']) {
    if (isRecord(payload[key])) records.push(payload[key])
  }
  return records
}

const readPayloadMetadataString = (payload: Record<string, unknown>, keys: string[]) => {
  for (const record of metadataRecords(payload)) {
    const value = readRecordString(record, keys)
    if (value) return value
  }
  return null
}

const extractRawWebhookPayload = (payload: Record<string, unknown>) => {
  if (isRecord(payload.payload)) return payload.payload
  if (normalizeOptionalString(payload.specversion) && isRecord(payload.data)) return payload.data
  return payload
}

const inferGithubEventFromPayload = (payload: Record<string, unknown>) => {
  if (isRecord(payload.check_run)) return 'check_run'
  if (isRecord(payload.check_suite)) return 'check_suite'
  if (isRecord(payload.comment) && isRecord(payload.issue)) return 'issue_comment'
  if (isRecord(payload.comment) && isRecord(payload.pull_request)) return 'pull_request_review_comment'
  if (isRecord(payload.review) && isRecord(payload.pull_request)) return 'pull_request_review'
  if (isRecord(payload.pull_request)) return 'pull_request'
  return null
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

const parseGithubWebhookEvent = (payload: Record<string, unknown>, headers?: Headers): GithubWebhookStreamEvent => {
  const rawPayload = extractRawWebhookPayload(payload)
  const eventName =
    normalizeEventName(readPayloadMetadataString(payload, EVENT_METADATA_KEYS)) ??
    normalizeEventName(readPayloadMetadataString(rawPayload, EVENT_METADATA_KEYS)) ??
    normalizeEventName(readHeaderString(headers, EVENT_HEADER_KEYS)) ??
    inferGithubEventFromPayload(rawPayload)
  return {
    event: eventName ?? '',
    action:
      readPayloadMetadataString(payload, ACTION_METADATA_KEYS) ??
      readPayloadMetadataString(rawPayload, ACTION_METADATA_KEYS) ??
      readHeaderString(headers, ACTION_HEADER_KEYS),
    deliveryId:
      readPayloadMetadataString(payload, DELIVERY_METADATA_KEYS) ??
      readPayloadMetadataString(rawPayload, DELIVERY_METADATA_KEYS) ??
      readHeaderString(headers, DELIVERY_HEADER_KEYS) ??
      readPayloadMetadataString(payload, DELIVERY_FALLBACK_METADATA_KEYS) ??
      readPayloadMetadataString(rawPayload, DELIVERY_FALLBACK_METADATA_KEYS),
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

const listRunsByPrNumbers = (
  stores: CodexRunProjectionStoreServiceDefinition,
  store: CodexRunProjectionStore,
  repository: string,
  prNumbers: number[],
) =>
  Effect.gen(function* () {
    const runs: CodexRunRecord[] = []
    for (const prNumber of prNumbers) {
      runs.push(...(yield* stores.listRunsByPrNumber(store, repository, prNumber)))
    }
    return dedupeRuns(runs)
  })

const resolveRunsForCommitOrPr = (
  stores: CodexRunProjectionStoreServiceDefinition,
  store: CodexRunProjectionStore,
  repository: string,
  commitSha: string | null,
  prNumbers: number[],
) =>
  Effect.gen(function* () {
    if (commitSha) {
      const byCommit = yield* stores.listRunsByCommitSha(store, repository, commitSha)
      if (byCommit.length > 0) return dedupeRuns(byCommit)
    }
    return yield* listRunsByPrNumbers(stores, store, repository, prNumbers)
  })

const handleCheckEvent = (
  stores: CodexRunProjectionStoreServiceDefinition,
  store: CodexRunProjectionStore,
  event: GithubWebhookStreamEvent,
) =>
  Effect.gen(function* () {
    const repository = event.repository
    const check = extractCheckPayload(event.payload)
    if (!repository || !check) return { updatedRunIds: [] as string[], status: null as string | null }
    const commitSha = normalizeSha(check.head_sha ?? check.headSha)
    const prNumbers = extractCheckPullRequests(check)
    const ciStatus = deriveCiStatus(normalizeOptionalString(check.status), normalizeOptionalString(check.conclusion))
    const ciUrl = normalizeOptionalString(check.html_url ?? check.details_url ?? check.url)
    const runs = yield* resolveRunsForCommitOrPr(stores, store, repository, commitSha, prNumbers)
    const updatedRunIds: string[] = []
    for (const run of runs) {
      const updated = yield* stores.updateCiStatus(store, {
        runId: run.id,
        status: ciStatus,
        url: ciUrl,
        commitSha,
      })
      if (updated) updatedRunIds.push(updated.id)
    }
    return { updatedRunIds, status: ciStatus }
  })

const handlePullRequestEvent = (
  stores: CodexRunProjectionStoreServiceDefinition,
  store: CodexRunProjectionStore,
  event: GithubWebhookStreamEvent,
) =>
  Effect.gen(function* () {
    const repository = event.repository
    const pr = extractPullRequestInfo(event.payload)
    if (!repository || !pr.number) return { updatedRunIds: [] as string[] }
    const byBranch = pr.headRef ? yield* stores.listRunsByBranch(store, repository, pr.headRef) : []
    const byCommit =
      byBranch.length === 0 && pr.headSha ? yield* stores.listRunsByCommitSha(store, repository, pr.headSha) : []
    const byPr =
      byBranch.length === 0 && byCommit.length === 0
        ? yield* listRunsByPrNumbers(stores, store, repository, [pr.number])
        : []
    const runs = dedupeRuns([...byBranch, ...byCommit, ...byPr])
    const prUrl = pr.url ?? `https://github.com/${repository}/pull/${pr.number}`
    const updatedRunIds: string[] = []
    for (const run of runs) {
      const updated = yield* stores.updateRunPrInfo(store, run.id, pr.number, prUrl, pr.headSha, pr.state, pr.merged)
      if (updated) updatedRunIds.push(updated.id)
    }
    return { updatedRunIds }
  })

const handleReviewEvent = (
  stores: CodexRunProjectionStoreServiceDefinition,
  store: CodexRunProjectionStore,
  event: GithubWebhookStreamEvent,
) =>
  Effect.gen(function* () {
    const repository = event.repository
    if (!repository) return { updatedRunIds: [] as string[] }
    if (event.event === 'issue_comment' && !isPullRequestIssueComment(event.payload)) {
      return { updatedRunIds: [] as string[] }
    }
    const pr = extractPullRequestInfo(event.payload)
    const prNumber = pr.number ?? extractIssueCommentPrNumber(event.payload)
    if (!prNumber) return { updatedRunIds: [] as string[] }
    const runs = yield* listRunsByPrNumbers(stores, store, repository, [prNumber])
    const reviewStatus =
      event.event === 'pull_request_review'
        ? (normalizeOptionalString(isRecord(event.payload.review) ? event.payload.review.state : null) ?? 'reviewed')
        : 'commented'
    const updatedRunIds: string[] = []
    for (const run of runs) {
      const updated = yield* stores.updateReviewStatus(store, {
        runId: run.id,
        status: reviewStatus,
        summary: { event: event.event, action: event.action, deliveryId: event.deliveryId },
      })
      if (updated) updatedRunIds.push(updated.id)
    }
    return { updatedRunIds }
  })

const withCodexRunProjectionStore = <A>(
  run: (
    store: CodexRunProjectionStore,
    stores: CodexRunProjectionStoreServiceDefinition,
  ) => Effect.Effect<A, CodexRunProjectionStorageError>,
): Effect.Effect<A, CodexRunProjectionStorageError, CodexRunProjectionStoreService> =>
  Effect.gen(function* () {
    const stores = yield* CodexRunProjectionStoreService
    return yield* Effect.acquireUseRelease(
      stores.open,
      (store) => stores.ready(store).pipe(Effect.zipRight(run(store, stores))),
      stores.close,
    )
  })

export const ingestCodexGithubEventWithServicesEffect = (
  request: Request,
): Effect.Effect<Record<string, unknown>, CodexGithubEventError, CodexRunProjectionStoreService> =>
  Effect.gen(function* () {
    const payload = yield* Effect.tryPromise({
      try: () => parseJsonBody(request),
      catch: (cause) => new CodexGithubEventRequestError({ message: toErrorMessage(cause), status: 400 }),
    })
    const event = parseGithubWebhookEvent(payload, request.headers)
    if (!SUPPORTED_EVENTS.has(event.event)) {
      return yield* Effect.fail(
        new CodexGithubEventRequestError({
          message: `unsupported GitHub event: ${event.event || 'unknown'}`,
          status: 422,
        }),
      )
    }

    return yield* withCodexRunProjectionStore((store, stores) =>
      Effect.gen(function* () {
        const result =
          event.event === 'check_run' || event.event === 'check_suite'
            ? yield* handleCheckEvent(stores, store, event)
            : event.event === 'pull_request'
              ? yield* handlePullRequestEvent(stores, store, event)
              : yield* handleReviewEvent(stores, store, event)
        return { ok: true, event: event.event, action: event.action, ...result }
      }),
    )
  })

export const ingestCodexGithubEventEffect = (request: Request, deps: CodexGithubEventsApiDependencies = {}) =>
  ingestCodexGithubEventWithServicesEffect(request).pipe(
    Effect.provide(makeCodexRunProjectionStoreLayer(deps.storeFactory as (() => CodexRunProjectionStore) | undefined)),
  )

const describeGithubEventError = (error: CodexGithubEventError) => {
  if (error instanceof CodexGithubEventRequestError) return error.message
  return describeCodexRunProjectionStorageError(error)
}

const githubEventStatus = (error: CodexGithubEventError) => {
  if (error instanceof CodexGithubEventRequestError) return error.status
  return error.httpStatusCode
}

export const postCodexGithubEventsHandler = async (request: Request, deps: CodexGithubEventsApiDependencies = {}) => {
  const result = await Effect.runPromise(ingestCodexGithubEventEffect(request, deps).pipe(Effect.either))
  if (result._tag === 'Right') return okResponse(result.right, 202)
  return errorResponse(describeGithubEventError(result.left), githubEventStatus(result.left))
}

export const __test__ = {
  parseGithubWebhookEvent,
}
