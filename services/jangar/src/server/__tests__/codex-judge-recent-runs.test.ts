import { describe, expect, it, vi } from 'vitest'

import { getCodexRecentRunsHandler } from '~/routes/api/codex/runs/recent'
import type { CodexRunSummaryRecord } from '@proompteng/agent-contracts/codex-runs-client'

const buildRunSummary = (overrides: Partial<CodexRunSummaryRecord> = {}): CodexRunSummaryRecord => ({
  id: 'run-1',
  repository: 'owner/repo',
  issueNumber: 123,
  branch: 'codex/issue-123',
  attempt: 1,
  agentRunName: 'agentrun-1',
  agentRunNamespace: null,
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
  it('forwards recent run requests to the Agents service', async () => {
    const runs = [buildRunSummary()]
    const client = vi.fn(async () => ({ ok: true as const, status: 200, body: { ok: true, runs } }))

    const response = await getCodexRecentRunsHandler(new Request('http://localhost/api/codex/runs/recent'), client)

    expect(client).toHaveBeenCalledWith({ repository: undefined, limit: undefined })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, runs })
  })
})
