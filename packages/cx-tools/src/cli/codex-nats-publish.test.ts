import { describe, expect, it } from 'vitest'

import { __test__ } from './codex-nats-publish'

describe('codex-nats-publish', () => {
  it('emits AgentRun-native identity without workflow-shaped compatibility fields', () => {
    const payload = __test__.buildPayload(
      {
        kind: 'status',
        channel: 'run',
        publishGeneral: false,
        status: 'running',
        exitCode: '0',
      },
      'started',
      {
        agentRunNamespace: 'agents',
        agentRunName: 'demo-run',
        agentRunUid: 'demo-uid',
        agentRunStage: 'implement',
        agentRunStep: 'pod-1',
        agentId: 'codex',
        agentRole: 'assistant',
        runId: 'run-1',
        repository: 'proompteng/lab',
        issueNumber: 123,
        branch: 'codex/demo',
      },
      'run',
      'message-1',
      '2026-05-20T05:15:00.000Z',
    )

    expect(payload).toMatchObject({
      agent_run_uid: 'demo-uid',
      agent_run_name: 'demo-run',
      agent_run_namespace: 'agents',
      agentRunUid: 'demo-uid',
      agentRunName: 'demo-run',
      agentRunNamespace: 'agents',
      agent_run_stage: 'implement',
      agent_run_step: 'pod-1',
      agentRunStage: 'implement',
      agentRunStep: 'pod-1',
    })
    expect(JSON.stringify(payload)).not.toMatch(/workflow[_A-Z]/i)
  })

  it('normalizes legacy or domain-specific NATS subject prefixes to agentrun', () => {
    expect(__test__.normalizeNatsSubjectPrefix(undefined)).toBe('agentrun')
    expect(__test__.normalizeNatsSubjectPrefix('agentrun')).toBe('agentrun')
    expect(__test__.normalizeNatsSubjectPrefix('.agentrun.')).toBe('agentrun')
    expect(__test__.normalizeNatsSubjectPrefix('agents.agentrun')).toBe('agentrun')
    expect(__test__.normalizeNatsSubjectPrefix('agents.agent_messages')).toBe('agentrun')
    expect(__test__.normalizeNatsSubjectPrefix('workflow')).toBe('agentrun')
  })

  it('resolves run correlation from Agents and generic env names only', () => {
    expect(__test__.resolveRunId({ AGENTS_RUN_ID: 'agents-run', JANGAR_RUN_ID: 'jangar-run' })).toBe('agents-run')
    expect(__test__.resolveRunId({ AGENT_RUN_ID: 'agent-run' })).toBe('agent-run')
    expect(__test__.resolveRunId({ RUN_ID: 'run', CODEX_RUN_ID: 'codex-run' })).toBe('run')
    expect(__test__.resolveRunId({ CODEX_RUN_ID: 'codex-run' })).toBe('codex-run')
    expect(__test__.resolveRunId({ JANGAR_RUN_ID: 'jangar-run' })).toBeNull()
  })
})
