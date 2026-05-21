import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { parseAgentRunNotifyPayload, parseAgentRunRunCompletePayload } from './agent-run-callbacks'

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

  it('does not treat non-AgentRun resource metadata as AgentRun identity', () => {
    const parsed = parseAgentRunRunCompletePayload({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: 'non-agentrun-job',
        namespace: 'agents',
        uid: 'job-uid',
      },
      status: { phase: 'Succeeded' },
    })

    expect(parsed.agentRunName).toBe('')
    expect(parsed.agentRunNamespace).toBeNull()
    expect(parsed.agentRunUid).toBeNull()
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
      pr_url: 'https://github.com/proompteng/lab/pull/7299',
      last_assistant_message: 'opened PR',
    })

    expect(parsed.runId).toBe('run-456')
    expect(parsed.agentRunName).toBe('agentrun-456')
    expect(parsed.agentRunNamespace).toBe('agents')
    expect(parsed.prNumber).toBe(7299)
    expect(parsed.notifyPayload).toEqual(
      expect.objectContaining({
        agent_run_id: 'run-456',
        agent_run_name: 'agentrun-456',
      }),
    )
  })

  it('stores AgentRun-native run-complete payload identity without compatibility cleanup', () => {
    const parsed = parseAgentRunRunCompletePayload({
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        name: 'agentrun-789',
        namespace: 'agents',
        uid: 'uid-789',
      },
      agentRunId: 'run-789',
      status: { phase: 'Succeeded' },
    })

    expect(parsed.agentRunName).toBe('agentrun-789')
    expect(parsed.runCompletePayload).toMatchObject({
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      agentRunId: 'run-789',
    })
  })
})
