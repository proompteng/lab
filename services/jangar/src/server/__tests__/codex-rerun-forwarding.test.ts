import { describe, expect, it, vi } from 'vitest'

import type { CodexRunRecord } from '../codex-judge-store'
import { resolveAgentRunRerunForwardingPayload } from '../codex-rerun-forwarding'

const run: CodexRunRecord = {
  id: 'judge-run-1',
  repository: 'proompteng/lab',
  issueNumber: 123,
  branch: 'codex/example',
  attempt: 1,
  agentRunName: 'codex-example-agent-run',
  agentRunUid: 'uid-1',
  agentRunNamespace: 'agents',
  turnId: null,
  threadId: null,
  stage: null,
  status: 'needs_iteration',
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
  createdAt: '2026-05-20T00:00:00.000Z',
  updatedAt: '2026-05-20T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
}

describe('resolveAgentRunRerunForwardingPayload', () => {
  it('forwards explicit AgentRun identity without Jangar run lookup', async () => {
    const lookup = vi.fn()
    const resolved = await resolveAgentRunRerunForwardingPayload(
      { agentRunName: 'explicit-run', attempt: 2, prompt: 'again' },
      lookup,
    )

    expect(lookup).not.toHaveBeenCalled()
    expect(resolved.agentRunId).toBe('explicit-run')
    expect(resolved.deliveryId).toBe('explicit-run:2')
    expect(resolved.payload).toMatchObject({
      runId: 'explicit-run',
      agentRunName: 'explicit-run',
      deliveryId: 'explicit-run:2',
      legacyCodexJudgeRunId: null,
    })
  })

  it('translates legacy Codex judge run_id into AgentRun identity', async () => {
    const lookup = vi.fn(async () => run)
    const resolved = await resolveAgentRunRerunForwardingPayload(
      { run_id: 'judge-run-1', attempt: 3, prompt: 'fix it' },
      lookup,
    )

    expect(lookup).toHaveBeenCalledWith('judge-run-1')
    expect(resolved.agentRunId).toBe('codex-example-agent-run')
    expect(resolved.deliveryId).toBe('codex-example-agent-run:3')
    expect(resolved.payload).toMatchObject({
      runId: 'codex-example-agent-run',
      agentRunName: 'codex-example-agent-run',
      agentRunNamespace: 'agents',
      agentRunUid: 'uid-1',
      legacyCodexJudgeRunId: 'judge-run-1',
    })
  })

  it('rejects rerun payloads without AgentRun identity or known Jangar run', async () => {
    await expect(
      resolveAgentRunRerunForwardingPayload(
        { prompt: 'again' },
        vi.fn(async () => null),
      ),
    ).rejects.toThrow('rerun payload missing AgentRun identity')
  })
})
