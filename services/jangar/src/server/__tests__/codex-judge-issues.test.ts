import { describe, expect, it, vi } from 'vitest'

import { getCodexIssuesHandler } from '~/routes/api/codex/issues'
import type { CodexIssueSummaryRecord } from '../codex-judge-store'

const buildIssue = (overrides: Partial<CodexIssueSummaryRecord> = {}): CodexIssueSummaryRecord => ({
  issueNumber: 123,
  runCount: 4,
  lastSeenAt: '2025-01-01T00:00:00Z',
  ...overrides,
})

describe('codex issues route', () => {
  it('rejects requests missing repository', async () => {
    const response = await getCodexIssuesHandler(new Request('http://localhost/api/codex/issues'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'repository is required' })
  })

  it('returns issue summaries from the store', async () => {
    const issues = [buildIssue()]
    const store = {
      listIssueSummaries: vi.fn(async () => issues),
      close: vi.fn(async () => {}),
      ready: Promise.resolve(),
    }

    const response = await getCodexIssuesHandler(
      new Request('http://localhost/api/codex/issues?repository=owner/repo'),
      () => store,
    )

    expect(store.listIssueSummaries).toHaveBeenCalledWith('owner/repo', undefined)
    expect(store.close).toHaveBeenCalled()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, issues })
  })
})
