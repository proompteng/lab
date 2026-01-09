import { describe, expect, it, vi } from 'vitest'

import { getCodexRecentRunsHandler } from '~/routes/api/codex/runs/recent'
import type { CodexRunSummaryRecord } from '../codex-judge-store'

const buildRunSummary = (overrides: Partial<CodexRunSummaryRecord> = {}): CodexRunSummaryRecord => ({
  id: 'run-1',
  repository: 'owner/repo',
  issueNumber: 123,
  branch: 'codex/issue-123',
  attempt: 1,
  workflowName: 'workflow-1',
  workflowNamespace: null,
  stage: 'implementation',
  status: 'run_complete',
  phase: null,
  iteration: null,
  iterationCycle: null,
  decision: null,
  commitSha: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  prMerged: null,
  ciStatus: null,
  reviewStatus: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  ...overrides,
})

describe('codex recent runs route', () => {
  it('returns recent runs from the store', async () => {
    const runs = [buildRunSummary()]
    const store = {
      listRecentRuns: vi.fn(async () => runs),
      close: vi.fn(async () => {}),
      ready: Promise.resolve(),
    }

    const response = await getCodexRecentRunsHandler(new Request('http://localhost/api/codex/runs/recent'), () => store)

    expect(store.listRecentRuns).toHaveBeenCalledWith({ repository: undefined, limit: undefined })
    expect(store.close).toHaveBeenCalled()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, runs })
  })
})
