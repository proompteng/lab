import { describe, expect, it } from 'vitest'

import { resolveAgentCommsSubscriberConfig, resolveFeatureFlagsClientConfig } from './integrations-config'

describe('Agents integrations config', () => {
  it('reads canonical AGENTS feature flag settings', () => {
    const config = resolveFeatureFlagsClientConfig({
      AGENTS_FEATURE_FLAGS_ENABLED: 'true',
      AGENTS_FEATURE_FLAGS_URL: 'http://agents-flags.local/',
      AGENTS_FEATURE_FLAGS_TIMEOUT_MS: '750',
      AGENTS_FEATURE_FLAGS_NAMESPACE: 'agents',
      AGENTS_FEATURE_FLAGS_ENTITY_ID: 'agents-controller',
    })

    expect(config).toMatchObject({
      enabled: true,
      endpoint: 'http://agents-flags.local',
      timeoutMs: 750,
      namespaceKey: 'agents',
      entityId: 'agents-controller',
    })
  })

  it('rejects non-canonical agent comms subject families', () => {
    expect(() =>
      resolveAgentCommsSubscriberConfig({
        AGENTS_AGENT_COMMS_SUBJECTS: 'agentrun.>,agents.agentrun.>,agents.agent_messages.>,workflow.general.>',
      }),
    ).toThrow(
      'AGENTS_AGENT_COMMS_SUBJECTS only supports canonical agentrun.* subjects: agents.agentrun.>, agents.agent_messages.>, workflow.general.>',
    )
  })
})
