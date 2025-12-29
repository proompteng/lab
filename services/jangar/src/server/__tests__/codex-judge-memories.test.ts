import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexEvaluationRecord, CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'
import type { MemoriesStore, PersistMemoryInput } from '../memories-store'

import { storePrivate } from './codex-judge-store-private'

const persistCalls: PersistMemoryInput[] = []

const setMemoryStoreFactory = (factory?: () => MemoriesStore) => {
  const globalWithOverride = globalThis as typeof globalThis & {
    __codexJudgeMemoryStoreFactory?: () => MemoriesStore
  }
  if (factory) {
    globalWithOverride.__codexJudgeMemoryStoreFactory = factory
  } else {
    delete globalWithOverride.__codexJudgeMemoryStoreFactory
  }
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
    ciPollIntervalMs: number
    reviewPollIntervalMs: number
    maxAttempts: number
    backoffScheduleMs: number[]
    facteurBaseUrl: string
    argoServerUrl: string | null
    discordBotToken: string | null
    discordChannelId: string | null
    discordApiBaseUrl: string
    judgeModel: string
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
    getRunByWorkflow: vi.fn(),
    getRunById: vi.fn(),
    listRunsByIssue: vi.fn(),
    getRunHistory: vi.fn(),
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
    ciPollIntervalMs: 1000,
    reviewPollIntervalMs: 1000,
    maxAttempts: 3,
    backoffScheduleMs: [1000],
    facteurBaseUrl: 'http://facteur',
    argoServerUrl: null,
    discordBotToken: null,
    discordChannelId: null,
    discordApiBaseUrl: 'https://discord.com/api/v10',
    judgeModel: 'gpt-5.2-codex',
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

const getStoreMock = () => {
  if (!globalState.__codexJudgeStoreMock) {
    throw new Error('codex judge store mock not initialized')
  }
  return globalState.__codexJudgeStoreMock
}

const getGithubMock = () => {
  if (!globalState.__codexJudgeGithubMock) {
    throw new Error('codex judge github mock not initialized')
  }
  return globalState.__codexJudgeGithubMock
}

const getConfigMock = () => {
  if (!globalState.__codexJudgeConfigMock) {
    throw new Error('codex judge config mock not initialized')
  }
  return globalState.__codexJudgeConfigMock
}

const getMemoryStoreMock = () => {
  if (!globalState.__codexJudgeMemoryStoreMock) {
    throw new Error('codex judge memory store mock not initialized')
  }
  return globalState.__codexJudgeMemoryStoreMock
}

vi.mock('../codex-judge-config', () => ({
  loadCodexJudgeConfig: () => getConfigMock(),
}))

vi.mock('../codex-judge-store', () => ({
  __private: storePrivate,
  createCodexJudgeStore: () => getStoreMock(),
}))

vi.mock('../github-client', () => ({
  createGitHubClient: () => getGithubMock(),
}))

vi.mock('../memories-store', () => ({
  createPostgresMemoriesStore: () => getMemoryStoreMock(),
}))

let __private: Awaited<typeof import('../codex-judge')>['__private'] | null = null
const getPrivate = () => {
  if (!__private) {
    throw new Error('codex judge private api not initialized')
  }
  return __private
}
const store = {
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
  getRunByWorkflow: vi.fn(),
  getRunById: vi.fn(),
  listRunsByIssue: vi.fn(),
  getRunHistory: vi.fn(),
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
  ciPollIntervalMs: 1000,
  reviewPollIntervalMs: 1000,
  maxAttempts: 3,
  backoffScheduleMs: [1000],
  facteurBaseUrl: 'http://facteur',
  argoServerUrl: null,
  discordBotToken: null,
  discordChannelId: null,
  discordApiBaseUrl: 'https://discord.com/api/v10',
  judgeModel: 'gpt-5.2-codex',
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
  Object.assign(getStoreMock(), store)
  Object.assign(getGithubMock(), github)
  Object.assign(getConfigMock(), config)
  Object.assign(getMemoryStoreMock(), memoriesStore)
  setMemoryStoreFactory(() => memoriesStore)
  if (!__private) {
    __private = (await import('../codex-judge')).__private
  }
})

afterEach(() => {
  setMemoryStoreFactory()
})

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
      stage: 'implementation',
      status: 'completed',
      phase: null,
      prompt: 'prompt',
      nextPrompt: 'next prompt',
      commitSha: 'a'.repeat(40),
      prNumber: 42,
      prUrl: 'https://github.com/proompteng/lab/pull/42',
      ciStatus: 'success',
      ciUrl: 'https://github.com/proompteng/lab/actions/runs/1',
      ciStatusUpdatedAt: null,
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

    await getPrivate().writeMemories(run, evaluation)

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
