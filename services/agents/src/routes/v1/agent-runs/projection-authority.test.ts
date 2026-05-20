import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRunsApiStore } from '../../../server/v1/agent-runs'
import { configureAgentsV1Runtime, resetAgentsV1RuntimeForTests } from '../../../server/v1/runtime'

import { getAgentRunProjectionAuthorityHandler } from './projection-authority'

const createStore = (runs: unknown[] = []): AgentRunsApiStore =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    listAgentRuns: vi.fn(async () => runs),
  }) as unknown as AgentRunsApiStore

describe('AgentRun projection authority route ownership', () => {
  afterEach(() => {
    resetAgentsV1RuntimeForTests()
  })

  it('returns a 503 when the Agents route runtime has no store dependency', async () => {
    const response = await getAgentRunProjectionAuthorityHandler(
      new Request('http://agents.local/v1/agent-runs/projection-authority'),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: 'AgentRuns API runtime dependencies are not configured: storeFactory is required',
    })
  })

  it('uses the configured Agents route runtime dependencies', async () => {
    const store = createStore([
      {
        id: 'run-1',
        agentName: 'codex-worker',
        deliveryId: 'delivery-1',
        provider: 'job',
        status: 'Running',
        externalRunId: 'agentrun-1',
        payload: { timeoutSeconds: 86_400 },
        createdAt: '2026-05-20T10:00:00.000Z',
        updatedAt: '2026-05-20T10:00:00.000Z',
      },
    ])
    configureAgentsV1Runtime({
      agentRuns: {
        storeFactory: () => store,
      },
    })

    const response = await getAgentRunProjectionAuthorityHandler(
      new Request('http://agents.local/v1/agent-runs/projection-authority?agentName=codex-worker'),
      { now: () => new Date('2026-05-20T12:00:00.000Z') },
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      schemaVersion: 'agents.agentrun-projection-authority.v1',
      total: 1,
    })
    expect(body.claims[0]).toMatchObject({
      claim_class: 'agentrun_execution',
      authority_state: 'authoritative',
    })
    expect(store.close).toHaveBeenCalledTimes(1)
  })
})
