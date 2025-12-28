import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'

import { storePrivate } from './codex-judge-store-private'

const upsertRunComplete = vi.fn()
const upsertArtifacts = vi.fn()

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
    listRunHistory: vi.fn(),
    getRunStats: vi.fn(),
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
  }
}

if (!globalState.__codexJudgeMemoryStoreMock) {
  globalState.__codexJudgeMemoryStoreMock = {
    persist: vi.fn(),
    close: vi.fn(),
  }
}

const requireMock = <T>(value: T | undefined, name: string): T => {
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

const getConfigMock = () => requireMock(globalState.__codexJudgeConfigMock, 'codex judge config mock')
const getStoreMock = () => requireMock(globalState.__codexJudgeStoreMock, 'codex judge store mock')
const getGithubMock = () => requireMock(globalState.__codexJudgeGithubMock, 'codex judge github mock')
const getMemoriesStoreMock = () =>
  requireMock(globalState.__codexJudgeMemoryStoreMock, 'codex judge memories store mock')

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
  createPostgresMemoriesStore: () => getMemoriesStoreMock(),
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
}
const memoriesStore = {
  persist: vi.fn(),
  close: vi.fn(),
}

beforeEach(async () => {
  upsertRunComplete.mockReset()
  upsertArtifacts.mockReset()
  Object.assign(getStoreMock(), store)
  Object.assign(getGithubMock(), github)
  Object.assign(getConfigMock(), config)
  Object.assign(getMemoriesStoreMock(), memoriesStore)
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
    if (!handleRunComplete) {
      throw new Error('codex judge handler not loaded')
    }
    const result = await handleRunComplete(buildPayload())

    expect(result?.status).toBe('superseded')
    expect(timeoutSpy).not.toHaveBeenCalled()

    timeoutSpy.mockRestore()
  })
})
