import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'

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
    reviewBypassMode: 'strict' | 'timeout' | 'always'
    ciEventStreamEnabled: boolean
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

const requireMock = <T>(value: T | undefined, name: string): T => {
  if (!value) {
    throw new Error(`Missing ${name} mock`)
  }
  return value
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
    listRunsByStatus: vi.fn(),
    claimRerunSubmission: vi.fn(),
    updateRerunSubmission: vi.fn(),
    getRunByWorkflow: vi.fn(),
    getRunById: vi.fn(),
    listRunsByIssue: vi.fn(),
    listRunsByBranch: vi.fn(),
    listRunsByCommitSha: vi.fn(),
    listRunsByPrNumber: vi.fn(),
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
    reviewBypassMode: 'strict',
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
  reviewBypassMode: 'strict',
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
  turnId: null,
  threadId: null,
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

describe('codex-judge CI resolution', () => {
  beforeEach(async () => {
    getRefSha.mockReset()
    getCheckRuns.mockReset()
    const githubMock = requireMock(globalState.__codexJudgeGithubMock, 'github')
    const configMock = requireMock(globalState.__codexJudgeConfigMock, 'config')
    Object.assign(githubMock, github)
    Object.assign(configMock, config)
    await requirePrivate()
  })

  it('returns pending when commit SHA is missing', async () => {
    const run = buildRun()
    const privateApi = await requirePrivate()
    const result = await privateApi.resolveCiContext(run, null)

    expect(getRefSha).not.toHaveBeenCalled()
    expect(getCheckRuns).not.toHaveBeenCalled()
    expect(result.commitSha).toBeNull()
    expect(result.ci.status).toBe('pending')
  })

  it('uses manifest commit SHA when available', async () => {
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

    const privateApi = await requirePrivate()
    const result = await privateApi.resolveCiContext(run, null)

    expect(getRefSha).not.toHaveBeenCalled()
    expect(getCheckRuns).toHaveBeenCalledWith('owner', 'repo', manifestSha)
    expect(result.commitSha).toBe(manifestSha)
  })

  it('ignores short hex values under unrelated keys', async () => {
    const run = buildRun({
      runCompletePayload: {
        metadata: {
          digest: 'deadbee',
        },
      },
    })

    const privateApi = await requirePrivate()
    const result = await privateApi.resolveCiContext(run, null)

    expect(getRefSha).not.toHaveBeenCalled()
    expect(getCheckRuns).not.toHaveBeenCalled()
    expect(result.commitSha).toBeNull()
    expect(result.ci.status).toBe('pending')
  })

  it('treats CI lookup errors as pending', async () => {
    const commitSha = 'c'.repeat(40)
    getCheckRuns.mockRejectedValueOnce(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const run = buildRun({ commitSha })
    const privateApi = await requirePrivate()
    const result = await privateApi.resolveCiContext(run, null)

    expect(getRefSha).not.toHaveBeenCalled()
    expect(getCheckRuns).toHaveBeenCalledWith('owner', 'repo', commitSha)
    expect(result.ci.status).toBe('pending')

    warn.mockRestore()
  })
})
