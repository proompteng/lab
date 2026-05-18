import { beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }

const agentsControllerMocks = vi.hoisted(() => ({
  getAgentsControllerHealth: vi.fn(),
}))

vi.mock('~/server/agents-controller', () => agentsControllerMocks)

describe('health route', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.clearAllMocks()
    agentsControllerMocks.getAgentsControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
      agentRunIngestion: [],
    })
  })

  it('reports Agents service identity under Agents runtime env', async () => {
    process.env.AGENTS_IMAGE = 'registry.example/lab/agents-controller:abc123'

    const { Route } = await import('./health')
    const response = await Route.options.server.handlers.GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'agents',
    })
  })

  it('keeps Jangar service identity without Agents runtime env', async () => {
    const { Route } = await import('./health')
    const response = await Route.options.server.handlers.GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'jangar',
    })
  })
})
