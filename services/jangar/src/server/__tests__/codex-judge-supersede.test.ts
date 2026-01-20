import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'

const upsertRunComplete = vi.fn()
const upsertArtifacts = vi.fn()

const requireMock = <T>(value: T | undefined, name: string): T => {
  if (!value) {
    throw new Error(`Missing ${name} mock`)
  }
  return value
}

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
    argoServerUrl: string | null
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
  }
  __codexJudgeMemoryStoreMock?: { persist: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
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
  globalState.__codexJudgeGithubMock = {
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
}

if (!globalState.__codexJudgeConfigMock) {
  globalState.__codexJudgeConfigMock = {
    githubToken: null,
    githubApiBaseUrl: 'https://api.github.com',
    codexReviewers: [],
    ciEventStreamEnabled: false,
    ciMaxWaitMs: 10_000,
    reviewMaxWaitMs: 10_000,
    maxAttempts: 3,
    backoffScheduleMs: [1000],
    facteurBaseUrl: 'http://facteur',
    argoServerUrl: null,
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
  }
}

if (!globalState.__codexJudgeMemoryStoreMock) {
  globalState.__codexJudgeMemoryStoreMock = {
    persist: vi.fn(),
    close: vi.fn(),
  }
}

let handleRunComplete: Awaited<typeof import('../codex-judge')>['handleRunComplete'] | null = null

const requireHandleRunComplete = async () => {
  if (!handleRunComplete) {
    handleRunComplete = (await import('../codex-judge')).handleRunComplete
  }
  if (!handleRunComplete) {
    throw new Error('Missing codex judge handler')
  }
  return handleRunComplete
}
const store = {
  ready: Promise.resolve(),
  upsertRunComplete,
  attachNotify: vi.fn(),
  updateCiStatus: vi.fn(),
  updateReviewStatus: vi.fn(),
  updateDecision: vi.fn(),
  updateRunStatus: vi.fn(),
  updateRunPrompt: vi.fn(),
  updateRunPrInfo: vi.fn(),
  upsertArtifacts,
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
const github = {
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
const config = {
  githubToken: null,
  githubApiBaseUrl: 'https://api.github.com',
  codexReviewers: [],
  ciEventStreamEnabled: false,
  ciMaxWaitMs: 10_000,
  reviewMaxWaitMs: 10_000,
  maxAttempts: 3,
  backoffScheduleMs: [1000],
  facteurBaseUrl: 'http://facteur',
  argoServerUrl: null,
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
}
const memoriesStore = {
  persist: vi.fn(),
  close: vi.fn(),
}

beforeEach(async () => {
  upsertRunComplete.mockReset()
  upsertArtifacts.mockReset()
  const storeMock = requireMock(globalState.__codexJudgeStoreMock, 'store')
  const githubMock = requireMock(globalState.__codexJudgeGithubMock, 'github')
  const configMock = requireMock(globalState.__codexJudgeConfigMock, 'config')
  const memoryStoreMock = requireMock(globalState.__codexJudgeMemoryStoreMock, 'memory store')
  Object.assign(storeMock, store)
  Object.assign(githubMock, github)
  Object.assign(configMock, config)
  Object.assign(memoryStoreMock, memoriesStore)
})

beforeAll(async () => {
  handleRunComplete = null
  await requireHandleRunComplete()
}, 60_000)

const buildRun = (overrides: Partial<CodexRunRecord> = {}): CodexRunRecord => ({
  id: 'run-1',
  repository: 'owner/repo',
  issueNumber: 123,
  branch: 'codex/issue-123',
  attempt: 1,
  workflowName: 'workflow-1',
  workflowUid: null,
  workflowNamespace: 'argo',
  turnId: null,
  threadId: null,
  stage: 'implementation',
  status: 'superseded',
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

const buildPayload = () => {
  const eventBody = {
    repository: 'owner/repo',
    issueNumber: 123,
    head: 'codex/issue-123',
    base: 'main',
    prompt: 'Do the thing',
  }
  const encodedEventBody = Buffer.from(JSON.stringify(eventBody)).toString('base64')

  return {
    data: {
      metadata: {
        name: 'workflow-1',
        uid: 'workflow-uid-1',
        namespace: 'argo',
      },
      status: {
        phase: 'Succeeded',
        startedAt: '2025-01-01T00:00:00Z',
        finishedAt: '2025-01-01T00:10:00Z',
      },
      arguments: {
        parameters: [{ name: 'eventBody', value: encodedEventBody }],
      },
    },
  } as Record<string, unknown>
}

describe('codex judge superseded runs', () => {
  it('does not schedule evaluation when a run is superseded', async () => {
    const run = buildRun()
    upsertRunComplete.mockResolvedValueOnce(run)
    upsertArtifacts.mockResolvedValueOnce([])

    const timeoutSpy = vi.spyOn(global, 'setTimeout')
    const handler = await requireHandleRunComplete()
    const result = await handler(buildPayload())

    expect(result?.status).toBe('superseded')
    expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 1000)

    timeoutSpy.mockRestore()
  })
})

describe('codex judge run-complete ingestion', () => {
  const buildMetadataPayload = () =>
    ({
      data: {
        metadata: {
          name: 'workflow-1',
          uid: 'workflow-uid-1',
          namespace: 'argo',
          labels: {
            'codex.repository': 'owner/repo',
            'codex.issue_number': '456',
            'codex.head': 'codex/issue-456',
            'codex.base': 'main',
          },
          annotations: {
            'codex.turn_id': 'turn-123',
            'codex.thread_id': 'thread-456',
          },
        },
        status: {
          phase: 'Failed',
          startedAt: '2025-01-01T00:00:00Z',
          finishedAt: '2025-01-01T00:05:00Z',
        },
        arguments: {
          parameters: [],
        },
      },
    }) as Record<string, unknown>

  it('uses workflow metadata when eventBody is missing', async () => {
    const run = buildRun({ status: 'run_complete' })
    upsertRunComplete.mockResolvedValueOnce(run)
    upsertArtifacts.mockResolvedValueOnce([])
    store.getRunByWorkflow.mockResolvedValueOnce(null)

    const handler = await requireHandleRunComplete()
    await handler(buildMetadataPayload())

    expect(upsertRunComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'owner/repo',
        issueNumber: 456,
        branch: 'codex/issue-456',
        phase: 'Failed',
        turnId: 'turn-123',
        threadId: 'thread-456',
        runCompletePayload: expect.objectContaining({
          base: 'main',
          head: 'codex/issue-456',
          repository: 'owner/repo',
          issueNumber: 456,
        }),
      }),
    )
  })

  it('persists failed run-complete events without notify', async () => {
    const run = buildRun({ status: 'run_complete', phase: 'Failed' })
    upsertRunComplete.mockResolvedValueOnce(run)
    upsertArtifacts.mockResolvedValueOnce([])
    store.getRunByWorkflow.mockResolvedValueOnce(null)

    const handler = await requireHandleRunComplete()
    const result = await handler(buildMetadataPayload())

    expect(result).toBe(run)
    expect(upsertRunComplete).toHaveBeenCalled()
  })
})
