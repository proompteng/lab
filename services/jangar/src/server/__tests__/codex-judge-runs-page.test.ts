import { describe, expect, it, vi } from 'vitest'

import { getCodexRunsPageHandler } from '~/routes/api/codex/runs/list'
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
  ciStatus: null,
  reviewStatus: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  ...overrides,
})

describe('codex runs list route', () => {
  it('returns paginated runs from the store', async () => {
    const runs = [buildRunSummary()]
    const store = {
      listRunsPage: vi.fn(async () => ({ runs, total: 42 })),
      close: vi.fn(async () => {}),
      ready: Promise.resolve(),
    }

    const response = await getCodexRunsPageHandler(
      new Request('http://localhost/api/codex/runs/list?page=2&pageSize=25&repository=owner/repo'),
      () => store,
    )

    expect(store.listRunsPage).toHaveBeenCalledWith({ repository: 'owner/repo', page: 2, pageSize: 25 })
    expect(store.close).toHaveBeenCalled()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, runs, total: 42 })
  })
})
