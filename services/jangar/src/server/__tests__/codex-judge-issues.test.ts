import { describe, expect, it, vi } from 'vitest'

import { getCodexIssuesHandler } from '~/routes/api/codex/issues'
import type { CodexIssueSummaryRecord } from '@proompteng/agent-contracts/codex-runs-client'

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

  it('forwards issue summary requests to the Agents service', async () => {
    const issues = [buildIssue()]
    const client = vi.fn(async () => ({ ok: true as const, status: 200, body: { ok: true, issues } }))

    const response = await getCodexIssuesHandler(
      new Request('http://localhost/api/codex/issues?repository=owner/repo'),
      client,
    )

    expect(client).toHaveBeenCalledWith({ repository: 'owner/repo', limit: undefined })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, issues })
  })
})
