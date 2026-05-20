import { describe, expect, it, vi } from 'vitest'

import {
  type CodexRunsApiDependencies,
  getCodexIssuesHandler,
  getCodexRecentRunsHandler,
  getCodexRunHistoryHandler,
  getCodexRunsPageHandler,
} from './codex-runs'

type CodexRunsTestStore =
  NonNullable<CodexRunsApiDependencies['storeFactory']> extends () => infer Store ? Store : never

const emptyStats = {
  completionRate: null,
  avgAttemptsPerIssue: null,
  failureReasonCounts: {},
  avgCiDurationSeconds: null,
  avgJudgeConfidence: null,
}

const createStore = (overrides: Record<string, unknown> = {}) =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    getRunHistory: vi.fn(async () => ({ runs: [], stats: emptyStats })),
    listIssueSummaries: vi.fn(async () => []),
    listRecentRuns: vi.fn(async () => []),
    listRunsPage: vi.fn(async () => ({ runs: [], total: 0 })),
    ...overrides,
  }) as CodexRunsTestStore

describe('Codex runs v1 API', () => {
  it('rejects incomplete history requests before opening storage', async () => {
    const storeFactory = vi.fn(() => createStore())

    const response = await getCodexRunHistoryHandler(new Request('http://agents.test/v1/codex/runs'), { storeFactory })

    expect(response.status).toBe(400)
    expect(storeFactory).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'repository is required' })
  })

  it('serves run history from the Agents-owned projection store', async () => {
    const store = createStore({
      getRunHistory: vi.fn(async () => ({
        runs: [{ run: { id: 'run-1' }, artifacts: [], evaluation: null }],
        stats: {},
      })),
    })

    const response = await getCodexRunHistoryHandler(
      new Request('http://agents.test/v1/codex/runs?repository=owner/repo&issueNumber=123&branch=codex/split&limit=5'),
      { storeFactory: () => store },
    )

    expect(store.getRunHistory).toHaveBeenCalledWith({
      repository: 'owner/repo',
      issueNumber: 123,
      branch: 'codex/split',
      limit: 5,
    })
    expect(store.close).toHaveBeenCalled()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runs: [{ run: { id: 'run-1' }, artifacts: [], evaluation: null }],
      stats: {},
    })
  })

  it('serves list, recent, and issue projection APIs', async () => {
    const store = createStore()

    const listResponse = await getCodexRunsPageHandler(
      new Request('http://agents.test/v1/codex/runs/list?repository=owner/repo&page=2&pageSize=25'),
      { storeFactory: () => store },
    )
    const recentResponse = await getCodexRecentRunsHandler(
      new Request('http://agents.test/v1/codex/runs/recent?repository=owner/repo&limit=10'),
      { storeFactory: () => store },
    )
    const issuesResponse = await getCodexIssuesHandler(
      new Request('http://agents.test/v1/codex/issues?repository=owner/repo&limit=50'),
      { storeFactory: () => store },
    )

    expect(store.listRunsPage).toHaveBeenCalledWith({ repository: 'owner/repo', page: 2, pageSize: 25 })
    expect(store.listRecentRuns).toHaveBeenCalledWith({ repository: 'owner/repo', limit: 10 })
    expect(store.listIssueSummaries).toHaveBeenCalledWith('owner/repo', 50)
    expect(listResponse.status).toBe(200)
    expect(recentResponse.status).toBe(200)
    expect(issuesResponse.status).toBe(200)
  })
})
