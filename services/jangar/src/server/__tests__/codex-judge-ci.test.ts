import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexRunRecord } from '../codex-judge-store'

const getRefSha = vi.fn()
const getCheckRuns = vi.fn()

vi.mock('../codex-judge-config', () => ({
  loadCodexJudgeConfig: () => ({
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
  }),
}))

vi.mock('../codex-judge-store', () => ({
  createCodexJudgeStore: () => ({}),
}))

vi.mock('../github-client', () => ({
  createGitHubClient: () => ({
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
  }),
}))

const { __private } = await import('../codex-judge')

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
  beforeEach(() => {
    getRefSha.mockReset()
    getCheckRuns.mockReset()
  })

  it('uses branch head SHA when PR is missing', async () => {
    getRefSha.mockResolvedValueOnce('branchsha1234567890')
    getCheckRuns.mockResolvedValueOnce({ status: 'pending' })

    const run = buildRun()
    const result = await __private.resolveCiContext(run, null)

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

    const result = await __private.resolveCiContext(run, null)

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

    const result = await __private.resolveCiContext(run, null)

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
    const result = await __private.resolveCiContext(run, null)

    expect(getRefSha).toHaveBeenCalledWith('owner', 'repo', 'heads/codex/issue-123')
    expect(getCheckRuns).toHaveBeenCalledWith('owner', 'repo', branchSha)
    expect(result.ci.status).toBe('pending')

    warn.mockRestore()
  })
})
