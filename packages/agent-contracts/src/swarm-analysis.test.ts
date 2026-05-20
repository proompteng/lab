import { describe, expect, it, vi } from 'vitest'

import { isNatsChannel, resolveStageTargetResource } from './swarm-analysis'

describe('supporting primitives swarm analysis', () => {
  it('resolves AgentRun target refs through the Agents service boundary', async () => {
    const fetchResource = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      body: {
        ok: true,
        kind: 'AgentRun',
        namespace: 'agents',
        resource: { kind: 'AgentRun', metadata: { name: 'swarm-plan' } },
      },
    }))

    await expect(
      resolveStageTargetResource({ kind: 'AgentRun', name: 'swarm-plan', namespace: 'agents' }, { fetchResource }),
    ).resolves.toEqual({ kind: 'AgentRun', metadata: { name: 'swarm-plan' } })

    expect(fetchResource).toHaveBeenCalledWith({
      kind: 'AgentRun',
      name: 'swarm-plan',
      namespace: 'agents',
    })
  })

  it('returns null when the Agents service reports a missing target ref', async () => {
    const fetchResource = vi.fn(async () => ({
      ok: false as const,
      status: 404,
      body: { ok: false, error: 'AgentRun not found' },
      error: 'AgentRun not found',
    }))

    await expect(
      resolveStageTargetResource(
        { kind: 'OrchestrationRun', name: 'missing-run', namespace: 'agents' },
        { fetchResource },
      ),
    ).resolves.toBeNull()
  })

  it('does not treat retired workflow_comms agent-message subjects as runtime channels', () => {
    expect(isNatsChannel('agents.agent_messages.general.status')).toBe(true)
    expect(isNatsChannel('agentrun.general.status')).toBe(true)
    expect(isNatsChannel('workflow.general.status')).toBe(false)
    expect(isNatsChannel('workflow_comms.agent_messages.general.status')).toBe(false)
  })
})
