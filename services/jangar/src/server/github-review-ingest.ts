import { randomUUID } from 'node:crypto'
import { createGitHubClient } from '~/server/github-client'
import { loadGithubReviewConfig } from '~/server/github-review-config'
import type {
  GithubIssueComment,
  GithubPullState,
  GithubReviewComment,
  GithubReviewStore,
  GithubReviewThread,
} from '~/server/github-review-store'
import { createGithubReviewStore } from '~/server/github-review-store'

export type GithubWebhookEvent = {
  event: string
  action: string | null
  deliveryId: string | null
  repository: string | null
  sender: string | null
  receivedAt?: string | null
  payload: Record<string, unknown>
}

type GithubReviewIngestResult = {
  ok: boolean
  skipped?: boolean
  reason?: string
  repository?: string
  prNumber?: number | null
  commitSha?: string | null
}

const globalOverrides = globalThis as typeof globalThis & {
  __githubReviewStoreMock?: GithubReviewStore
  __githubReviewConfigMock?: ReturnType<typeof loadGithubReviewConfig>
  __githubReviewGithubMock?: ReturnType<typeof createGitHubClient>
}

let cachedConfig: ReturnType<typeof loadGithubReviewConfig> | null = null
let cachedGithub: ReturnType<typeof createGitHubClient> | null = null
let cachedStore: GithubReviewStore | null = null

const getConfig = () => {
  if (globalOverrides.__githubReviewConfigMock) return globalOverrides.__githubReviewConfigMock
  if (!cachedConfig) {
    cachedConfig = loadGithubReviewConfig()
  }
  return cachedConfig
}

const getGithub = () => {
  if (globalOverrides.__githubReviewGithubMock) return globalOverrides.__githubReviewGithubMock
  if (!cachedGithub) {
    const config = getConfig()
    cachedGithub = createGitHubClient({ token: config.githubToken, apiBaseUrl: config.githubApiBaseUrl })
  }
  return cachedGithub
}

const getStore = () => {
  if (globalOverrides.__githubReviewStoreMock) return globalOverrides.__githubReviewStoreMock
  if (!cachedStore) {
    cachedStore = createGithubReviewStore()
  }
  return cachedStore
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const normalizeNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const normalizeBool = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return null
}

const normalizeDate = (value: unknown) => {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return null
}

const extractRepository = (payload: Record<string, unknown>, fallback?: string | null) => {
  if (fallback && fallback.trim().length > 0) return fallback
  const repository = payload.repository
  if (isRecord(repository)) {
    const fullName = normalizeString(repository.full_name)
    if (fullName) return fullName
  }
  if (isRecord(payload.pull_request)) {
    const base = payload.pull_request.base
    if (isRecord(base) && isRecord(base.repo)) {
      const fullName = normalizeString(base.repo.full_name)
      if (fullName) return fullName
    }
  }
  if (isRecord(payload.issue)) {
    const repositoryUrl = normalizeString(payload.issue.repository_url)
    if (repositoryUrl) {
      try {
        const parsed = new URL(repositoryUrl)
        const segments = parsed.pathname.split('/').filter(Boolean)
        if (segments.length >= 2) {
          return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`
        }
      } catch {
        return null
      }
    }
  }
  return null
}

const extractPrNumber = (event: string, payload: Record<string, unknown>) => {
  if (event === 'check_run' || event === 'check_suite') {
    const checkPayload = isRecord(payload.check_run)
      ? payload.check_run
      : isRecord(payload.check_suite)
        ? payload.check_suite
        : null
    if (checkPayload && Array.isArray(checkPayload.pull_requests)) {
      const pr = checkPayload.pull_requests[0]
      if (isRecord(pr)) return normalizeNumber(pr.number)
    }
  }

  if (isRecord(payload.pull_request)) {
    return normalizeNumber(payload.pull_request.number)
  }

  if (isRecord(payload.issue)) {
    return normalizeNumber(payload.issue.number)
  }

  return null
}

const extractCommitSha = (event: string, payload: Record<string, unknown>) => {
  if (event === 'check_run' && isRecord(payload.check_run)) {
    return normalizeString(payload.check_run.head_sha) || null
  }
  if (event === 'check_suite' && isRecord(payload.check_suite)) {
    return normalizeString(payload.check_suite.head_sha) || null
  }
  if (isRecord(payload.pull_request) && isRecord(payload.pull_request.head)) {
    return normalizeString(payload.pull_request.head.sha) || null
  }
  if (isRecord(payload.review) && isRecord(payload.pull_request) && isRecord(payload.pull_request.head)) {
    return normalizeString(payload.pull_request.head.sha) || null
  }
  if (isRecord(payload.comment) && isRecord(payload.pull_request) && isRecord(payload.pull_request.head)) {
    return normalizeString(payload.pull_request.head.sha) || null
  }
  return null
}

const buildReceivedAt = (input: GithubWebhookEvent) => {
  const receivedAt =
    normalizeDate(input.receivedAt) ??
    normalizeDate(input.payload.receivedAt) ??
    normalizeDate(input.payload.received_at)
  return receivedAt ?? new Date().toISOString()
}

const buildPrState = (
  repository: string,
  payload: Record<string, unknown>,
  receivedAt: string,
): GithubPullState | null => {
  if (!isRecord(payload.pull_request)) return null
  const pr = payload.pull_request
  const head = isRecord(pr.head) ? pr.head : null
  const base = isRecord(pr.base) ? pr.base : null
  const user = isRecord(pr.user) ? pr.user : null
  const labels = Array.isArray(pr.labels) ? pr.labels : []

  return {
    repository,
    number: normalizeNumber(pr.number) ?? 0,
    title: normalizeString(pr.title) || null,
    body: normalizeString(pr.body) || null,
    state: normalizeString(pr.state) || null,
    merged: normalizeBool(pr.merged),
    mergedAt: normalizeDate(pr.merged_at),
    draft: normalizeBool(pr.draft),
    authorLogin: normalizeString(user?.login) || null,
    authorAvatarUrl: normalizeString(user?.avatar_url) || null,
    htmlUrl: normalizeString(pr.html_url) || null,
    headRef: normalizeString(head?.ref) || null,
    headSha: normalizeString(head?.sha) || null,
    baseRef: normalizeString(base?.ref) || null,
    baseSha: normalizeString(base?.sha) || null,
    mergeable: normalizeBool(pr.mergeable),
    mergeableState: normalizeString(pr.mergeable_state) || null,
    labels: labels
      .map((label) => (isRecord(label) ? normalizeString(label.name) : ''))
      .filter((label) => label.length > 0),
    additions: normalizeNumber(pr.additions),
    deletions: normalizeNumber(pr.deletions),
    changedFiles: normalizeNumber(pr.changed_files),
    createdAt: normalizeDate(pr.created_at),
    updatedAt: normalizeDate(pr.updated_at),
    receivedAt,
  }
}

const buildReviewState = (payload: Record<string, unknown>, receivedAt: string) => {
  if (!isRecord(payload.review)) return null
  const review = payload.review
  const state = normalizeString(review.state).toLowerCase()
  const decision = state ? state.replace(/\s+/g, '_') : null
  const requestedChanges = decision === 'changes_requested'
  return {
    decision,
    requestedChanges,
    unresolvedThreadsCount: 0,
    latestReviewedAt: normalizeDate(review.submitted_at) ?? receivedAt,
  }
}

const buildCheckRun = (payload: Record<string, unknown>) => {
  const checkRun = isRecord(payload.check_run) ? payload.check_run : null
  const checkSuite = isRecord(payload.check_suite) ? payload.check_suite : null
  if (checkRun) {
    return {
      id: String(checkRun.id ?? checkRun.node_id ?? randomUUID()),
      name: normalizeString(checkRun.name) || null,
      status: normalizeString(checkRun.status) || null,
      conclusion: normalizeString(checkRun.conclusion) || null,
      url: normalizeString(checkRun.html_url) || null,
      completedAt: normalizeDate(checkRun.completed_at),
    }
  }
  if (checkSuite) {
    return {
      id: String(checkSuite.id ?? checkSuite.node_id ?? randomUUID()),
      name: normalizeString(checkSuite.app?.name) || null,
      status: normalizeString(checkSuite.status) || null,
      conclusion: normalizeString(checkSuite.conclusion) || null,
      url: normalizeString(checkSuite.html_url) || null,
      completedAt: normalizeDate(checkSuite.updated_at),
    }
  }
  return null
}

const buildReviewThread = (
  payload: Record<string, unknown>,
  threadKey: string,
  receivedAt: string,
): GithubReviewThread | null => {
  if (!isRecord(payload.comment)) return null
  const comment = payload.comment
  const user = isRecord(comment.user) ? comment.user : null
  return {
    threadKey,
    threadId: normalizeString(comment.pull_request_review_thread_id) || normalizeString(comment.node_id) || null,
    isResolved: false,
    path: normalizeString(comment.path) || null,
    line: normalizeNumber(comment.line),
    side: normalizeString(comment.side) || null,
    startLine: normalizeNumber(comment.start_line),
    authorLogin: normalizeString(user?.login) || null,
    createdAt: normalizeDate(comment.created_at) ?? receivedAt,
    updatedAt: normalizeDate(comment.updated_at) ?? receivedAt,
    comments: [],
  }
}

const buildReviewComment = (payload: Record<string, unknown>, receivedAt: string): GithubReviewComment | null => {
  if (!isRecord(payload.comment)) return null
  const comment = payload.comment
  const user = isRecord(comment.user) ? comment.user : null
  return {
    commentId: String(comment.id ?? ''),
    authorLogin: normalizeString(user?.login) || null,
    body: normalizeString(comment.body) || null,
    createdAt: normalizeDate(comment.created_at) ?? receivedAt,
    updatedAt: normalizeDate(comment.updated_at) ?? receivedAt,
    path: normalizeString(comment.path) || null,
    line: normalizeNumber(comment.line),
    side: normalizeString(comment.side) || null,
    startLine: normalizeNumber(comment.start_line),
    diffHunk: normalizeString(comment.diff_hunk) || null,
    url: normalizeString(comment.html_url) || null,
  }
}

const buildIssueComment = (payload: Record<string, unknown>, receivedAt: string): GithubIssueComment | null => {
  if (!isRecord(payload.comment)) return null
  const comment = payload.comment
  const user = isRecord(comment.user) ? comment.user : null
  return {
    commentId: String(comment.id ?? ''),
    authorLogin: normalizeString(user?.login) || null,
    body: normalizeString(comment.body) || null,
    createdAt: normalizeDate(comment.created_at) ?? receivedAt,
    updatedAt: normalizeDate(comment.updated_at) ?? receivedAt,
    url: normalizeString(comment.html_url) || null,
  }
}

const shouldBackfillFiles = async (
  store: GithubReviewStore,
  repository: string,
  prNumber: number,
  commitSha: string | null,
) => {
  const config = getConfig()
  if (!config.filesBackfillEnabled || !commitSha) return false
  const existing = await store.listFiles({ repository, prNumber, commitSha })
  return existing.length === 0
}

const backfillFiles = async (
  store: GithubReviewStore,
  repository: string,
  prNumber: number,
  commitSha: string,
  receivedAt: string,
) => {
  const github = getGithub()
  const [owner, repo] = repository.split('/')
  if (!owner || !repo) return
  const files = await github.getPullRequestFiles(owner, repo, prNumber)
  await store.upsertPrFiles({ repository, prNumber, commitSha, receivedAt, files })
}

export const ingestGithubReviewEvent = async (input: GithubWebhookEvent): Promise<GithubReviewIngestResult> => {
  const store = getStore()
  const receivedAt = buildReceivedAt(input)
  const repository = extractRepository(input.payload, input.repository)
  if (!repository) {
    return { ok: false, reason: 'missing_repository' }
  }

  const prNumber = extractPrNumber(input.event, input.payload)
  if (!prNumber) {
    return { ok: false, reason: 'missing_pr_number', repository }
  }

  const commitSha = extractCommitSha(input.event, input.payload)
  const deliveryId = input.deliveryId ?? randomUUID()

  const eventInsert = await store.recordEvent({
    deliveryId,
    eventType: input.event,
    action: input.action,
    repository,
    prNumber,
    commitSha,
    senderLogin: input.sender,
    payload: input.payload,
    receivedAt,
  })

  if (!eventInsert.inserted) {
    return { ok: true, skipped: true, reason: 'duplicate', repository, prNumber, commitSha }
  }

  if (input.event === 'pull_request') {
    const prState = buildPrState(repository, input.payload, receivedAt)
    if (prState) {
      await store.upsertPrState(prState)
      if (await shouldBackfillFiles(store, repository, prNumber, prState.headSha)) {
        await backfillFiles(store, repository, prNumber, prState.headSha ?? '', receivedAt)
      }
    }
  }

  if (input.event === 'pull_request_review') {
    const reviewState = buildReviewState(input.payload, receivedAt)
    if (reviewState) {
      const unresolvedThreadsCount = await store.getUnresolvedThreadCount({ repository, prNumber })
      await store.upsertReviewState({
        repository,
        prNumber,
        commitSha,
        receivedAt,
        ...reviewState,
        unresolvedThreadsCount,
      })
    }
  }

  if (input.event === 'pull_request_review_comment') {
    const comment = buildReviewComment(input.payload, receivedAt)
    const threadKey = (() => {
      if (!isRecord(input.payload.comment)) return null
      const commentPayload = input.payload.comment
      const rootId = commentPayload.in_reply_to_id ?? commentPayload.id
      return rootId ? String(rootId) : null
    })()

    if (threadKey) {
      const thread = buildReviewThread(input.payload, threadKey, receivedAt)
      if (thread) {
        await store.upsertReviewThread({
          ...thread,
          repository,
          prNumber,
          commitSha,
          receivedAt,
        })
      }
    }

    if (comment) {
      await store.upsertReviewComment({
        ...comment,
        repository,
        prNumber,
        commitSha,
        receivedAt,
        threadKey,
      })
    }

    if (comment?.path && comment.diffHunk && commitSha) {
      await store.upsertPrFiles({
        repository,
        prNumber,
        commitSha,
        receivedAt,
        files: [
          {
            path: comment.path,
            status: null,
            additions: null,
            deletions: null,
            changes: null,
            patch: comment.diffHunk,
            blobUrl: null,
            rawUrl: null,
            sha: null,
            previousFilename: null,
          },
        ],
      })
    }

    const unresolvedThreadsCount = await store.getUnresolvedThreadCount({ repository, prNumber })
    await store.updateUnresolvedThreadCount({
      repository,
      prNumber,
      count: unresolvedThreadsCount,
      receivedAt,
    })
  }

  if (input.event === 'issue_comment') {
    const comment = buildIssueComment(input.payload, receivedAt)
    if (comment) {
      await store.upsertIssueComment({
        ...comment,
        repository,
        prNumber,
        commitSha,
        receivedAt,
      })
    }
  }

  if (input.event === 'check_run' || input.event === 'check_suite') {
    if (commitSha) {
      const checkRun = buildCheckRun(input.payload)
      if (checkRun) {
        await store.upsertCheckState({ repository, prNumber, commitSha, receivedAt, check: checkRun })
      }
    }
  }

  return { ok: true, repository, prNumber, commitSha }
}
