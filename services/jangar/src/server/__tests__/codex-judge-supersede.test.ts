import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'

import { storePrivate } from './codex-judge-store-private'

const upsertRunComplete = vi.fn()
const upsertArtifacts = vi.fn()

const requireMock = <T>(value: T | null | undefined, label: string): T => {
  if (!value) {
    throw new Error(`${label} was not initialized`)
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
  __codexJudgeMemoryStoreMock?: { persist: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
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
    persist: vi.fn(),
    close: vi.fn(),
  }
}

vi.mock('../codex-judge-config', () => ({
  loadCodexJudgeConfig: () => requireMock(globalState.__codexJudgeConfigMock, 'codex judge config mock'),
}))

vi.mock('../codex-judge-store', () => ({
  __private: storePrivate,
  createCodexJudgeStore: () => requireMock(globalState.__codexJudgeStoreMock, 'codex judge store mock'),
}))

vi.mock('../github-client', () => ({
  createGitHubClient: () => requireMock(globalState.__codexJudgeGithubMock, 'codex judge github mock'),
}))

vi.mock('../memories-store', () => ({
  createPostgresMemoriesStore: () =>
    requireMock(globalState.__codexJudgeMemoryStoreMock, 'codex judge memory store mock'),
}))

let handleRunComplete: Awaited<typeof import('../codex-judge')>['handleRunComplete'] | null = null
const store = {
  upsertRunComplete,
  attachNotify: vi.fn(),
  updateCiStatus: vi.fn(),
  updateReviewStatus: vi.fn(),
  updateDecision: vi.fn(),
  updateRunStatus: vi.fn(),
  updateRunPrompt: vi.fn(),
  updateRunPrInfo: vi.fn(),
  upsertArtifacts,
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
  persist: vi.fn(),
  close: vi.fn(),
}

beforeEach(async () => {
  upsertRunComplete.mockReset()
  upsertArtifacts.mockReset()
  Object.assign(requireMock(globalState.__codexJudgeStoreMock, 'codex judge store mock'), store)
  Object.assign(requireMock(globalState.__codexJudgeGithubMock, 'codex judge github mock'), github)
  Object.assign(requireMock(globalState.__codexJudgeConfigMock, 'codex judge config mock'), config)
  Object.assign(requireMock(globalState.__codexJudgeMemoryStoreMock, 'codex judge memory store mock'), memoriesStore)
  if (!handleRunComplete) {
    handleRunComplete = (await import('../codex-judge')).handleRunComplete
  }
})

const buildRun = (overrides: Partial<CodexRunRecord> = {}): CodexRunRecord => ({
  id: 'run-1',
  repository: 'owner/repo',
  issueNumber: 123,
  branch: 'codex/issue-123',
  attempt: 1,
  workflowName: 'workflow-1',
  workflowUid: null,
  workflowNamespace: 'argo',
  stage: 'implementation',
  status: 'superseded',
  phase: null,
  prompt: null,
  nextPrompt: null,
  commitSha: null,
  prNumber: null,
  prUrl: null,
  ciStatus: null,
  ciUrl: null,
  reviewStatus: null,
  reviewSummary: {},
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
    const result = await requireMock(handleRunComplete, 'codex judge handler')(buildPayload())

    expect(result?.status).toBe('superseded')
    expect(timeoutSpy).not.toHaveBeenCalled()

    timeoutSpy.mockRestore()
  })
})
