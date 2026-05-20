import { describe, expect, it } from 'vitest'

import { buildRunSummaries, normalizeAgentMessage, type AgentMessage } from '../agent-comms'

describe('agent comms AgentRun identity', () => {
  it('normalizes AgentRun-native message identity from the Agents events stream', () => {
    const message = normalizeAgentMessage({
      agent_run_uid: 'agent-run-uid-1',
      agent_run_name: 'agent-run-1',
      agent_run_namespace: 'agents',
      run_id: 'run-1',
      step_id: 'step-1',
      agent_id: 'codex',
      role: 'assistant',
      kind: 'message',
      timestamp: '2026-05-20T20:00:00.000Z',
      channel: 'general',
      stage: 'implement',
      content: 'ready',
    })

    expect(message).toMatchObject({
      agentRunUid: 'agent-run-uid-1',
      agentRunName: 'agent-run-1',
      agentRunNamespace: 'agents',
      runId: 'run-1',
      stepId: 'step-1',
      stage: 'implement',
    })
  })

  it('does not revive workflow-shaped identity fields as AgentRun identity', () => {
    const message = normalizeAgentMessage({
      workflow_uid: 'legacy-workflow-uid',
      workflow_name: 'legacy-workflow',
      workflow_namespace: 'legacy',
      workflow_step: 'legacy-step',
      workflow_stage: 'legacy-stage',
      content: 'legacy payload',
    })

    expect(message).toMatchObject({
      agentRunUid: null,
      agentRunName: null,
      agentRunNamespace: null,
      stepId: null,
      stage: null,
    })
  })

  it('summarizes AgentRuns without falling back to workflow summary buckets', () => {
    const baseMessage: AgentMessage = {
      id: 'message-1',
      agentRunUid: 'agent-run-uid-1',
      agentRunName: 'agent-run-1',
      agentRunNamespace: 'agents',
      runId: null,
      stepId: null,
      agentId: 'codex',
      role: 'assistant',
      kind: 'message',
      timestamp: '2026-05-20T20:00:00.000Z',
      channel: 'general',
      stage: 'implement',
      content: 'ready',
      tool: null,
      attrs: {},
    }

    const summaries = buildRunSummaries([baseMessage])

    expect(summaries.runs).toEqual([])
    expect(summaries.agentRuns).toMatchObject([
      {
        agentRunUid: 'agent-run-uid-1',
        agentRunName: 'agent-run-1',
        agentRunNamespace: 'agents',
        count: 1,
      },
    ])
    expect(JSON.stringify(summaries)).not.toContain('workflow')
  })
})
