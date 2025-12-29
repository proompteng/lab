import type { CodexAppServerClient } from '@proompteng/codex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetCodexClient, setCodexClientFactory } from '~/server/codex-client'
import { GitHubRateLimitError, type ReviewSummary } from '~/server/github-client'
import type { CodexEvaluationRecord, CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'

let __private: Awaited<typeof import('../codex-judge')>['__private'] | null = null

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
    reviewBypassMode: 'strict' | 'timeout' | 'always'
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
  __codexJudgeClientMock?: CodexAppServerClient
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
    getRunHistory: vi.fn(),
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
    reviewBypassMode: 'strict',
    ciMaxWaitMs: 10_000,
    reviewMaxWaitMs: 10_000,
    maxAttempts: 3,
    backoffScheduleMs: [0],
    facteurBaseUrl: 'http://facteur.test',
    argoServerUrl: null,
    discordBotToken: null,
    discordChannelId: null,
    discordApiBaseUrl: 'https://discord.com/api/v10',
    judgeModel: 'test-model',
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
    stage: 'implementation',
    status: 'run_complete',
    phase: 'Succeeded',
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
    listRunsByStatus: vi.fn(async () => [run]),
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

  const config = requireMock(globalState.__codexJudgeConfigMock, 'config')
  Object.assign(config, {
    githubToken: null,
    githubApiBaseUrl: 'https://api.github.com',
    codexReviewers: [],
    reviewBypassMode: 'strict',
    ciMaxWaitMs: 10_000,
    reviewMaxWaitMs: 10_000,
    maxAttempts: 3,
    backoffScheduleMs: [0],
    facteurBaseUrl: 'http://facteur.test',
    argoServerUrl: null,
    discordBotToken: null,
    discordChannelId: null,
    discordApiBaseUrl: 'https://discord.com/api/v10',
    judgeModel: 'test-model',
    promptTuningEnabled: false,
    promptTuningRepo: null,
    promptTuningFailureThreshold: 3,
    promptTuningWindowHours: 24,
    promptTuningCooldownHours: 6,
  })

  const memoriesStore = {
    persist: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }

  const storeMock = requireMock(globalState.__codexJudgeStoreMock, 'store')
  const githubMock = requireMock(globalState.__codexJudgeGithubMock, 'github')
  const memoryStoreMock = requireMock(globalState.__codexJudgeMemoryStoreMock, 'memory store')

  Object.assign(storeMock, store)
  Object.assign(githubMock, github)
  Object.assign(memoryStoreMock, memoriesStore)
  globalState.__codexJudgeClientMock = codexClient as unknown as CodexAppServerClient

  const setJudgeResponses = (responses: string[]) => {
    judgeResponses.splice(0, judgeResponses.length, ...responses)
  }

  return {
    codexClient,
    store,
    github,
    config,
    memoriesStore,
    reset,
    setRun,
    setJudgeResponses,
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
  it('retries invalid JSON and succeeds without rerun', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    }))
    global.fetch = fetchMock as unknown as typeof global.fetch

    harness.setJudgeResponses([
      'not json',
      JSON.stringify({
        decision: 'pass',
        confidence: 0.9,
        requirements_coverage: [],
        missing_items: [],
        suggested_fixes: [],
        next_prompt: null,
        prompt_tuning_suggestions: [],
        system_improvement_suggestions: [],
      }),
    ])

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.codexClient.runTurn).toHaveBeenCalledTimes(2)
    expect(harness.judgePrompts[1]).toContain('JSON object only')
    expect(harness.store.listRunsByIssue).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(harness.store.updateDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: 'pass' }))
  })

  it('retries invalid JSON then triggers rerun', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    }))
    global.fetch = fetchMock as unknown as typeof global.fetch

    harness.setJudgeResponses(['nope', 'still nope', 'no json here'])

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.codexClient.runTurn).toHaveBeenCalledTimes(3)
    expect(harness.store.updateDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'needs_iteration',
        reasons: expect.objectContaining({ error: 'judge_invalid_json' }),
      }),
    )
    expect(harness.store.listRunsByIssue).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('http://facteur.test/codex/tasks', expect.any(Object))
  })

  it('marks runs needs_human when rerun submission fails', async () => {
    const timeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn) => {
      fn()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    try {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'nope',
        json: async () => ({}),
      }))
      global.fetch = fetchMock as unknown as typeof global.fetch

      harness.setJudgeResponses(['nope', 'still nope', 'no json here'])

      const privateApi = await requirePrivate()
      await privateApi.evaluateRun('run-1')

      expect(fetchMock).toHaveBeenCalledTimes(4)
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
    expect(harness.codexClient.runTurn).not.toHaveBeenCalled()
    expect(harness.github.getPullRequestByHead).not.toHaveBeenCalled()
  })

  it('backs off when GitHub rate limits are hit', async () => {
    const timeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((_fn, _delay) => {
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    try {
      const retryAt = Date.now() + 90_000
      harness.github.getPullRequestByHead.mockRejectedValueOnce(
        new GitHubRateLimitError('GitHub API 403: rate limit exceeded', {
          status: 403,
          retryAt,
          remaining: 0,
          resetAt: retryAt,
        }),
      )

      const privateApi = await requirePrivate()
      await privateApi.evaluateRun('run-1')

      expect(timeoutSpy).toHaveBeenCalled()
      const delay = timeoutSpy.mock.calls[0]?.[1] as number
      expect(delay).toBeGreaterThanOrEqual(5000)
      expect(harness.codexClient.runTurn).not.toHaveBeenCalled()
      expect(harness.store.updateDecision).not.toHaveBeenCalled()
    } finally {
      timeoutSpy.mockRestore()
    }
  })
})

describe('codex judge ordering', () => {
  it('runs deterministic gates before CI/review checks', async () => {
    harness.github.getPullRequestDiff.mockResolvedValue(`<<<<<<< HEAD
conflict
=======
resolved
>>>>>>> branch`)

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.github.getCheckRuns).not.toHaveBeenCalled()
    expect(harness.github.getReviewSummary).not.toHaveBeenCalled()
    expect(harness.store.updateCiStatus).not.toHaveBeenCalled()
    expect(harness.store.updateReviewStatus).not.toHaveBeenCalled()
    expect(harness.store.updateDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: 'needs_human' }))
  })
})

describe('codex judge CI gating', () => {
  it('retries when commit SHA cannot be resolved', async () => {
    const prPayload = {
      number: 101,
      url: 'https://api.github.com/repos/proompteng/lab/pulls/101',
      htmlUrl: 'https://github.com/proompteng/lab/pull/101',
      headSha: null as unknown as string,
      headRef: 'codex/issue-2125',
      baseRef: 'main',
      state: 'open',
      title: 'PR title',
      body: null,
      mergeableState: 'clean',
    }

    harness.github.getPullRequestByHead.mockResolvedValueOnce(prPayload)
    harness.github.getPullRequest.mockResolvedValueOnce(prPayload)
    harness.github.getPullRequestDiff.mockResolvedValueOnce('diff --git a/file b/file')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    }))
    global.fetch = fetchMock as unknown as typeof global.fetch

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.github.getCheckRuns).not.toHaveBeenCalled()
    expect(harness.store.updateCiStatus).not.toHaveBeenCalled()
    expect(harness.store.updateDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'needs_iteration',
        reasons: expect.objectContaining({ error: 'missing_commit_sha' }),
      }),
    )
    expect(harness.store.updateRunStatus).toHaveBeenCalledWith('run-1', 'needs_iteration')
  })
})

describe('codex judge review gate', () => {
  const defaultClaimRerunSubmission = harness.store.claimRerunSubmission.getMockImplementation()

  beforeEach(() => {
    harness.github.getPullRequestByHead.mockResolvedValue({
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
    })
    harness.github.getPullRequest.mockResolvedValue({
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
    })
    harness.github.getPullRequestDiff.mockResolvedValue('diff --git a/file b/file')
    harness.github.getCheckRuns.mockResolvedValue({ status: 'success', url: 'https://ci.example.com' })
    harness.store.claimRerunSubmission.mockResolvedValue({
      submission: {
        id: 'rerun-review-gate',
        parentRunId: 'run-1',
        attempt: 2,
        deliveryId: 'jangar-run-1-attempt-2',
        status: 'queued',
        submissionAttempt: 0,
        responseStatus: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        submittedAt: null,
      },
      shouldSubmit: false,
    })
  })

  afterEach(() => {
    if (defaultClaimRerunSubmission) {
      harness.store.claimRerunSubmission.mockImplementation(defaultClaimRerunSubmission)
    }
  })

  it('waits for review completion when bypass is disabled', async () => {
    harness.github.getReviewSummary.mockResolvedValue({
      status: 'pending',
      unresolvedThreads: [],
      requestedChanges: false,
      reviewComments: [],
      issueComments: [],
    })

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.codexClient.runTurn).not.toHaveBeenCalled()
    expect(harness.store.updateDecision).not.toHaveBeenCalled()
  })

  it('reruns with thread summaries when unresolved threads exist', async () => {
    const commentBody = 'Please add a regression test for the null guard.'
    harness.github.getReviewSummary.mockResolvedValue({
      status: 'commented',
      unresolvedThreads: [
        {
          id: 'thread-1',
          author: 'codex',
          comments: [
            {
              author: 'codex',
              body: commentBody,
              path: 'services/jangar/src/server/codex-judge.ts',
              line: 120,
            },
          ],
        },
      ],
      requestedChanges: false,
      reviewComments: [],
      issueComments: [],
    })

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    const decisionInput = harness.store.updateDecision.mock.calls
      .map((call) => call[0])
      .find((call) => call?.decision === 'needs_iteration')
    expect(decisionInput).toEqual(expect.objectContaining({ decision: 'needs_iteration' }))
    expect(decisionInput?.nextPrompt).toContain(commentBody)
    expect(decisionInput?.nextPrompt).toContain('Open Codex review threads:')
  })

  it('includes review summary comments when changes are requested', async () => {
    const reviewBody = 'Add a unit test for the review gating timeout.'
    harness.github.getReviewSummary.mockResolvedValue({
      status: 'changes_requested',
      unresolvedThreads: [],
      requestedChanges: true,
      reviewComments: [
        {
          author: 'codex',
          body: reviewBody,
          state: 'changes_requested',
          submittedAt: '2025-12-28T00:00:00Z',
          url: 'https://github.com/proompteng/lab/pull/101#review',
        },
      ],
      issueComments: [],
    })

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    const decisionInput = harness.store.updateDecision.mock.calls
      .map((call) => call[0])
      .find((call) => call?.decision === 'needs_iteration')
    expect(decisionInput?.nextPrompt).toContain(reviewBody)
    expect(decisionInput?.nextPrompt).toContain('Codex review summary comments:')
  })

  it('bypasses review only when explicitly configured', async () => {
    harness.config.reviewBypassMode = 'always'
    try {
      harness.github.getReviewSummary.mockResolvedValue({
        status: 'pending',
        unresolvedThreads: [],
        requestedChanges: false,
        reviewComments: [],
        issueComments: [],
      })
      harness.setJudgeResponses([
        JSON.stringify({
          decision: 'pass',
          confidence: 0.9,
          requirements_coverage: [],
          missing_items: [],
          suggested_fixes: [],
          next_prompt: null,
          prompt_tuning_suggestions: [],
          system_improvement_suggestions: [],
        }),
      ])

      const privateApi = await requirePrivate()
      await privateApi.evaluateRun('run-1')

      expect(harness.codexClient.runTurn).toHaveBeenCalled()
      expect(harness.store.updateDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: 'pass' }))
    } finally {
      harness.config.reviewBypassMode = 'strict'
    }
  })
})

describe('prompt tuning PR gating', () => {
  beforeEach(() => {
    harness.github.getPullRequestByHead.mockResolvedValue({
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
    })
    harness.github.getPullRequest.mockResolvedValue({
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
    })
    harness.github.getPullRequestDiff.mockResolvedValue('diff --git a/file b/file')
    harness.github.getCheckRuns.mockResolvedValue({ status: 'success', url: 'https://ci.example.com' })
    harness.github.getReviewSummary.mockResolvedValue({
      status: 'approved',
      unresolvedThreads: [],
      requestedChanges: false,
      reviewComments: [],
      issueComments: [],
    })
  })

  afterEach(() => {
    harness.config.promptTuningEnabled = false
    harness.config.promptTuningRepo = null
    harness.config.promptTuningFailureThreshold = 3
    harness.config.promptTuningWindowHours = 24
    harness.config.promptTuningCooldownHours = 6
  })

  it('skips prompt tuning PRs when only generic suggestions are present', async () => {
    harness.config.promptTuningEnabled = true
    harness.config.promptTuningRepo = 'proompteng/lab'
    harness.config.promptTuningFailureThreshold = 1
    harness.config.promptTuningWindowHours = 0
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    }))
    global.fetch = fetchMock as unknown as typeof global.fetch

    harness.setJudgeResponses([
      JSON.stringify({
        decision: 'fail',
        confidence: 0.2,
        requirements_coverage: [],
        missing_items: [],
        suggested_fixes: [],
        next_prompt: 'Open a PR for the current branch and ensure all required checks run.',
        prompt_tuning_suggestions: ['Tighten prompt to reduce iteration loops.'],
        system_improvement_suggestions: ['Clarify judge gating criteria.'],
      }),
    ])

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.github.createBranch).not.toHaveBeenCalled()
    expect(harness.github.updateFile).not.toHaveBeenCalled()
    expect(harness.github.createPullRequest).not.toHaveBeenCalled()
  })

  it('creates prompt tuning PRs when actionable suggestions are present', async () => {
    harness.config.promptTuningEnabled = true
    harness.config.promptTuningRepo = 'proompteng/lab'
    harness.config.promptTuningFailureThreshold = 1
    harness.config.promptTuningWindowHours = 0
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    }))
    global.fetch = fetchMock as unknown as typeof global.fetch

    harness.github.getRefSha.mockResolvedValue('base-sha')
    harness.github.createBranch.mockResolvedValue({})
    harness.github.getFile.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === 'apps/froussard/src/codex.ts') {
        return { content: "    'Memory:',\n", sha: 'prompt-sha' }
      }
      return {
        content:
          '## Summary\n\n## Related Issues\n\n## Testing\n\n## Screenshots (if applicable)\n\n## Breaking Changes\n',
        sha: 'template-sha',
      }
    })
    harness.github.updateFile.mockResolvedValue({})
    harness.github.createPullRequest.mockResolvedValue({ html_url: 'https://github.com/proompteng/lab/pull/1' })

    harness.setJudgeResponses([
      JSON.stringify({
        decision: 'fail',
        confidence: 0.4,
        requirements_coverage: [],
        missing_items: [],
        suggested_fixes: [],
        next_prompt: 'Add a regression test for the failing path and rerun CI.',
        prompt_tuning_suggestions: ['Add a checklist for required tests before opening PRs.'],
        system_improvement_suggestions: [],
      }),
    ])

    const privateApi = await requirePrivate()
    await privateApi.evaluateRun('run-1')

    expect(harness.github.createBranch).toHaveBeenCalledTimes(1)
    expect(harness.github.updateFile).toHaveBeenCalled()
    expect(harness.github.createPullRequest).toHaveBeenCalledTimes(1)
  })
})
