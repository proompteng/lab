import type { CodexAppServerClient } from '@proompteng/codex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetCodexClient, setCodexClientFactory } from '~/server/codex-client'
import type { ReviewSummary } from '~/server/github-client'
import type {
  CodexEvaluationRecord,
  CodexJudgeStore,
  CodexRerunSubmissionRecord,
  CodexRunRecord,
} from '../codex-judge-store'

let __private: Awaited<typeof import('../codex-judge')>['__private'] | null = null

const globalState = globalThis as typeof globalThis & {
  __codexJudgeStoreMock?: CodexJudgeStore
  __codexJudgeGithubMock?: {
    getPullRequestByHead: ReturnType<typeof vi.fn>
    getPullRequest: ReturnType<typeof vi.fn>
    getPullRequestDiff: ReturnType<typeof vi.fn>
    getCheckRuns: ReturnType<typeof vi.fn>
    getReviewSummary: ReturnType<typeof vi.fn>
    getRefSha: ReturnType<typeof vi.fn>
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
    discordBotToken: string | null
    discordChannelId: string | null
    discordApiBaseUrl: string
    promptTuningEnabled: boolean
    promptTuningRepo: string | null
    promptTuningFailureThreshold: number
    promptTuningWindowHours: number
    promptTuningCooldownHours: number
    rerunWorkflowTemplate: string | null
    rerunWorkflowNamespace: string
    systemImprovementWorkflowTemplate: string | null
    systemImprovementWorkflowNamespace: string
    systemImprovementJudgePrompt: string
    defaultJudgePrompt: string
  }
  __codexJudgeMemoryStoreMock?: { persist: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  __codexJudgeClientMock?: CodexAppServerClient
  __codexJudgeArgoMock?: { submitWorkflowTemplate: ReturnType<typeof vi.fn> } | null
  __codexJudgeReviewStoreMock?: {
    ready: Promise<void>
    listFiles: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
}

vi.mock('~/server/github-review-store', () => ({
  createGithubReviewStore: () => {
    const state = globalThis as typeof globalThis & {
      __codexJudgeReviewStoreMock?: {
        ready: Promise<void>
        listFiles: ReturnType<typeof vi.fn>
        close: ReturnType<typeof vi.fn>
      }
    }
    if (!state.__codexJudgeReviewStoreMock) {
      state.__codexJudgeReviewStoreMock = {
        ready: Promise.resolve(),
        listFiles: vi.fn(async () => []),
        close: vi.fn(async () => {}),
      }
    }
    return state.__codexJudgeReviewStoreMock
  },
}))

const requireMock = <T>(value: T | undefined, name: string): T => {
  if (!value) {
    throw new Error(`Missing ${name} mock`)
  }
  return value
}

const requirePrivate = async () => {
  if (!__private) {
    __private = (await import('../codex-judge')).__private
  }
  if (!__private) {
    throw new Error('Missing codex judge private API')
  }
  return __private
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
    enqueueRerunSubmission: vi.fn(),
    listRerunSubmissions: vi.fn(),
    getLatestPromptTuningByIssue: vi.fn(),
    createPromptTuning: vi.fn(),
    close: vi.fn(),
  }
}

if (!globalState.__codexJudgeGithubMock) {
  globalState.__codexJudgeGithubMock = {
    getPullRequestByHead: vi.fn(),
    getPullRequest: vi.fn(),
    getPullRequestDiff: vi.fn(),
    getCheckRuns: vi.fn(),
    getReviewSummary: vi.fn(),
    getRefSha: vi.fn(),
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
    backoffScheduleMs: [0],
    facteurBaseUrl: 'http://facteur.test',
    argoServerUrl: null,
    discordBotToken: null,
    discordChannelId: null,
    discordApiBaseUrl: 'https://discord.com/api/v10',
    promptTuningEnabled: false,
    promptTuningRepo: null,
    promptTuningFailureThreshold: 3,
    promptTuningWindowHours: 24,
    promptTuningCooldownHours: 6,
    rerunWorkflowTemplate: 'codex-autonomous',
    rerunWorkflowNamespace: 'argo-workflows',
    systemImprovementWorkflowTemplate: 'codex-autonomous',
    systemImprovementWorkflowNamespace: 'argo-workflows',
    systemImprovementJudgePrompt: 'system improvement judge prompt',
    defaultJudgePrompt: 'judge prompt',
  }
}

if (!globalState.__codexJudgeMemoryStoreMock) {
  globalState.__codexJudgeMemoryStoreMock = {
    persist: vi.fn(),
    close: vi.fn(),
  }
}

if (!globalState.__codexJudgeArgoMock) {
  globalState.__codexJudgeArgoMock = {
    submitWorkflowTemplate: vi.fn(),
  }
}

if (!globalState.__codexJudgeReviewStoreMock) {
  globalState.__codexJudgeReviewStoreMock = {
    ready: Promise.resolve(),
    listFiles: vi.fn(),
    close: vi.fn(),
  }
}

const harness = (() => {
  const now = new Date('2025-12-28T00:00:00.000Z').toISOString()

  const makeRun = (): CodexRunRecord => ({
    id: 'run-1',
    repository: 'proompteng/lab',
    issueNumber: 2125,
    branch: 'codex/issue-2125',
    attempt: 1,
    workflowName: 'workflow-1',
    workflowUid: null,
    workflowNamespace: null,
    turnId: null,
    threadId: null,
    stage: 'implementation',
    status: 'run_complete',
    phase: 'Succeeded',
    iteration: null,
    iterationCycle: null,
    prompt: 'Implement the change.',
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
    notifyPayload: {},
    runCompletePayload: {
      issueTitle: 'Issue title',
      issueBody: 'Issue body',
      issueUrl: 'https://github.com/proompteng/lab/issues/2125',
      base: 'main',
      head: 'codex/issue-2125',
    },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: now,
  })

  let run = makeRun()
  const evaluations: CodexEvaluationRecord[] = []
  const judgePrompts: string[] = []
  const judgeResponses: string[] = []

  const setRun = (partial: Partial<CodexRunRecord>) => {
    run = { ...run, ...partial }
  }

  const reset = () => {
    run = makeRun()
    evaluations.length = 0
    judgePrompts.length = 0
    judgeResponses.length = 0
    reviewStore.listFiles.mockReset()
    reviewStore.listFiles.mockResolvedValue([
      {
        path: 'services/jangar/src/server/codex-judge.ts',
        status: 'modified',
        patch: 'diff --git a/file b/file\n+change',
      },
    ])
  }

  const codexClient = {
    runTurn: vi.fn(async (prompt: string) => {
      judgePrompts.push(prompt)
      const text = judgeResponses.shift() ?? ''
      return { text }
    }),
    stop: vi.fn(),
    ensureReady: vi.fn(),
  }

  const store = {
    ready: Promise.resolve(),
    getRunById: vi.fn(async (runId: string) => (runId === run.id ? run : null)),
    updateRunStatus: vi.fn(async (runId: string, status: string) => {
      if (runId !== run.id) return null
      run = { ...run, status }
      return run
    }),
    updateRunPrompt: vi.fn(async (runId: string, prompt: string | null, nextPrompt?: string | null) => {
      if (runId !== run.id) return null
      run = { ...run, prompt, nextPrompt: nextPrompt ?? null }
      return run
    }),
    updateRunPrInfo: vi.fn(async (runId: string, prNumber: number, prUrl: string, commitSha?: string | null) => {
      if (runId !== run.id) return null
      run = { ...run, prNumber, prUrl, commitSha: commitSha ?? run.commitSha }
      return run
    }),
    updateCiStatus: vi.fn(async (input: { runId: string; status: string; url?: string | null; commitSha?: string }) => {
      if (input.runId !== run.id) return null
      run = {
        ...run,
        ciStatus: input.status,
        ciUrl: input.url ?? null,
        commitSha: input.commitSha ?? run.commitSha,
      }
      return run
    }),
    updateReviewStatus: vi.fn(async (input: { runId: string; status: string; summary: Record<string, unknown> }) => {
      if (input.runId !== run.id) return null
      run = { ...run, reviewStatus: input.status, reviewSummary: input.summary }
      return run
    }),
    updateDecision: vi.fn(
      async (input: {
        runId: string
        decision: string
        confidence?: number | null
        reasons?: Record<string, unknown>
        missingItems?: Record<string, unknown>
        suggestedFixes?: Record<string, unknown>
        nextPrompt?: string | null
        promptTuning?: Record<string, unknown>
        systemSuggestions?: Record<string, unknown>
      }) => {
        const evaluation: CodexEvaluationRecord = {
          id: `eval-${evaluations.length + 1}`,
          runId: input.runId,
          decision: input.decision,
          confidence: input.confidence ?? null,
          reasons: input.reasons ?? {},
          missingItems: input.missingItems ?? {},
          suggestedFixes: input.suggestedFixes ?? {},
          nextPrompt: input.nextPrompt ?? null,
          promptTuning: input.promptTuning ?? {},
          systemSuggestions: input.systemSuggestions ?? {},
          createdAt: now,
        }
        evaluations.push(evaluation)
        run = {
          ...run,
          status: input.decision === 'pass' ? 'completed' : input.decision,
          nextPrompt: input.nextPrompt ?? null,
        }
        return evaluation
      },
    ),
    listRunsByIssue: vi.fn(async () => [run]),
    listRunsByBranch: vi.fn(async () => []),
    listRunsByCommitSha: vi.fn(async () => []),
    listRunsByPrNumber: vi.fn(async () => []),
    listRunsByStatus: vi.fn(async () => [run]),
    listRerunSubmissions: vi.fn(async () => [] as CodexRerunSubmissionRecord[]),
    claimRerunSubmission: vi.fn(async ({ attempt, deliveryId }: { attempt: number; deliveryId: string }) => ({
      submission: {
        id: `rerun-${attempt}`,
        parentRunId: run.id,
        attempt,
        deliveryId,
        status: 'queued',
        submissionAttempt: 0,
        responseStatus: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        submittedAt: null,
      },
      shouldSubmit: true,
    })),
    enqueueRerunSubmission: vi.fn(async ({ parentRunId, attempt, deliveryId }) => ({
      id: `rerun-${attempt}`,
      parentRunId,
      attempt,
      deliveryId,
      status: 'queued',
      submissionAttempt: 0,
      responseStatus: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
    })),
    updateRerunSubmission: vi.fn(async ({ id, status, responseStatus, error, submittedAt }) => ({
      id,
      parentRunId: run.id,
      attempt: run.attempt + 1,
      deliveryId: `jangar-${run.id}-attempt-${run.attempt + 1}`,
      status,
      submissionAttempt: 1,
      responseStatus: responseStatus ?? null,
      error: error ?? null,
      createdAt: now,
      updatedAt: now,
      submittedAt: submittedAt ?? null,
    })),
    getLatestPromptTuningByIssue: vi.fn(async () => null),
    getRunHistory: vi.fn(async () => ({
      runs: [],
      stats: {
        completionRate: null,
        avgAttemptsPerIssue: null,
        failureReasonCounts: {},
        avgCiDurationSeconds: null,
        avgJudgeConfidence: null,
      },
    })),
    createPromptTuning: vi.fn(async () => ({
      id: 'prompt-1',
      runId: run.id,
      prUrl: 'https://github.com/proompteng/lab/pull/1',
      status: 'open',
      metadata: {},
      createdAt: now,
    })),
  }

  const defaultReviewSummary: ReviewSummary = {
    status: 'approved',
    unresolvedThreads: [],
    requestedChanges: false,
    reviewComments: [],
    issueComments: [],
  }

  const github = {
    getPullRequestByHead: vi.fn(async () => ({
      number: 101,
      url: 'https://api.github.com/repos/proompteng/lab/pulls/101',
      htmlUrl: 'https://github.com/proompteng/lab/pull/101',
      headSha: 'sha-1',
      headRef: 'codex/issue-2125',
      baseRef: 'main',
      state: 'open',
      title: 'PR title',
      body: null,
      mergeableState: 'clean',
    })),
    getPullRequest: vi.fn(async () => ({
      number: 101,
      url: 'https://api.github.com/repos/proompteng/lab/pulls/101',
      htmlUrl: 'https://github.com/proompteng/lab/pull/101',
      headSha: 'sha-1',
      headRef: 'codex/issue-2125',
      baseRef: 'main',
      state: 'open',
      title: 'PR title',
      body: null,
      mergeableState: 'clean',
    })),
    getCheckRuns: vi.fn(async () => ({ status: 'success' as const, url: 'https://ci.example.com' })),
    getReviewSummary: vi.fn<() => Promise<ReviewSummary>>(async () => defaultReviewSummary),
    getPullRequestDiff: vi.fn(async () => 'diff --git a/file b/file'),
    getRefSha: vi.fn(async () => 'sha-1'),
    getFile: vi.fn(async (_owner: string, _repo: string, _path: string) => ({ content: '', sha: 'file-sha' })),
    updateFile: vi.fn(async () => ({})),
    createBranch: vi.fn(async () => ({})),
    createPullRequest: vi.fn(async () => ({ html_url: 'https://github.com/proompteng/lab/pull/101' })),
  }

  const reviewStore = {
    ready: Promise.resolve(),
    listFiles: vi.fn(async () => [
      {
        path: 'services/jangar/src/server/codex-judge.ts',
        status: 'modified',
        patch: 'diff --git a/file b/file\n+change',
      },
    ]),
    close: vi.fn(async () => {}),
  }

  const argo = {
    submitWorkflowTemplate: vi.fn(async () => ({})),
  }

  const config = requireMock(globalState.__codexJudgeConfigMock, 'config')
  Object.assign(config, {
    githubToken: null,
    githubApiBaseUrl: 'https://api.github.com',
    codexReviewers: [],
    ciEventStreamEnabled: false,
    ciMaxWaitMs: 10_000,
    reviewMaxWaitMs: 10_000,
    maxAttempts: 3,
    backoffScheduleMs: [0],
    facteurBaseUrl: 'http://facteur.test',
    argoServerUrl: null,
    discordBotToken: null,
    discordChannelId: null,
    discordApiBaseUrl: 'https://discord.com/api/v10',
    promptTuningEnabled: false,
    promptTuningRepo: null,
    promptTuningFailureThreshold: 3,
    promptTuningWindowHours: 24,
    promptTuningCooldownHours: 6,
    rerunWorkflowTemplate: 'codex-autonomous',
    rerunWorkflowNamespace: 'argo-workflows',
    systemImprovementWorkflowTemplate: 'codex-autonomous',
    systemImprovementWorkflowNamespace: 'argo-workflows',
    systemImprovementJudgePrompt: 'system improvement judge prompt',
    defaultJudgePrompt: 'judge prompt',
  })

  const memoriesStore = {
    persist: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }

  const storeMock = requireMock(globalState.__codexJudgeStoreMock, 'store')
  const githubMock = requireMock(globalState.__codexJudgeGithubMock, 'github')
  const memoryStoreMock = requireMock(globalState.__codexJudgeMemoryStoreMock, 'memory store')
  const argoMock = requireMock(globalState.__codexJudgeArgoMock, 'argo')
  const reviewStoreMock = requireMock(globalState.__codexJudgeReviewStoreMock, 'review store')

  Object.assign(storeMock, store)
  Object.assign(githubMock, github)
  Object.assign(memoryStoreMock, memoriesStore)
  Object.assign(argoMock, argo)
  Object.assign(reviewStoreMock, reviewStore)
  globalState.__codexJudgeClientMock = codexClient as unknown as CodexAppServerClient

  const setJudgeResponses = (responses: string[]) => {
    judgeResponses.splice(0, judgeResponses.length, ...responses)
  }

  const setWorktreeFiles = (files: Array<{ path: string; status?: string | null; patch?: string | null }>) => {
    const normalized = files.map((file) => ({
      path: file.path,
      status: file.status ?? 'modified',
      patch: file.patch ?? '',
    }))
    reviewStore.listFiles.mockResolvedValue(normalized)
  }

  return {
    codexClient,
    store,
    github,
    config,
    memoriesStore,
    argo,
    reviewStore,
    reset,
    setRun,
    setJudgeResponses,
    setWorktreeFiles,
    judgePrompts,
  }
})()

const ORIGINAL_FETCH = global.fetch

beforeEach(async () => {
  harness.reset()
  vi.clearAllMocks()
  setCodexClientFactory(() => globalState.__codexJudgeClientMock as CodexAppServerClient)
  await requirePrivate()
})

afterEach(() => {
  global.fetch = ORIGINAL_FETCH
  resetCodexClient()
})

describe('codex judge guardrails', () => {
  it('marks runs needs_human when metadata is missing', async () => {
    harness.setRun({ repository: 'unknown/unknown', issueNumber: 0, branch: 'unknown' })

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.store.updateDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'needs_human',
        reasons: expect.objectContaining({ error: 'missing_run_metadata' }),
      }),
    )
  })

  it('skips when not in judge stage', async () => {
    harness.setRun({ stage: 'implementation', notifyPayload: {} })

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.store.updateRunPrompt).toHaveBeenCalled()
    expect(harness.store.updateDecision).not.toHaveBeenCalled()
  })

  it('records needs_iteration when judge output is missing', async () => {
    harness.setRun({ stage: 'judge', notifyPayload: {} })

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.store.updateDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'needs_iteration',
        reasons: expect.objectContaining({ error: 'infra_failure' }),
      }),
    )
  })

  it('records pass when judge output is present', async () => {
    harness.setRun({
      stage: 'judge',
      notifyPayload: {
        judge_output: {
          decision: 'pass',
          confidence: 0.9,
          requirements_coverage: [],
          missing_items: [],
          suggested_fixes: [],
          next_prompt: null,
          prompt_tuning_suggestions: [],
          system_improvement_suggestions: [],
        },
      },
    })

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.store.updateDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'pass',
      }),
    )
  })

  it('marks runs needs_human when rerun submission fails', async () => {
    const timeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn) => {
      fn()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    try {
      const staleTimestamp = new Date(Date.now() - 60_000).toISOString()
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'nope',
        json: async () => ({}),
      }))
      global.fetch = fetchMock as unknown as typeof global.fetch

      harness.store.listRerunSubmissions.mockResolvedValue([
        {
          id: 'rerun-1',
          parentRunId: 'run-1',
          attempt: 2,
          deliveryId: 'jangar-run-1-attempt-2',
          status: 'queued',
          submissionAttempt: 0,
          responseStatus: null,
          error: null,
          createdAt: new Date().toISOString(),
          updatedAt: staleTimestamp,
          submittedAt: null,
        },
      ])
      harness.store.claimRerunSubmission.mockResolvedValue({
        submission: {
          id: 'rerun-1',
          parentRunId: 'run-1',
          attempt: 2,
          deliveryId: 'jangar-run-1-attempt-2',
          status: 'queued',
          submissionAttempt: 0,
          responseStatus: null,
          error: null,
          createdAt: new Date().toISOString(),
          updatedAt: staleTimestamp,
          submittedAt: null,
        },
        shouldSubmit: true,
      })

      globalState.__codexJudgeArgoMock?.submitWorkflowTemplate.mockRejectedValueOnce(new Error('argo down'))

      const privateApi = await requirePrivate()
      await privateApi.processRerunQueue()

      expect(fetchMock).toHaveBeenCalled()
      expect(harness.store.updateRunStatus).toHaveBeenCalledWith('run-1', 'needs_human')
      expect(harness.store.updateRerunSubmission).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('does not re-enter judging for completed runs', async () => {
    harness.setRun({ status: 'completed' })

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.store.updateRunStatus).not.toHaveBeenCalled()
    expect(harness.store.updateDecision).not.toHaveBeenCalled()
  })
})
