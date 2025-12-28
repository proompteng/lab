import { describe, expect, it, vi } from 'vitest'

import type { CodexRunRecord } from '../codex-judge-store'

const upsertRunComplete = vi.fn()
const upsertArtifacts = vi.fn()

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
  createCodexJudgeStore: () => ({
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
  }),
}))

vi.mock('../github-client', () => ({
  createGitHubClient: () => ({
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
  }),
}))

const { handleRunComplete } = await import('../codex-judge')

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
    const result = await handleRunComplete(buildPayload())

    expect(result?.status).toBe('superseded')
    expect(timeoutSpy).not.toHaveBeenCalled()

    timeoutSpy.mockRestore()
  })
})
