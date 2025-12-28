import { describe, expect, it } from 'vitest'

import type { CodexRunRecord } from '../codex-judge-store'
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
