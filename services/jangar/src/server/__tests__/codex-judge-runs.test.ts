import { describe, expect, it, vi } from 'vitest'

import { getCodexRunsHandler } from '~/routes/api/codex/runs'
import type {
  CodexRunHistoryEntry,
  CodexRunHistoryResult,
  CodexRunRecord,
} from '@proompteng/agent-contracts/codex-runs-client'

const buildRun = (overrides: Partial<CodexRunRecord> = {}): CodexRunRecord => ({
  id: 'run-1',
  repository: 'owner/repo',
  issueNumber: 123,
  branch: 'codex/issue-123',
  attempt: 1,
  agentRunName: 'agentrun-1',
  agentRunUid: null,
  agentRunNamespace: null,
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

const buildHistory = (entries: CodexRunHistoryEntry[] = []): CodexRunHistoryResult => ({
  ok: true,
  runs: entries,
  stats: {
    completionRate: null,
    avgAttemptsPerIssue: null,
    failureReasonCounts: {},
    avgCiDurationSeconds: null,
    avgJudgeConfidence: null,
  },
})

describe('codex runs route', () => {
  it('rejects requests missing required query params', async () => {
    const response = await getCodexRunsHandler(new Request('http://localhost/api/codex/runs'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'repository is required' })
  })

  it('forwards run history requests to the Agents service', async () => {
    const history = buildHistory([
      {
        run: buildRun(),
        artifacts: [],
        evaluation: null,
      },
    ])

    const client = vi.fn(async () => ({ ok: true as const, status: 200, body: history }))

    const response = await getCodexRunsHandler(
      new Request('http://localhost/api/codex/runs?repository=owner/repo&issueNumber=123'),
      client,
    )

    expect(client).toHaveBeenCalledWith({
      repository: 'owner/repo',
      issueNumber: 123,
      branch: undefined,
      limit: undefined,
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(history)
  })
})
