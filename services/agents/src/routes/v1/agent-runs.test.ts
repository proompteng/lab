import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRunsApiStore } from '../../server/v1/agent-runs'
import { configureAgentsV1Runtime, resetAgentsV1RuntimeForTests } from '../../server/v1/runtime'

import { getAgentRunsHandler } from './agent-runs'

const createStore = (runs: unknown[] = []): AgentRunsApiStore =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    listAgentRuns: vi.fn(async () => runs),
  }) as unknown as AgentRunsApiStore

describe('Agents v1 AgentRun route ownership', () => {
  afterEach(() => {
    resetAgentsV1RuntimeForTests()
  })

  it('returns a 503 when the Agents route runtime has no store dependency', async () => {
    const response = await getAgentRunsHandler(new Request('http://agents.local/v1/agent-runs?agentId=demo'))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: 'AgentRuns API runtime dependencies are not configured: storeFactory is required',
    })
  })

  it('uses the configured Agents route runtime dependencies', async () => {
    const store = createStore([{ id: 'run-1' }])
    configureAgentsV1Runtime({
      agentRuns: {
        storeFactory: () => store,
      },
    })

    const response = await getAgentRunsHandler(new Request('http://agents.local/v1/agent-runs?agentId=demo'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, runs: [{ id: 'run-1' }] })
    expect(store.listAgentRuns).toHaveBeenCalledWith({ agentName: 'demo', statuses: [], limit: 50 })
    expect(store.close).toHaveBeenCalledTimes(1)
  })

  it('lists AgentRuns by status for domain consumers without requiring a Jangar database projection', async () => {
    const store = createStore([{ id: 'run-1', status: 'Running' }])
    configureAgentsV1Runtime({
      agentRuns: {
        storeFactory: () => store,
      },
    })

    const response = await getAgentRunsHandler(
      new Request('http://agents.local/v1/agent-runs?status=Running,Pending&limit=100'),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, runs: [{ id: 'run-1', status: 'Running' }] })
    expect(store.listAgentRuns).toHaveBeenCalledWith({ agentName: null, statuses: ['Running', 'Pending'], limit: 100 })
  })

  it('lets tests and compatibility callers override configured route dependencies', async () => {
    const configuredStore = createStore([{ id: 'configured-run' }])
    const overrideStore = createStore([{ id: 'override-run' }])
    configureAgentsV1Runtime({
      agentRuns: {
        storeFactory: () => configuredStore,
      },
    })

    const response = await getAgentRunsHandler(new Request('http://agents.local/v1/agent-runs?agentId=demo'), {
      storeFactory: () => overrideStore,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, runs: [{ id: 'override-run' }] })
    expect(configuredStore.listAgentRuns).not.toHaveBeenCalled()
    expect(overrideStore.listAgentRuns).toHaveBeenCalledWith({ agentName: 'demo', statuses: [], limit: 50 })
  })
})
