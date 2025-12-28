import { describe, expect, it, vi } from 'vitest'

import { getCodexRunsHandler } from '~/routes/api/codex/runs'
import type { CodexJudgeStore, CodexRunHistoryRecord, CodexRunStats } from '../codex-judge-store'

const buildRun = (overrides: Partial<CodexRunHistoryRecord> = {}): CodexRunHistoryRecord => ({
  id: 'run-1',
  repository: 'proompteng/lab',
  issueNumber: 2137,
  branch: 'codex/issue-2137',
  attempt: 1,
  workflowName: 'workflow-1',
  workflowUid: null,
  workflowNamespace: null,
  stage: 'implementation',
  status: 'completed',
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
  artifacts: [],
  latestEvaluation: null,
  ...overrides,
})

const buildStore = (overrides: Partial<CodexJudgeStore> = {}): CodexJudgeStore => {
  const store = {
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
    ...overrides,
  } satisfies CodexJudgeStore

  return store
}

describe('codex runs API', () => {
  it('returns 400 when repository is missing', async () => {
    const request = new Request('http://localhost/api/codex/runs?issueNumber=2137')
    const response = await getCodexRunsHandler(request, buildStore())

    expect(response.status).toBe(400)
    const json = await response.json()
    expect(json.error).toContain('Repository')
  })

  it('returns run history and stats', async () => {
    const runs = [
      buildRun({
        id: 'run-2',
        artifacts: [
          {
            id: 'artifact-1',
            runId: 'run-2',
            name: 'implementation-changes',
            key: 'artifact-key',
            bucket: 'codex',
            url: 'https://example.com/artifact',
            metadata: {},
            createdAt: '2025-01-01T00:00:00Z',
          },
        ],
        latestEvaluation: {
          id: 'eval-1',
          runId: 'run-2',
          decision: 'pass',
          confidence: 0.8,
          reasons: {},
          missingItems: {},
          suggestedFixes: {},
          nextPrompt: null,
          promptTuning: {},
          systemSuggestions: {},
          createdAt: '2025-01-01T00:00:00Z',
        },
      }),
    ]

    const stats: CodexRunStats = {
      completionRate: 1,
      avgAttemptsPerIssue: 1,
      failureReasonCounts: {},
      avgCiDuration: 0,
      avgJudgeConfidence: 0.8,
    }

    const store = buildStore({
      listRunHistory: vi.fn().mockResolvedValue(runs),
      getRunStats: vi.fn().mockResolvedValue(stats),
    })

    const request = new Request('http://localhost/api/codex/runs?repository=proompteng/lab&issueNumber=2137&limit=5')
    const response = await getCodexRunsHandler(request, store)

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.ok).toBe(true)
    expect(json.runs).toHaveLength(1)
    expect(json.stats.completion_rate).toBe(1)
    expect(store.listRunHistory).toHaveBeenCalledWith({
      repository: 'proompteng/lab',
      issueNumber: 2137,
      branch: undefined,
      limit: 5,
    })
  })
})
