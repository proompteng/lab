import { describe, expect, it, vi } from 'vitest'

import { getControlPlaneSummary } from '~/routes/api/agents/control-plane/summary'
import { RESOURCE_MAP } from '~/server/primitives-kube'

const buildList = (items: Record<string, unknown>[] = []) => ({ items })

describe('control plane summary route', () => {
  it('aggregates totals and run phases', async () => {
    const lists: Record<string, Record<string, unknown>> = {
      [RESOURCE_MAP.Agent]: buildList([{}, {}]),
      [RESOURCE_MAP.AgentRun]: buildList([
        { status: { phase: 'Pending' } },
        { status: { phase: 'Running' } },
        { status: { phase: 'Running' } },
        { status: {} },
      ]),
      [RESOURCE_MAP.Orchestration]: buildList([]),
      [RESOURCE_MAP.OrchestrationRun]: buildList([
        { status: { phase: 'Succeeded' } },
        { status: { phase: 'Failed' } },
        { status: { phase: 'Cancelled' } },
      ]),
      [RESOURCE_MAP.ImplementationSpec]: buildList([{}]),
      [RESOURCE_MAP.ImplementationSource]: buildList([{}, {}, {}]),
      [RESOURCE_MAP.Memory]: buildList([]),
      [RESOURCE_MAP.Tool]: buildList([{}]),
      [RESOURCE_MAP.Signal]: buildList([{}, {}]),
      [RESOURCE_MAP.Schedule]: buildList([]),
      [RESOURCE_MAP.Artifact]: buildList([{}]),
      [RESOURCE_MAP.Workspace]: buildList([{}, {}]),
    }

    const kube = {
      list: vi.fn(async (resource: string) => lists[resource] ?? buildList()),
    }

    const response = await getControlPlaneSummary(
      new Request('http://localhost/api/agents/control-plane/summary?namespace=agents'),
      { kubeClient: kube },
    )

    expect(kube.list).toHaveBeenCalled()
    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.namespace).toBe('agents')

    const resources = payload.resources as Record<string, Record<string, unknown>>
    expect(resources.Agent.total).toBe(2)
    expect(resources.AgentRun.total).toBe(4)
    expect(resources.Orchestration.total).toBe(0)
    expect(resources.OrchestrationRun.total).toBe(3)

    const agentRunPhases = resources.AgentRun.phases as Record<string, number>
    expect(agentRunPhases.Pending).toBe(1)
    expect(agentRunPhases.Running).toBe(2)
    expect(agentRunPhases.Unknown).toBe(1)

    const orchestrationRunPhases = resources.OrchestrationRun.phases as Record<string, number>
    expect(orchestrationRunPhases.Succeeded).toBe(1)
    expect(orchestrationRunPhases.Failed).toBe(1)
    expect(orchestrationRunPhases.Cancelled).toBe(1)
  })

  it('includes per-kind errors when listing fails', async () => {
    const kube = {
      list: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Memory) {
          throw new Error('boom')
        }
        return buildList([])
      }),
    }

    const response = await getControlPlaneSummary(new Request('http://localhost/api/agents/control-plane/summary'), {
      kubeClient: kube,
    })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    const resources = payload.resources as Record<string, Record<string, unknown>>
    expect(resources.Memory.total).toBe(0)
    expect(resources.Memory.error).toBe('boom')
    expect(resources.Memory.phases).toBeUndefined()
  })
})
