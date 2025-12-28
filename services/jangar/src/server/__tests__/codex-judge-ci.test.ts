import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'

import { storePrivate } from './codex-judge-store-private'

const getRefSha = vi.fn()
const getCheckRuns = vi.fn()

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
    ciMaxWaitMs: number
    reviewMaxWaitMs: number
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
    listRunsByStatus: vi.fn(),
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
    getRefSha,
    getCheckRuns,
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
    ciMaxWaitMs: 10_000,
    reviewMaxWaitMs: 10_000,
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

let __private: Awaited<typeof import('../codex-judge')>['__private'] | null = null
const github = {
  getRefSha,
  getCheckRuns,
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
  ciMaxWaitMs: 10_000,
  reviewMaxWaitMs: 10_000,
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

const buildRun = (overrides: Partial<CodexRunRecord> = {}): CodexRunRecord => ({
  id: 'run-1',
  repository: 'owner/repo',
  issueNumber: 123,
  branch: 'codex/issue-123',
  attempt: 1,
  workflowName: 'workflow-1',
  workflowUid: null,
  workflowNamespace: null,
  stage: 'implementation',
  status: 'run_complete',
  phase: null,
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

describe('codex-judge CI fallback', () => {
  beforeEach(async () => {
    getRefSha.mockReset()
    getCheckRuns.mockReset()
    Object.assign(requireMock(globalState.__codexJudgeGithubMock, 'codex judge github mock'), github)
    Object.assign(requireMock(globalState.__codexJudgeConfigMock, 'codex judge config mock'), config)
    if (!__private) {
      __private = (await import('../codex-judge')).__private
    }
  })

  it('uses branch head SHA when PR is missing', async () => {
    getRefSha.mockResolvedValueOnce('branchsha1234567890')
    getCheckRuns.mockResolvedValueOnce({ status: 'pending' })

    const run = buildRun()
    const result = await requireMock(__private, 'codex judge private').resolveCiContext(run, null)

    expect(getRefSha).toHaveBeenCalledWith('owner', 'repo', 'heads/codex/issue-123')
    expect(getCheckRuns).toHaveBeenCalledWith('owner', 'repo', 'branchsha1234567890')
    expect(result.commitSha).toBe('branchsha1234567890')
  })

  it('prefers manifest commit SHA over branch head', async () => {
    const manifestSha = 'a'.repeat(40)
    getCheckRuns.mockResolvedValueOnce({ status: 'success' })

    const run = buildRun({
      runCompletePayload: {
        artifacts: [
          {
            name: 'implementation-changes',
            metadata: {
              manifest: {
                commit_sha: manifestSha,
              },
            },
          },
        ],
      },
    })

    const result = await requireMock(__private, 'codex judge private').resolveCiContext(run, null)

    expect(getRefSha).not.toHaveBeenCalled()
    expect(getCheckRuns).toHaveBeenCalledWith('owner', 'repo', manifestSha)
    expect(result.commitSha).toBe(manifestSha)
  })

  it('ignores short hex values under unrelated keys', async () => {
    const branchSha = 'b'.repeat(40)
    getRefSha.mockResolvedValueOnce(branchSha)
    getCheckRuns.mockResolvedValueOnce({ status: 'pending' })

    const run = buildRun({
      runCompletePayload: {
        metadata: {
          digest: 'deadbee',
        },
      },
    })

    const result = await requireMock(__private, 'codex judge private').resolveCiContext(run, null)

    expect(getRefSha).toHaveBeenCalledWith('owner', 'repo', 'heads/codex/issue-123')
    expect(getCheckRuns).toHaveBeenCalledWith('owner', 'repo', branchSha)
    expect(result.commitSha).toBe(branchSha)
  })

  it('treats CI lookup errors as pending', async () => {
    const branchSha = 'c'.repeat(40)
    getRefSha.mockResolvedValueOnce(branchSha)
    getCheckRuns.mockRejectedValueOnce(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const run = buildRun()
    const result = await requireMock(__private, 'codex judge private').resolveCiContext(run, null)

    expect(getRefSha).toHaveBeenCalledWith('owner', 'repo', 'heads/codex/issue-123')
    expect(getCheckRuns).toHaveBeenCalledWith('owner', 'repo', branchSha)
    expect(result.ci.status).toBe('pending')

    warn.mockRestore()
  })
})
