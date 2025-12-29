import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'

import { storePrivate } from './codex-judge-store-private'

const getRefSha = vi.fn()
const getCheckRuns = vi.fn()

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

describe('codex-judge CI fallback', () => {
  beforeEach(async () => {
    getRefSha.mockReset()
    getCheckRuns.mockReset()
    Object.assign(getGithubMock(), github)
    Object.assign(getConfigMock(), config)
    if (!__private) {
      __private = (await import('../codex-judge')).__private
    }
  })

  it('uses branch head SHA when PR is missing', async () => {
    getRefSha.mockResolvedValueOnce('branchsha1234567890')
    getCheckRuns.mockResolvedValueOnce({ status: 'pending' })

    const run = buildRun()
    const result = await getPrivate().resolveCiContext(run, null)

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

    const result = await getPrivate().resolveCiContext(run, null)

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

    const result = await getPrivate().resolveCiContext(run, null)

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
    const result = await getPrivate().resolveCiContext(run, null)

    expect(getRefSha).toHaveBeenCalledWith('owner', 'repo', 'heads/codex/issue-123')
    expect(getCheckRuns).toHaveBeenCalledWith('owner', 'repo', branchSha)
    expect(result.ci.status).toBe('pending')

    warn.mockRestore()
  })
})
