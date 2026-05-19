import { describe, expect, it } from 'vitest'

import { resolveImplementationSourceWebhookConfig } from '~/server/implementation-source-webhook-config'

describe('implementation source webhook config', () => {
  it('reads canonical Agents webhook environment values locally', () => {
    const config = resolveImplementationSourceWebhookConfig({
      AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_NAMESPACES: 'agents,jangar',
      AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_QUEUE_SIZE: '25',
      AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_BASE_DELAY_SECONDS: '2',
      AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_DELAY_SECONDS: '30',
      AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_ATTEMPTS: '4',
    })

    expect(config).toEqual({
      namespacesRaw: 'agents,jangar',
      queueSize: 25,
      retryBaseDelaySeconds: 2,
      retryMaxDelaySeconds: 30,
      retryMaxAttempts: 4,
    })
  })

  it('ignores legacy Jangar webhook aliases', () => {
    const config = resolveImplementationSourceWebhookConfig({
      JANGAR_IMPLEMENTATION_SOURCE_WEBHOOK_QUEUE_SIZE: '50',
    })

    expect(config.queueSize).toBeNull()
  })
})
