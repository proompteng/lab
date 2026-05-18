import { describe, expect, it } from 'vitest'

import { resolveAgentCommsSubscriberConfig, resolveFeatureFlagsClientConfig } from './integrations-config'

describe('Agents integrations config', () => {
  it('prefers canonical AGENTS feature flag settings over JANGAR compatibility aliases', () => {
    const config = resolveFeatureFlagsClientConfig({
      AGENTS_FEATURE_FLAGS_ENABLED: 'true',
      AGENTS_FEATURE_FLAGS_URL: 'http://agents-flags.local/',
      AGENTS_FEATURE_FLAGS_TIMEOUT_MS: '750',
      AGENTS_FEATURE_FLAGS_NAMESPACE: 'agents',
      AGENTS_FEATURE_FLAGS_ENTITY_ID: 'agents-controller',
      JANGAR_FEATURE_FLAGS_URL: 'http://jangar-flags.local',
    })

    expect(config).toMatchObject({
      enabled: true,
      endpoint: 'http://agents-flags.local',
      timeoutMs: 750,
      namespaceKey: 'agents',
      entityId: 'agents-controller',
    })
  })

  it('keeps JANGAR feature flag and agent comms names as compatibility aliases', () => {
    const featureFlags = resolveFeatureFlagsClientConfig({
      JANGAR_FEATURE_FLAGS_ENABLED: 'false',
      JANGAR_FEATURE_FLAGS_URL: 'http://jangar-flags.local/',
      JANGAR_FEATURE_FLAGS_TIMEOUT_MS: '250',
    })
    const agentComms = resolveAgentCommsSubscriberConfig({
      JANGAR_AGENT_COMMS_SUBSCRIBER_DISABLED: 'true',
      JANGAR_AGENT_COMMS_SUBJECTS: 'agents.workflow.>,workflow.>',
    })

    expect(featureFlags.enabled).toBe(false)
    expect(featureFlags.endpoint).toBe('http://jangar-flags.local')
    expect(featureFlags.timeoutMs).toBe(250)
    expect(agentComms.disabled).toBe(true)
    expect(agentComms.filterSubjects).toEqual(['agents.workflow.>', 'workflow.>'])
  })
})
