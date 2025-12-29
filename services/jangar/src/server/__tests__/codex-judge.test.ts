import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexEvaluationRecord, CodexJudgeStore, CodexRunRecord } from '../codex-judge-store'

import { storePrivate } from './codex-judge-store-private'

let __private: Awaited<typeof import('../codex-judge')>['__private'] | null = null

const requireMock = <T>(value: T | null | undefined, label: string): T => {
  if (!value) {
    throw new Error(`${label} was not initialized`)
  }
  return value
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
  const now = new Date().toISOString()

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
    getLatestPromptTuningByIssue: vi.fn(async () => null),
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
    getRefSha: vi.fn(async () => 'sha-1'),
    getFile: vi.fn(async () => ({ content: '', sha: 'file-sha' })),
    updateFile: vi.fn(async () => ({})),
    createBranch: vi.fn(async () => ({})),
    createPullRequest: vi.fn(async () => ({ html_url: 'https://github.com/proompteng/lab/pull/101' })),
  }

  const config = requireMock(globalState.__codexJudgeConfigMock, 'codex judge config mock')
  Object.assign(config, {
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
    promptTuningFailureThreshold: 3,
    promptTuningWindowHours: 24,
    promptTuningCooldownHours: 6,
  })

  const memoriesStore = {
    persist: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }

  Object.assign(requireMock(globalState.__codexJudgeStoreMock, 'codex judge store mock'), store)
  Object.assign(requireMock(globalState.__codexJudgeGithubMock, 'codex judge github mock'), github)
  Object.assign(requireMock(globalState.__codexJudgeMemoryStoreMock, 'codex judge memory store mock'), memoriesStore)
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
  __private: storePrivate,
  createCodexJudgeStore: () => requireMock(globalState.__codexJudgeStoreMock, 'codex judge store mock'),
}))

vi.mock('~/server/codex-judge-config', () => ({
  loadCodexJudgeConfig: () => requireMock(globalState.__codexJudgeConfigMock, 'codex judge config mock'),
}))

vi.mock('~/server/github-client', () => ({
  createGitHubClient: () => requireMock(globalState.__codexJudgeGithubMock, 'codex judge github mock'),
}))

vi.mock('~/server/codex-client', () => ({
  getCodexClient: () => Effect.sync(() => requireMock(globalState.__codexJudgeClientMock, 'codex judge client mock')),
}))

vi.mock('~/server/memories-store', () => ({
  createPostgresMemoriesStore: () =>
    requireMock(globalState.__codexJudgeMemoryStoreMock, 'codex judge memory store mock'),
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

    await requireMock(__private, 'codex judge private').evaluateRun('run-1')

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

    await requireMock(__private, 'codex judge private').evaluateRun('run-1')

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

    await requireMock(__private, 'codex judge private').evaluateRun('run-1')

    expect(harness.store.updateRunStatus).not.toHaveBeenCalled()
    expect(harness.codexClient.runTurn).not.toHaveBeenCalled()
    expect(harness.github.getPullRequestByHead).not.toHaveBeenCalled()
  })
})

describe('codex judge ordering', () => {
  it('runs deterministic gates before CI/review checks', async () => {
    harness.github.getPullRequestDiff.mockResolvedValue(`<<<<<<< HEAD
conflict
=======
resolved
>>>>>>> branch`)

    await requireMock(__private, 'codex judge private').evaluateRun('run-1')

    expect(harness.github.getCheckRuns).not.toHaveBeenCalled()
    expect(harness.github.getReviewSummary).not.toHaveBeenCalled()
    expect(harness.store.updateCiStatus).not.toHaveBeenCalled()
    expect(harness.store.updateReviewStatus).not.toHaveBeenCalled()
    expect(harness.store.updateDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: 'needs_human' }))
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

    await requireMock(__private, 'codex judge private').evaluateRun('run-1')

    expect(harness.github.createBranch).not.toHaveBeenCalled()
    expect(harness.github.updateFile).not.toHaveBeenCalled()
    expect(harness.github.createPullRequest).not.toHaveBeenCalled()
  })

  it('creates prompt tuning PRs when actionable suggestions are present', async () => {
    harness.config.promptTuningEnabled = true
    harness.config.promptTuningRepo = 'proompteng/lab'
    harness.config.promptTuningFailureThreshold = 1
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

    await requireMock(__private, 'codex judge private').evaluateRun('run-1')

    expect(harness.github.createBranch).toHaveBeenCalledTimes(1)
    expect(harness.github.updateFile).toHaveBeenCalled()
    expect(harness.github.createPullRequest).toHaveBeenCalledTimes(1)
  })
})
