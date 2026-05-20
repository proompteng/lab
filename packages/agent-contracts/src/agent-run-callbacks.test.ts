import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import {
  parseAgentRunNotifyPayload,
  parseAgentRunRunCompletePayload,
  removeLegacyWorkflowIdentityFields,
} from './agent-run-callbacks'

const encodeJson = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

describe('agent-run-callbacks', () => {
  it('parses AgentRun identity as the primary run-complete identity', () => {
    const parsed = parseAgentRunRunCompletePayload({
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        name: 'agentrun-123',
        namespace: 'agents',
        uid: 'uid-123',
      },
      agentRunId: 'run-123',
      status: { phase: 'Succeeded' },
    })

    expect(parsed.runId).toBe('run-123')
    expect(parsed.agentRunName).toBe('agentrun-123')
    expect(parsed.agentRunNamespace).toBe('agents')
    expect(parsed.agentRunUid).toBe('uid-123')
    expect(parsed.phase).toBe('Succeeded')
  })

  it('ignores legacy workflow identity when AgentRun run-complete identity is present', () => {
    const parsed = parseAgentRunRunCompletePayload({
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        name: 'agentrun-current',
        namespace: 'agents',
        uid: 'uid-current',
      },
      agent_run_id: 'run-current',
      agent_run_name: 'agentrun-current',
      agent_run_namespace: 'agents',
      agent_run_uid: 'uid-current',
      workflowName: 'legacy-workflow',
      workflowNamespace: 'legacy',
      workflowUid: 'legacy-uid',
      status: { phase: 'Succeeded' },
    })

    expect(parsed.agentRunName).toBe('agentrun-current')
    expect(parsed.agentRunNamespace).toBe('agents')
    expect(parsed.agentRunUid).toBe('uid-current')
  })

  it('resolves GitHub metadata from encoded run-complete parameters', () => {
    const parsed = parseAgentRunRunCompletePayload({
      kind: 'AgentRun',
      metadata: {
        name: 'encoded-agentrun',
        labels: {
          'codex.thread_id': 'thread-label',
        },
      },
      arguments: {
        parameters: [
          {
            name: 'eventBody',
            value: encodeJson({
              repository: 'proompteng/lab',
              issue_number: 7152,
              head: 'codex/agents-split',
              base: 'main',
              prompt: 'finish migration',
              turn_id: 'turn-1',
              iteration_cycle: 2,
            }),
          },
        ],
      },
      artifacts: JSON.stringify([{ name: 'implementation-events', key: 'runs/encoded/events.jsonl' }]),
    })

    expect(parsed.repository).toBe('proompteng/lab')
    expect(parsed.issueNumber).toBe(7152)
    expect(parsed.head).toBe('codex/agents-split')
    expect(parsed.base).toBe('main')
    expect(parsed.prompt).toBe('finish migration')
    expect(parsed.turnId).toBe('turn-1')
    expect(parsed.threadId).toBe('thread-label')
    expect(parsed.iterationCycle).toBe(2)
    expect(parsed.artifacts).toEqual([
      {
        name: 'implementation-events',
        key: 'runs/encoded/events.jsonl',
        bucket: null,
        url: null,
        metadata: { name: 'implementation-events', key: 'runs/encoded/events.jsonl' },
      },
    ])
  })

  it('parses AgentRun notify identity without requiring legacy workflow fields', () => {
    const parsed = parseAgentRunNotifyPayload({
      agent_run_id: 'run-456',
      agent_run_name: 'agentrun-456',
      agent_run_namespace: 'agents',
      last_assistant_message: 'opened PR',
    })

    expect(parsed.runId).toBe('run-456')
    expect(parsed.agentRunName).toBe('agentrun-456')
    expect(parsed.agentRunNamespace).toBe('agents')
    expect(parsed.notifyPayload).toEqual(
      expect.objectContaining({
        agent_run_id: 'run-456',
        agent_run_name: 'agentrun-456',
      }),
    )
  })

  it('ignores legacy workflow identity when AgentRun notify identity is present', () => {
    const parsed = parseAgentRunNotifyPayload({
      agent_run_id: 'run-789',
      agent_run_name: 'agentrun-789',
      agent_run_namespace: 'agents',
      workflow_name: 'legacy-workflow',
      workflow_namespace: 'legacy',
      last_assistant_message: 'opened PR',
    })

    expect(parsed.agentRunName).toBe('agentrun-789')
    expect(parsed.agentRunNamespace).toBe('agents')
  })

  it('strips workflow-shaped identity from artifact fallback notify payloads', () => {
    const payload = removeLegacyWorkflowIdentityFields({
      workflow_name: 'legacy-workflow',
      workflow_namespace: 'legacy',
      workflow_uid: 'legacy-uid',
      workflow_stage: 'legacy-stage',
      workflow_step: 'legacy-step',
      agent_run_name: 'agentrun-current',
      repository: 'proompteng/lab',
    })

    expect(payload).toEqual({
      agent_run_name: 'agentrun-current',
      repository: 'proompteng/lab',
    })
  })
})
