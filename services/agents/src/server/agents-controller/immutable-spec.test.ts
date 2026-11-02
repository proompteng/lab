import { describe, expect, it } from 'vitest'

import {
  buildAgentRunImmutableSpecSnapshot,
  hashAgentRunImmutableSpec,
} from '~/server/agents-controller/immutable-spec'

describe('agents controller immutable-spec module', () => {
  it('builds a normalized immutable spec snapshot', () => {
    const snapshot = buildAgentRunImmutableSpecSnapshot({
      spec: {
        agentRef: { name: 'agent-a' },
        implementationSpecRef: { name: 'impl-a' },
        runtime: { type: 'job' },
        workflow: { steps: [] },
        secrets: ['z', 'a'],
        systemPrompt: 123,
      },
    })

    expect(snapshot.secrets).toEqual(['a', 'z'])
    expect(snapshot.systemPrompt).toBeNull()
    expect(snapshot.agentRef).toEqual({ name: 'agent-a' })
    expect(snapshot.runtime).toEqual({ type: 'job' })
  })

  it('produces stable hash regardless of secrets order', () => {
    const runA = {
      spec: {
        agentRef: { name: 'agent-a' },
        implementationSpecRef: { name: 'impl-a' },
        runtime: { type: 'job', config: { taskQueue: 'q1' } },
        secrets: ['secret-b', 'secret-a'],
      },
    }
    const runB = {
      spec: {
        agentRef: { name: 'agent-a' },
        implementationSpecRef: { name: 'impl-a' },
        runtime: { type: 'job', config: { taskQueue: 'q1' } },
        secrets: ['secret-a', 'secret-b'],
      },
    }

    expect(hashAgentRunImmutableSpec(runA)).toBe(hashAgentRunImmutableSpec(runB))
  })

  it('changes hash when immutable runtime spec fields change', () => {
    const runA = {
      spec: {
        runtime: { type: 'temporal', config: { workflowType: 'a' } },
      },
    }
    const runB = {
      spec: {
        runtime: { type: 'temporal', config: { workflowType: 'b' } },
      },
    }

    expect(hashAgentRunImmutableSpec(runA)).not.toBe(hashAgentRunImmutableSpec(runB))
  })
})
