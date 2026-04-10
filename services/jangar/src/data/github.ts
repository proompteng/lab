import type { CodexRunRecord } from '@/data/codex'

export type GithubCheckRun = {
  id: string
  name: string | null
  status: string | null
  conclusion: string | null
  url: string | null
  completedAt: string | null
}

export type GithubCheckSummary = {
  status: string | null
  detailsUrl: string | null
  totalCount: number
  successCount: number
  failureCount: number
  pendingCount: number
  runs: GithubCheckRun[]
}

export type GithubCheckState = {
  commitSha: string
  status: string | null
  detailsUrl: string | null
  totalCount: number
  successCount: number
  failureCount: number
  pendingCount: number
  runs: GithubCheckRun[]
  updatedAt: string | null
}

export type GithubReviewSummary = {
  decision: string | null
  requestedChanges: boolean | null
  unresolvedThreadsCount: number
  latestReviewedAt: string | null
}

export type GithubPullState = {
  repository: string
  number: number
  title: string | null
  body: string | null
  state: string | null
  merged: boolean | null
  mergedAt: string | null
  draft: boolean | null
  authorLogin: string | null
  authorAvatarUrl: string | null
  htmlUrl: string | null
  headRef: string | null
  headSha: string | null
  baseRef: string | null
  baseSha: string | null
  mergeable: boolean | null
  mergeableState: string | null
  labels: string[]
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  createdAt: string | null
  updatedAt: string | null
  receivedAt: string
}

export type GithubPullListItem = GithubPullState & {
  review: GithubReviewSummary | null
  checks: GithubCheckSummary | null
}

export type GithubReviewComment = {
  commentId: string
  authorLogin: string | null
  body: string | null
  createdAt: string | null
  updatedAt: string | null
  path: string | null
  line: number | null
  side: string | null
  startLine: number | null
  diffHunk: string | null
  url: string | null
}

export type GithubReviewThread = {
  threadKey: string
  threadId: string | null
  isResolved: boolean
  path: string | null
  line: number | null
  side: string | null
  startLine: number | null
  authorLogin: string | null
  createdAt: string | null
  updatedAt: string | null
  comments: GithubReviewComment[]
}

export type GithubIssueComment = {
  commentId: string
  authorLogin: string | null
  body: string | null
  createdAt: string | null
  updatedAt: string | null
  url: string | null
}

export type GithubWriteAudit = {
  repository: string
  prNumber: number
  commitSha: string | null
  missionId: string | null
  stage: string | null
  actionClass: string | null
  riskClass: string | null
  rolloutRef: string | null
  rolloutStatus: string | null
  rollbackRef: string | null
  rollbackReason: string | null
  action: string
  actor: string | null
  requestId: string | null
  payload: Record<string, unknown>
  response?: Record<string, unknown> | null
  success: boolean
  error?: string | null
  receivedAt: string
}

export type GithubPrFile = {
  path: string
  status: string | null
  additions: number | null
  deletions: number | null
  changes: number | null
  patch: string | null
  blobUrl: string | null
  rawUrl: string | null
  sha: string | null
  previousFilename: string | null
}

export type GithubCapabilities = {
  reviewsWriteEnabled: boolean
  mergeWriteEnabled: boolean
}

export type GithubPullsResponse =
  | {
      ok: true
      items: GithubPullListItem[]
      nextCursor: string | null
      capabilities: GithubCapabilities
      repositoriesAllowed: string[]
      viewerLogin?: string | null
    }
  | { ok: false; error: string }

export type GithubPullDetailResponse =
  | {
      ok: true
      pull: GithubPullState
      review: GithubReviewSummary | null
      checks: GithubCheckSummary | null
      issueComments: GithubIssueComment[]
      capabilities: GithubCapabilities
    }
  | { ok: false; error: string }

export type GithubWriteAuditResponse =
  | {
      ok: true
      audits: GithubWriteAudit[]
    }
  | { ok: false; error: string }

export type GithubPullDetailPageData =
  | {
      ok: true
      pull: GithubPullState
      review: GithubReviewSummary | null
      checks: GithubCheckSummary | null
      issueComments: GithubIssueComment[]
      capabilities: GithubCapabilities
      threads: GithubReviewThread[]
      files: GithubPrFile[]
      checksByCommit: GithubCheckState[]
      judgeRuns: CodexRunRecord[]
      writeActions: GithubWriteAudit[]
      deploymentEvidence: GithubDeploymentEvidenceSummary
    }
  | { ok: false; error: string }

export const fetchGithubPulls = async (params: {
  repository?: string | null
  state?: string
  author?: string | null
  label?: string
  reviewDecision?: string
  ciStatus?: string
  limit?: number
  cursor?: string | null
}) => {
  const url = new URL('/api/github/pulls', window.location.origin)
  if (typeof params.repository === 'string') url.searchParams.set('repository', params.repository)
  if (params.state) url.searchParams.set('state', params.state)
  if (typeof params.author === 'string') url.searchParams.set('author', params.author)
  if (params.label) url.searchParams.set('label', params.label)
  if (params.reviewDecision) url.searchParams.set('reviewDecision', params.reviewDecision)
  if (params.ciStatus) url.searchParams.set('ciStatus', params.ciStatus)
  if (params.limit) url.searchParams.set('limit', params.limit.toString())
  if (params.cursor) url.searchParams.set('cursor', params.cursor)

  const response = await fetch(url.toString())
  const payload = (await response.json().catch(() => null)) as GithubPullsResponse | null
  if (!response.ok || !payload) {
    return { ok: false, error: 'Failed to load pull requests' } as const
  }
  return payload
}

export const fetchGithubPull = async (owner: string, repo: string, number: number) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}`)
  const payload = (await response.json().catch(() => null)) as GithubPullDetailResponse | null
  if (!response.ok || !payload) {
    return { ok: false, error: 'Failed to load pull request' } as const
  }
  return payload
}

export const fetchGithubPullFiles = async (owner: string, repo: string, number: number) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/files`)
  const payload = (await response.json().catch(() => null)) as {
    ok: boolean
    files?: GithubPrFile[]
    refreshing?: boolean
    error?: string
  } | null
  if (!response.ok || !payload || !payload.ok) {
    return { ok: false, error: payload?.error ?? 'Failed to load pull request files' } as const
  }
  return { ok: true, files: payload.files ?? [], refreshing: Boolean(payload.refreshing) } as const
}

export const fetchGithubPullThreads = async (owner: string, repo: string, number: number) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/threads`)
  const payload = (await response.json().catch(() => null)) as {
    ok: boolean
    threads?: GithubReviewThread[]
    error?: string
  } | null
  if (!response.ok || !payload || !payload.ok) {
    return { ok: false, error: payload?.error ?? 'Failed to load pull request threads' } as const
  }
  return { ok: true, threads: payload.threads ?? [] } as const
}

export const fetchGithubPullChecks = async (owner: string, repo: string, number: number) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/checks`)
  const payload = (await response.json().catch(() => null)) as {
    ok: boolean
    commits?: GithubCheckState[]
    error?: string
  } | null
  if (!response.ok || !payload || !payload.ok) {
    return { ok: false, error: payload?.error ?? 'Failed to load pull request checks' } as const
  }
  return { ok: true, commits: payload.commits ?? [] } as const
}

export const fetchGithubPullWriteActions = async (owner: string, repo: string, number: number) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/write-actions`)
  const payload = (await response.json().catch(() => null)) as GithubWriteAuditResponse | null
  if (!response.ok) {
    return { ok: false, error: 'Failed to load write action audit trail' } as const
  }
  if (payload === null) {
    return { ok: false, error: 'Failed to load write action audit trail' } as const
  }
  if (!payload?.ok) {
    return { ok: false, error: payload?.error ?? 'Failed to load write action audit trail' } as const
  }
  return { ok: true, audits: payload.audits } as const
}

export type GithubDeploymentEvidenceSummary = {
  rollout: GithubWriteAudit | null
  rollback: GithubWriteAudit | null
}

export const fetchGithubPullDeploymentEvidenceSummary = async (owner: string, repo: string, number: number) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/deployment`)
  const payload = (await response.json().catch(() => null)) as {
    ok: boolean
    deployment?: GithubDeploymentEvidenceSummary
    error?: string
  } | null
  if (!response.ok || !payload) {
    return { ok: false, error: payload?.error ?? 'Failed to load pull request deployment evidence' } as const
  }
  if (!payload.ok) {
    return { ok: false, error: payload.error ?? 'Unable to load pull request deployment evidence' } as const
  }
  return { ok: true, deployment: payload.deployment ?? { rollout: null, rollback: null } } as const
}

export const refreshGithubPullFiles = async (owner: string, repo: string, number: number) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/refresh-files`, {
    method: 'POST',
  })
  const payload = (await response.json().catch(() => null)) as {
    ok: boolean
    commitSha?: string
    baseSha?: string
    fileCount?: number
    error?: string
  } | null
  if (!response.ok || !payload || !payload.ok) {
    return { ok: false, error: payload?.error ?? 'Failed to refresh pull request files' } as const
  }
  return {
    ok: true,
    commitSha: payload.commitSha ?? null,
    baseSha: payload.baseSha ?? null,
    fileCount: payload.fileCount ?? 0,
  } as const
}

export const fetchGithubPullJudgeRuns = async (owner: string, repo: string, number: number) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/judge-runs`)
  const payload = (await response.json().catch(() => null)) as {
    ok: boolean
    runs?: CodexRunRecord[]
    error?: string
  } | null
  if (!response.ok || !payload || !payload.ok) {
    return { ok: false, error: payload?.error ?? 'Failed to load judge runs' } as const
  }
  return { ok: true, runs: payload.runs ?? [] } as const
}

export const loadGithubPullDetailPageData = async (owner: string, repo: string, number: number) => {
  const pullRes = await fetchGithubPull(owner, repo, number)
  if (!pullRes.ok) {
    return { ok: false as const, error: pullRes.error }
  }

  const [filesRes, threadsRes, checksRes, judgeRes, deploymentEvidenceRes, auditsRes] = await Promise.all([
    fetchGithubPullFiles(owner, repo, number),
    fetchGithubPullThreads(owner, repo, number),
    fetchGithubPullChecks(owner, repo, number),
    fetchGithubPullJudgeRuns(owner, repo, number),
    fetchGithubPullDeploymentEvidenceSummary(owner, repo, number),
    fetchGithubPullWriteActions(owner, repo, number),
  ])

  return {
    ok: true as const,
    pull: pullRes.pull,
    review: pullRes.review,
    checks: pullRes.checks,
    issueComments: pullRes.issueComments,
    capabilities: pullRes.capabilities,
    threads: threadsRes.ok ? threadsRes.threads : [],
    files: filesRes.ok ? filesRes.files : [],
    checksByCommit: checksRes.ok ? checksRes.commits : [],
    judgeRuns: judgeRes.ok ? judgeRes.runs : [],
    writeActions: auditsRes.ok ? auditsRes.audits : [],
    deploymentEvidence: deploymentEvidenceRes.ok
      ? deploymentEvidenceRes.deployment
      : {
          rollout: null,
          rollback: null,
        },
  } satisfies GithubPullDetailPageData
}

export const submitGithubReview = async (
  owner: string,
  repo: string,
  number: number,
  body: {
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
    body?: string
    comments?: Array<{ path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string; startLine?: number }>
  },
) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => null)) as { ok: boolean; review?: unknown; error?: string } | null
  if (!response.ok || !payload || !payload.ok) {
    return { ok: false, error: payload?.error ?? 'Failed to submit review' } as const
  }
  return { ok: true, review: payload.review } as const
}

export const resolveGithubThread = async (
  owner: string,
  repo: string,
  number: number,
  threadKey: string,
  resolve: boolean,
) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/threads/${threadKey}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resolve }),
  })
  const payload = (await response.json().catch(() => null)) as { ok: boolean; thread?: unknown; error?: string } | null
  if (!response.ok || !payload || !payload.ok) {
    return { ok: false, error: payload?.error ?? 'Failed to resolve thread' } as const
  }
  return { ok: true, thread: payload.thread } as const
}

export const mergeGithubPull = async (
  owner: string,
  repo: string,
  number: number,
  body: {
    method: 'merge' | 'squash' | 'rebase'
    commitTitle?: string
    commitMessage?: string
    deleteBranch?: boolean
    force?: boolean
  },
) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => null)) as { ok: boolean; error?: string } | null
  if (!response.ok || !payload || !payload.ok) {
    return { ok: false, error: payload?.error ?? 'Failed to merge pull request' } as const
  }
  return { ok: true } as const
}

export type GithubDeploymentEvidence = {
  action: 'rollout' | 'rollback'
  missionId?: string
  stage?: string
  reference?: string
  status?: string
  reason?: string
}

export const postGithubPullDeploymentEvidence = async (
  owner: string,
  repo: string,
  number: number,
  body: GithubDeploymentEvidence,
) => {
  const response = await fetch(`/api/github/pulls/${owner}/${repo}/${number}/deployment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => null)) as { ok: boolean; error?: string } | null
  if (!response.ok || !payload || !payload.ok) {
    return { ok: false, error: payload?.error ?? 'Failed to record deployment evidence' } as const
  }
  return { ok: true } as const
}
