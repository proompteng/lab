import { describe, expect, it } from 'vitest'

import { getMemoryProviderHealth, MEMORY_PROVIDER_MISSING_API_KEY_MESSAGE } from '~/server/memory-provider-health'

describe('memory-provider-health', () => {
  it('reports the Agents service delegation by default', () => {
    const health = getMemoryProviderHealth({
      NODE_ENV: 'development',
    })

    expect(health).toMatchObject({
      status: 'healthy',
      mode: 'agents-service',
      fallbackActive: false,
      config: {
        agentsServiceBaseUrl: 'http://agents.agents.svc.cluster.local',
        clientName: 'jangar',
      },
    })
  })

  it('reports explicit Agents service settings without checking local embedding config', () => {
    const health = getMemoryProviderHealth({
      NODE_ENV: 'production',
      OPENAI_EMBEDDING_DIMENSION: '0',
      AGENTS_SERVICE_BASE_URL: 'http://agents.test///',
      AGENTS_SERVICE_CLIENT_NAME: 'jangar-memory-health-test',
    })

    expect(health).toMatchObject({
      status: 'healthy',
      mode: 'agents-service',
      reason: 'memory persistence and retrieval are delegated to the Agents service',
      config: {
        agentsServiceBaseUrl: 'http://agents.test',
        clientName: 'jangar-memory-health-test',
      },
    })
    expect(MEMORY_PROVIDER_MISSING_API_KEY_MESSAGE).toContain('delegated to the Agents service')
  })
})
