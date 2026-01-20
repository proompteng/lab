import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'

const globalState = globalThis as typeof globalThis & {
  __codexJudgeStoreMock?: CodexJudgeStore
  __codexJudgeGithubMock?: {
    getRefSha: ReturnType<typeof vi.fn>
    getCheckRuns: ReturnType<typeof vi.fn>
    getPullRequestByHead: ReturnType<typeof vi.fn>
    getPullRequest: ReturnType<typeof vi.fn>
    getPullRequestDiff: ReturnType<typeof vi.fn>
    getReviewSummary: ReturnType<typeof vi.fn>
    getFile: ReturnType<typeof vi.fn>
    updateFile: ReturnType<typeof vi.fn>
    createBranch: ReturnType<typeof vi.fn>
    createPullRequest: ReturnType<typeof vi.fn>
  }
  __codexJudgeConfigMock?: {
    githubToken: string | null
    githubApiBaseUrl: string
    codexReviewers: string[]
    ciEventStreamEnabled: boolean
    ciMaxWaitMs: number
    reviewMaxWaitMs: number
    maxAttempts: number
    backoffScheduleMs: number[]
    facteurBaseUrl: string
    workflowArtifactsBucket: string
    workflowNamespace: string | null
    discordBotToken: string | null
    discordChannelId: string | null
    discordApiBaseUrl: string
    promptTuningEnabled: boolean
    promptTuningRepo: string | null
    promptTuningFailureThreshold: number
    promptTuningWindowHours: number
    promptTuningCooldownHours: number
    rerunOrchestrationName: string | null
    rerunOrchestrationNamespace: string
    systemImprovementOrchestrationName: string | null
    systemImprovementOrchestrationNamespace: string
    systemImprovementJudgePrompt: string
    defaultJudgePrompt: string
  }
  __githubReviewStoreMock?: {
    recordEvent: ReturnType<typeof vi.fn>
    upsertPrState: ReturnType<typeof vi.fn>
    upsertReviewState: ReturnType<typeof vi.fn>
    upsertCheckState: ReturnType<typeof vi.fn>
    upsertReviewThread: ReturnType<typeof vi.fn>
    upsertReviewComment: ReturnType<typeof vi.fn>
    upsertIssueComment: ReturnType<typeof vi.fn>
    upsertPrFiles: ReturnType<typeof vi.fn>
    listFiles: ReturnType<typeof vi.fn>
    getUnresolvedThreadCount: ReturnType<typeof vi.fn>
    updateUnresolvedThreadCount: ReturnType<typeof vi.fn>
  }
  __githubReviewConfigMock?: {
    githubToken: string | null
    githubApiBaseUrl: string
    reposAllowed: string[]
    reviewsWriteEnabled: boolean
    mergeWriteEnabled: boolean
    mergeForceEnabled: boolean
  }
}

const requireMock = <T>(value: T | undefined, name: string): T => {
  if (!value) {
    throw new Error(`Missing ${name} mock`)
  }
  return value
}

const githubMock = {
  getRefSha: vi.fn(),
  getCheckRuns: vi.fn(),
  getPullRequestByHead: vi.fn(),
  getPullRequest: vi.fn(),
  getPullRequestDiff: vi.fn(),
  getReviewSummary: vi.fn(),
  getFile: vi.fn(),
  updateFile: vi.fn(),
  createBranch: vi.fn(),
  createPullRequest: vi.fn(),
}

const configMock: NonNullable<typeof globalState.__codexJudgeConfigMock> = {
  githubToken: null,
  githubApiBaseUrl: 'https://api.github.com',
  codexReviewers: [],
  ciEventStreamEnabled: true,
  ciMaxWaitMs: 10_000,
  reviewMaxWaitMs: 10_000,
  maxAttempts: 3,
  backoffScheduleMs: [1000],
  facteurBaseUrl: 'http://facteur',
  workflowArtifactsBucket: 'jangar-artifacts',
  workflowNamespace: null,
  discordBotToken: null,
  discordChannelId: null,
  discordApiBaseUrl: 'https://discord.com/api/v10',
  promptTuningEnabled: false,
  promptTuningRepo: null,
  promptTuningFailureThreshold: 3,
  promptTuningWindowHours: 24,
  promptTuningCooldownHours: 6,
  rerunOrchestrationName: null,
  rerunOrchestrationNamespace: 'jangar',
  systemImprovementOrchestrationName: null,
  systemImprovementOrchestrationNamespace: 'jangar',
  systemImprovementJudgePrompt: 'system-improvement prompt',
  defaultJudgePrompt: 'default-judge-prompt',
}

const githubReviewStoreMock = {
  recordEvent: vi.fn(async () => ({ inserted: true })),
  upsertPrState: vi.fn(async () => {}),
  upsertReviewState: vi.fn(async () => {}),
  upsertCheckState: vi.fn(async () => ({})),
  upsertReviewThread: vi.fn(async () => {}),
  upsertReviewComment: vi.fn(async () => {}),
  upsertIssueComment: vi.fn(async () => {}),
  upsertPrFiles: vi.fn(async () => {}),
  getPrWorktree: vi.fn(async () => null),
  listFiles: vi.fn(async () => []),
  getUnresolvedThreadCount: vi.fn(async () => 0),
  updateUnresolvedThreadCount: vi.fn(async () => {}),
}

const githubReviewConfigMock = {
  githubToken: null,
  githubApiBaseUrl: 'https://api.github.com',
  reposAllowed: ['proompteng/lab'],
  reviewsWriteEnabled: false,
  mergeWriteEnabled: false,
  mergeForceEnabled: false,
}

if (!globalState.__codexJudgeStoreMock) {
  globalState.__codexJudgeStoreMock = {
    ready: Promise.resolve(),
    upsertRunComplete: vi.fn(),
    attachNotify: vi.fn(),
    updateCiStatus: vi.fn(),
    updateReviewStatus: vi.fn(),
    updateDecision: vi.fn(),
    updateRunStatus: vi.fn(),
    updateRunPrompt: vi.fn(),
    updateRunPrInfo: vi.fn(),
    upsertArtifacts: vi.fn(),
    listArtifactsForRun: vi.fn(async () => []),
    listRunsByStatus: vi.fn(),
    claimRerunSubmission: vi.fn(),
    updateRerunSubmission: vi.fn(),
    enqueueRerunSubmission: vi.fn(),
    listRerunSubmissions: vi.fn(),
    getRunByWorkflow: vi.fn(),
    getRunById: vi.fn(),
    listRunsByIssue: vi.fn(),
    listRunsByBranch: vi.fn(),
    listRunsByCommitSha: vi.fn(),
    listRunsByPrNumber: vi.fn(),
    getRunHistory: vi.fn(),
    listRecentRuns: vi.fn(),
    listRunsPage: vi.fn(),
    listIssueSummaries: vi.fn(),
    getLatestPromptTuningByIssue: vi.fn(),
    createPromptTuning: vi.fn(),
    close: vi.fn(),
  }
}

if (!globalState.__codexJudgeGithubMock) {
  globalState.__codexJudgeGithubMock = githubMock
}

if (!globalState.__codexJudgeConfigMock) {
  globalState.__codexJudgeConfigMock = { ...configMock }
}

const buildRun = (overrides: Partial<CodexRunRecord> = {}): CodexRunRecord => ({
  id: 'run-1',
  repository: 'owner/repo',
  issueNumber: 123,
  branch: 'codex/issue-123',
  attempt: 1,
  workflowName: 'workflow-1',
  workflowUid: null,
  workflowNamespace: null,
  turnId: null,
  threadId: null,
  stage: 'implementation',
  status: 'run_complete',
  phase: null,
  iteration: null,
  iterationCycle: null,
  prompt: null,
  nextPrompt: null,
  commitSha: null,
  prNumber: null,
  prUrl: null,
  ciStatus: null,
  ciUrl: null,
  ciStatusUpdatedAt: null,
  reviewStatus: null,
  reviewSummary: {},
  reviewStatusUpdatedAt: null,
  notifyPayload: null,
  runCompletePayload: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  ...overrides,
})

let handleGithubWebhookEvent: Awaited<typeof import('../codex-judge')>['handleGithubWebhookEvent'] | null = null

const requireHandler = async () => {
  if (!handleGithubWebhookEvent) {
    handleGithubWebhookEvent = (await import('../codex-judge')).handleGithubWebhookEvent
  }
  if (!handleGithubWebhookEvent) {
    throw new Error('Missing handleGithubWebhookEvent export')
  }
  return handleGithubWebhookEvent
}

describe('codex-judge GitHub webhook stream handling', () => {
  beforeEach(() => {
    handleGithubWebhookEvent = null
    globalState.__codexJudgeConfigMock = { ...configMock }
    globalState.__codexJudgeGithubMock = githubMock
    const storeMock = requireMock(globalState.__codexJudgeStoreMock, 'store')
    Object.values(storeMock).forEach((value) => {
      if (typeof value === 'function') {
        ;(value as ReturnType<typeof vi.fn>).mockReset?.()
      }
    })
    Object.values(githubMock).forEach((value) => {
      if (typeof value === 'function') {
        ;(value as ReturnType<typeof vi.fn>).mockReset?.()
      }
    })
    Object.values(githubReviewStoreMock).forEach((value) => {
      if (typeof value === 'function') {
        ;(value as ReturnType<typeof vi.fn>).mockClear?.()
      }
    })
    globalState.__githubReviewStoreMock = githubReviewStoreMock
    globalState.__githubReviewConfigMock = githubReviewConfigMock
  })

  afterEach(() => {
    vi.useRealTimers()
  })
  it('skips events when the stream is disabled', async () => {
    const handler = await requireHandler()
    const config = requireMock(globalState.__codexJudgeConfigMock, 'config')
    config.ciEventStreamEnabled = false

    const result = await handler({ event: 'check_run', payload: {} })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('event_stream_disabled')
  }, 60_000)

  it('updates CI status for check_run completion events', async () => {
    const handler = await requireHandler()
    const config = requireMock(globalState.__codexJudgeConfigMock, 'config')
    config.ciEventStreamEnabled = true
    const store = requireMock(globalState.__codexJudgeStoreMock, 'store')
    const run = buildRun({ commitSha: 'a'.repeat(40) })
    ;(store.listRunsByCommitSha as ReturnType<typeof vi.fn>).mockResolvedValueOnce([run])
    ;(store.updateCiStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...run,
      ciStatus: 'success',
      ciUrl: 'https://ci.example.com',
    })
    githubMock.getCheckRuns.mockResolvedValueOnce({ status: 'success', url: 'https://ci.example.com' })

    const result = await handler({
      event: 'check_run',
      action: 'completed',
      repository: 'owner/repo',
      payload: {
        check_run: {
          head_sha: run.commitSha,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://ci.example.com',
        },
        repository: { full_name: 'owner/repo' },
      },
    })

    expect(result.ok).toBe(true)
    expect(store.listRunsByCommitSha).toHaveBeenCalledWith('owner/repo', run.commitSha)
    expect(store.updateCiStatus).toHaveBeenCalledWith({
      runId: run.id,
      status: 'success',
      url: 'https://ci.example.com',
      commitSha: run.commitSha,
    })
  }, 60_000)

  it('updates review status for pull_request_review events', async () => {
    const handler = await requireHandler()
    const store = requireMock(globalState.__codexJudgeStoreMock, 'store')
    const run = buildRun({ prNumber: 42 })
    ;(store.listRunsByPrNumber as ReturnType<typeof vi.fn>).mockResolvedValueOnce([run])
    ;(store.updateReviewStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...run,
      reviewStatus: 'approved',
    })
    githubMock.getReviewSummary.mockResolvedValueOnce({
      status: 'approved',
      unresolvedThreads: [],
      requestedChanges: false,
      reviewComments: [],
      issueComments: [],
    })

    const result = await handler({
      event: 'pull_request_review',
      action: 'submitted',
      repository: 'owner/repo',
      payload: {
        pull_request: {
          number: 42,
          head: { ref: 'codex/issue-123', sha: 'b'.repeat(40) },
          html_url: 'https://github.com/owner/repo/pull/42',
        },
      },
    })

    expect(result.ok).toBe(true)
    expect(store.listRunsByPrNumber).toHaveBeenCalledWith('owner/repo', 42)
    expect(store.updateReviewStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.id,
        status: 'approved',
      }),
    )
  }, 60_000)
})
