import { afterEach, describe, expect, it, vi } from 'vitest'

import { configureAgentsV1Runtime, resetAgentsV1RuntimeForTests } from '../../../server/v1/runtime'
import type { CodexRunsApiDependencies } from '../../../server/v1/codex-runs'

import { getCodexRunHistoryHandler } from './runs'

type CodexRunsTestStore =
  NonNullable<CodexRunsApiDependencies['storeFactory']> extends () => infer Store ? Store : never

const emptyStats = {
  completionRate: null,
  avgAttemptsPerIssue: null,
  failureReasonCounts: {},
  avgCiDurationSeconds: null,
  avgJudgeConfidence: null,
}

const createStore = () =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    getRunById: vi.fn(async () => null),
    getRunHistory: vi.fn(async () => ({
      runs: [{ run: { id: 'run-1' }, artifacts: [], evaluation: null }],
      stats: emptyStats,
    })),
    listIssueSummaries: vi.fn(async () => []),
    listRecentRuns: vi.fn(async () => []),
    listRunsByPrNumber: vi.fn(async () => []),
    listRunsPage: vi.fn(async () => ({ runs: [], total: 0 })),
  }) as unknown as CodexRunsTestStore

describe('Codex run projection route runtime', () => {
  afterEach(() => {
    resetAgentsV1RuntimeForTests()
  })

  it('uses configured Agents runtime dependencies for Codex run history', async () => {
    const store = createStore()
    configureAgentsV1Runtime({
      codexRuns: {
        storeFactory: () => store,
      },
    })

    const response = await getCodexRunHistoryHandler(
      new Request('http://agents.local/v1/codex/runs?repository=owner/repo&issueNumber=123'),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      runs: [{ run: { id: 'run-1' }, artifacts: [], evaluation: null }],
    })
    expect(store.getRunHistory).toHaveBeenCalledWith({
      repository: 'owner/repo',
      issueNumber: 123,
      branch: undefined,
      limit: undefined,
    })
  })

  it('lets tests override configured Codex route dependencies', async () => {
    const configuredStore = createStore()
    const overrideStore = createStore()
    configureAgentsV1Runtime({
      codexRuns: {
        storeFactory: () => configuredStore,
      },
    })

    const response = await getCodexRunHistoryHandler(
      new Request('http://agents.local/v1/codex/runs?repository=owner/repo&issueNumber=123'),
      { storeFactory: () => overrideStore },
    )

    expect(response.status).toBe(200)
    expect(configuredStore.getRunHistory).not.toHaveBeenCalled()
    expect(overrideStore.getRunHistory).toHaveBeenCalled()
  })
})
