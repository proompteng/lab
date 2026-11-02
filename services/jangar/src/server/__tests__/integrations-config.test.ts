import { describe, expect, it } from 'vitest'

import { resolveFeatureFlagsClientConfig, validateIntegrationsConfig } from '~/server/integrations-config'

describe('integrations-config', () => {
  it('normalizes feature flag client settings', () => {
    expect(
      resolveFeatureFlagsClientConfig({
        JANGAR_FEATURE_FLAGS_URL: 'https://flags.example.com///',
        JANGAR_FEATURE_FLAGS_TIMEOUT_MS: '900',
        JANGAR_FEATURE_FLAGS_NAMESPACE: 'prod',
        JANGAR_FEATURE_FLAGS_ENTITY_ID: 'jangar-web',
      }),
    ).toEqual({
      enabled: true,
      endpoint: 'https://flags.example.com',
      timeoutMs: 900,
      namespaceKey: 'prod',
      entityId: 'jangar-web',
    })
  })

  it('rejects invalid integration endpoints during validation', () => {
    expect(() =>
      validateIntegrationsConfig({
        JANGAR_FEATURE_FLAGS_URL: '://bad-url',
      }),
    ).toThrow('JANGAR_FEATURE_FLAGS_URL is invalid')
  })
})
