import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexEvaluationRecord, CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'

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
  __codexJudgeClientMock?: { runTurn: ReturnType<typeof vi.fn> }
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
    ciPollIntervalMs: 1000,
    reviewPollIntervalMs: 1000,
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
    reviewStatus: null,
    reviewSummary: {},
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
  }

  const store = {
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
    createPromptTuning: vi.fn(async () => ({
      id: 'prompt-1',
      runId: run.id,
      prUrl: 'https://github.com/proompteng/lab/pull/1',
      status: 'open',
      metadata: {},
      createdAt: now,
    })),
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
    getReviewSummary: vi.fn(async () => ({
      status: 'approved' as const,
      unresolvedThreads: [],
      requestedChanges: false,
      issueComments: [],
    })),
    getPullRequestDiff: vi.fn(async () => 'diff --git a/file b/file'),
  }

  const config = {
    githubToken: null,
    githubApiBaseUrl: 'https://api.github.com',
    codexReviewers: [],
    ciPollIntervalMs: 1000,
    reviewPollIntervalMs: 1000,
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
  }

  const memoriesStore = {
    persist: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }

  Object.assign(globalState.__codexJudgeStoreMock!, store)
  Object.assign(globalState.__codexJudgeGithubMock!, github)
  Object.assign(globalState.__codexJudgeConfigMock!, config)
  Object.assign(globalState.__codexJudgeMemoryStoreMock!, memoriesStore)
  globalState.__codexJudgeClientMock = codexClient

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

vi.mock('~/server/codex-judge-store', () => ({
  createCodexJudgeStore: () => globalState.__codexJudgeStoreMock!,
}))

vi.mock('~/server/codex-judge-config', () => ({
  loadCodexJudgeConfig: () => globalState.__codexJudgeConfigMock!,
}))

vi.mock('~/server/github-client', () => ({
  createGitHubClient: () => globalState.__codexJudgeGithubMock!,
}))

vi.mock('~/server/codex-client', () => ({
  getCodexClient: () => Effect.sync(() => globalState.__codexJudgeClientMock!),
}))

vi.mock('~/server/memories-store', () => ({
  createPostgresMemoriesStore: () => globalState.__codexJudgeMemoryStoreMock!,
}))

const ORIGINAL_FETCH = global.fetch

beforeEach(async () => {
  harness.reset()
  vi.clearAllMocks()
  if (!__private) {
    __private = (await import('../codex-judge')).__private
  }
})

afterEach(() => {
  global.fetch = ORIGINAL_FETCH
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

    await __private!.evaluateRun('run-1')

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

    await __private!.evaluateRun('run-1')

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

  it('does not re-enter judging for completed runs', async () => {
    harness.setRun({ status: 'completed' })

    await __private!.evaluateRun('run-1')

    expect(harness.store.updateRunStatus).not.toHaveBeenCalled()
    expect(harness.codexClient.runTurn).not.toHaveBeenCalled()
    expect(harness.github.getPullRequestByHead).not.toHaveBeenCalled()
  })
})
