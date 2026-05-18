import { describe, expect, it } from 'vitest'

import { buildAgentsHealthResponse } from './health'

const readJson = async (response: Response) => (await response.json()) as Record<string, unknown>

describe('buildAgentsHealthResponse', () => {
  it('returns ok when the agents controller is disabled', async () => {
    const response = buildAgentsHealthResponse({
      service: 'agents',
      agentsController: { enabled: false, crdsReady: null },
    })

    expect(response.status).toBe(200)
    expect(await readJson(response)).toMatchObject({
      status: 'ok',
      service: 'agents',
      agentsController: { enabled: false, crdsReady: null },
    })
  })

  it('returns degraded when an enabled controller has failed CRD readiness', async () => {
    const response = buildAgentsHealthResponse({
      service: 'agents',
      agentsController: { enabled: true, crdsReady: false },
    })

    expect(response.status).toBe(503)
    expect(await readJson(response)).toMatchObject({
      status: 'degraded',
      service: 'agents',
    })
  })
})
