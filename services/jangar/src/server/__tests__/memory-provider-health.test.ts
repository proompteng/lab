import { describe, expect, it } from 'vitest'

import { getMemoryProviderHealth, MEMORY_PROVIDER_MISSING_API_KEY_MESSAGE } from '~/server/memory-provider-health'

describe('memory-provider-health', () => {
  it('reports development fallback mode when no endpoint is configured outside production', () => {
    const health = getMemoryProviderHealth({
      NODE_ENV: 'development',
    })

    expect(health).toMatchObject({
      status: 'degraded',
      mode: 'development-fallback',
      fallbackActive: true,
    })
  })

  it('reports blocked when the hosted provider is selected without an API key in production', () => {
    const health = getMemoryProviderHealth({
      NODE_ENV: 'production',
    })

    expect(health).toMatchObject({
      status: 'blocked',
      mode: 'hosted',
      fallbackActive: false,
      reason: MEMORY_PROVIDER_MISSING_API_KEY_MESSAGE,
    })
  })

  it('reports healthy for an explicit self-hosted endpoint without an API key', () => {
    const health = getMemoryProviderHealth({
      NODE_ENV: 'production',
      OPENAI_API_BASE_URL: 'http://saigak.jangar.svc.cluster.local:11434/v1',
      OPENAI_EMBEDDING_MODEL: 'qwen3-embedding-saigak:8b',
      OPENAI_EMBEDDING_DIMENSION: '4096',
    })

    expect(health).toMatchObject({
      status: 'healthy',
      mode: 'self-hosted',
      fallbackActive: false,
      config: {
        hosted: false,
        dimension: 4096,
      },
    })
  })

  it('reports blocked for invalid embedding configuration values', () => {
    const health = getMemoryProviderHealth({
      NODE_ENV: 'production',
      OPENAI_API_BASE_URL: 'http://saigak.jangar.svc.cluster.local:11434/v1',
      OPENAI_EMBEDDING_DIMENSION: '0',
    })

    expect(health).toMatchObject({
      status: 'blocked',
      mode: 'invalid',
      fallbackActive: false,
      config: null,
    })
    expect(health.reason).toMatch(/OPENAI_EMBEDDING_DIMENSION/)
  })
})
