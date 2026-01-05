import { describe, expect, it } from 'vitest'

import type { CodexEvaluationRecord, CodexRunRecord } from '../codex-judge-store'
import { __private } from '../codex-judge-store'

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
  iteration: null,
  iterationCycle: null,
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

describe('codex judge run supersession', () => {
  it('supersedes older active runs when a newer run arrives', () => {
    const older = buildRun({
      id: 'run-older',
      attempt: 1,
      status: 'run_complete',
      finishedAt: '2025-01-01T00:00:00Z',
      createdAt: '2025-01-01T00:00:00Z',
    })
    const newer = buildRun({
      id: 'run-newer',
      attempt: 2,
      status: 'run_complete',
      finishedAt: '2025-01-02T00:00:00Z',
      createdAt: '2025-01-02T00:00:00Z',
    })

    const plan = __private.planSupersession([older, newer])

    expect(plan.activeRun?.id).toBe('run-newer')
    expect(plan.supersededIds).toContain('run-older')
  })

  it('does not supersede completed runs', () => {
    const completed = buildRun({
      id: 'run-completed',
      status: 'completed',
      finishedAt: '2025-01-01T00:00:00Z',
      createdAt: '2025-01-01T00:00:00Z',
    })
    const active = buildRun({
      id: 'run-active',
      status: 'run_complete',
      finishedAt: '2025-01-02T00:00:00Z',
      createdAt: '2025-01-02T00:00:00Z',
    })

    const plan = __private.planSupersession([completed, active])

    expect(plan.activeRun?.id).toBe('run-active')
    expect(plan.supersededIds).not.toContain('run-completed')
  })
})

describe('codex judge run stats', () => {
  it('computes summary metrics from runs and evaluations', () => {
    const runs: CodexRunRecord[] = [
      buildRun({
        id: 'run-1',
        issueNumber: 123,
        attempt: 1,
        status: 'completed',
        startedAt: '2025-01-01T00:00:00Z',
        finishedAt: '2025-01-01T00:01:00Z',
      }),
      buildRun({
        id: 'run-2',
        issueNumber: 123,
        attempt: 2,
        status: 'needs_iteration',
        startedAt: '2025-01-01T01:00:00Z',
        finishedAt: '2025-01-01T01:03:00Z',
      }),
      buildRun({
        id: 'run-3',
        issueNumber: 456,
        attempt: 1,
        status: 'completed',
        startedAt: '2025-01-02T00:00:00Z',
        finishedAt: '2025-01-02T00:02:00Z',
      }),
    ]

    const evaluations = new Map<string, CodexEvaluationRecord | null>([
      [
        'run-1',
        {
          id: 'eval-1',
          runId: 'run-1',
          decision: 'pass',
          confidence: 0.92,
          reasons: {},
          missingItems: {},
          suggestedFixes: {},
          nextPrompt: null,
          promptTuning: {},
          systemSuggestions: {},
          createdAt: '2025-01-01T00:02:00Z',
        },
      ],
      [
        'run-2',
        {
          id: 'eval-2',
          runId: 'run-2',
          decision: 'needs_iteration',
          confidence: 0.4,
          reasons: { error: 'ci_failed' },
          missingItems: {},
          suggestedFixes: {},
          nextPrompt: 'fix',
          promptTuning: {},
          systemSuggestions: {},
          createdAt: '2025-01-01T01:04:00Z',
        },
      ],
      [
        'run-3',
        {
          id: 'eval-3',
          runId: 'run-3',
          decision: 'pass',
          confidence: null,
          reasons: {},
          missingItems: {},
          suggestedFixes: {},
          nextPrompt: null,
          promptTuning: {},
          systemSuggestions: {},
          createdAt: '2025-01-02T00:03:00Z',
        },
      ],
    ])

    const stats = __private.computeRunStats(runs, evaluations)

    expect(stats.completionRate).toBeCloseTo(2 / 3)
    expect(stats.avgAttemptsPerIssue).toBeCloseTo(1.5)
    expect(stats.failureReasonCounts).toEqual({ ci_failed: 1 })
    expect(stats.avgCiDurationSeconds).toBeCloseTo((60 + 180 + 120) / 3)
    expect(stats.avgJudgeConfidence).toBeCloseTo((0.92 + 0.4) / 2)
  })
})
