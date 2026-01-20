import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexEvaluationRecord, CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'
import type { PersistMemoryInput } from '../memories-store'

const persistCalls: PersistMemoryInput[] = []

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
  __codexJudgeMemoryStoreMock?: {
    persist: (input: PersistMemoryInput) => Promise<{
      id: string
      namespace: string
      content: string
      summary: string | null
      tags: string[]
      metadata: Record<string, unknown>
      createdAt: string
    }>
    retrieve: () => Promise<unknown[]>
    count: () => Promise<number>
    close: () => Promise<void>
  }
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
    persist: async (input: PersistMemoryInput) => {
      persistCalls.push(input)
      return {
        id: `mem-${persistCalls.length}`,
        namespace: input.namespace ?? 'default',
        content: input.content,
        summary: input.summary ?? null,
        tags: input.tags ?? [],
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
      }
    },
    retrieve: async () => [],
    count: async () => 0,
    close: async () => {},
  }
}

let __private: Awaited<typeof import('../codex-judge')>['__private'] | null = null

const requirePrivate = async () => {
  if (!__private) {
    __private = (await import('../codex-judge')).__private
  }
  if (!__private) {
    throw new Error('Missing codex judge private API')
  }
  return __private
}
const store = {
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
  persist: async (input: PersistMemoryInput) => {
    persistCalls.push(input)
    return {
      id: `mem-${persistCalls.length}`,
      namespace: input.namespace ?? 'default',
      content: input.content,
      summary: input.summary ?? null,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    }
  },
  retrieve: async () => [],
  count: async () => 0,
  close: async () => {},
}

beforeEach(async () => {
  const storeMock = requireMock(globalState.__codexJudgeStoreMock, 'store')
  const githubMock = requireMock(globalState.__codexJudgeGithubMock, 'github')
  const configMock = requireMock(globalState.__codexJudgeConfigMock, 'config')
  const memoryStoreMock = requireMock(globalState.__codexJudgeMemoryStoreMock, 'memory store')
  Object.assign(storeMock, store)
  Object.assign(githubMock, github)
  Object.assign(configMock, config)
  Object.assign(memoryStoreMock, memoriesStore)
  await requirePrivate()
}, 60_000)

describe('codex-judge memory snapshots', () => {
  it('attaches run metadata to all snapshots', async () => {
    persistCalls.length = 0

    const run: CodexRunRecord = {
      id: 'run-1',
      repository: 'proompteng/lab',
      issueNumber: 2126,
      branch: 'codex/issue-2126',
      attempt: 2,
      workflowName: 'workflow-1',
      workflowUid: 'workflow-uid',
      workflowNamespace: 'jangar',
      turnId: null,
      threadId: null,
      stage: 'implementation',
      status: 'completed',
      phase: null,
      iteration: null,
      iterationCycle: null,
      prompt: 'prompt',
      nextPrompt: 'next prompt',
      commitSha: 'a'.repeat(40),
      prNumber: 42,
      prUrl: 'https://github.com/proompteng/lab/pull/42',
      ciStatus: 'success',
      ciUrl: 'https://github.com/proompteng/lab/actions/runs/1',
      ciStatusUpdatedAt: '2025-01-01T00:10:00Z',
      reviewStatus: null,
      reviewSummary: {},
      reviewStatusUpdatedAt: null,
      notifyPayload: null,
      runCompletePayload: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      startedAt: '2025-01-01T00:00:00Z',
      finishedAt: '2025-01-01T01:00:00Z',
    }

    const evaluation: CodexEvaluationRecord = {
      id: 'eval-1',
      runId: 'run-1',
      decision: 'pass',
      confidence: 1,
      reasons: {},
      missingItems: {},
      suggestedFixes: {},
      nextPrompt: null,
      promptTuning: {},
      systemSuggestions: {},
      createdAt: '2025-01-01T01:00:00Z',
    }

    const privateApi = await requirePrivate()
    await privateApi.writeMemories(run, evaluation)

    expect(persistCalls).toHaveLength(10)

    for (const call of persistCalls) {
      expect(call.metadata).toMatchObject({
        runId: 'run-1',
        commitSha: run.commitSha,
        ciUrl: run.ciUrl,
        workflowName: run.workflowName,
        workflowNamespace: run.workflowNamespace,
        workflowUid: run.workflowUid,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })
    }
  })
})
