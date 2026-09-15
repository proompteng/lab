import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('crossws/adapters/bun', () => ({
  default: vi.fn(() => ({
    handleUpgrade: vi.fn(async () => null),
    websocket: {},
  })),
}))

import { resetAgentsV1RuntimeForTests } from './v1/runtime'
import { createAgentsControlPlaneRuntime } from './control-plane'

const previousEnv = {
  AGENTS_CONTROLLER_ENABLED: process.env.AGENTS_CONTROLLER_ENABLED,
  AGENTS_PROMETHEUS_METRICS_ENABLED: process.env.AGENTS_PROMETHEUS_METRICS_ENABLED,
  AGENTS_MIGRATIONS: process.env.AGENTS_MIGRATIONS,
  DATABASE_URL: process.env.DATABASE_URL,
}

afterEach(() => {
  resetAgentsV1RuntimeForTests()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('Agents control-plane runtime', () => {
  it('serves health from the Agents runtime without external route modules', async () => {
    process.env.AGENTS_CONTROLLER_ENABLED = '0'
    const runtime = await createAgentsControlPlaneRuntime()

    const response = await runtime.handleHttpRequest(new Request('http://agents.test/health'))
    const body = (await response.json()) as { status: string; service: string }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'ok', service: 'agents' })
  })

  it('serves v1 AgentRun routes through configured Agents dependencies', async () => {
    process.env.AGENTS_CONTROLLER_ENABLED = '0'
    delete process.env.DATABASE_URL
    process.env.AGENTS_MIGRATIONS = 'skip'
    const runtime = await createAgentsControlPlaneRuntime()

    const response = await runtime.handleHttpRequest(new Request('http://agents.test/v1/agent-runs?agentName=demo'))
    const body = (await response.json()) as { error?: string }

    expect(response.status).toBe(503)
    expect(body.error).toContain('DATABASE_URL is required for Agents primitives storage')
  })
})
