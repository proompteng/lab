import { describe, expect, it } from 'vitest'

import {
  resolveAgentRunnerDefaultsConfig,
  resolveAgentsControllerAuthSecretConfig,
  resolveAgentsControllerBehaviorConfig,
  resolveRuntimeDebrisCleanupConfig,
  resolveImplementationSourceWebhookConfig,
} from './runtime-config'

describe('Agents controller runtime config', () => {
  it('reads canonical AGENTS env names', () => {
    const env = {
      AGENTS_AGENT_RUNNER_IMAGE: 'registry.example/agents-runner:next',
      AGENTS_AGENT_RUNNER_JOB_TTL_SECONDS: '900',
      AGENTS_AGENTRUN_ARTIFACTS_MAX: '7',
      AGENTS_CONTROLLER_AUTH_SECRET_NAME: 'agents-auth',
    }

    expect(resolveAgentRunnerDefaultsConfig(env).defaultRunnerImage).toBe('registry.example/agents-runner:next')
    expect(resolveAgentRunnerDefaultsConfig(env).jobTtlSeconds).toBe(900)
    expect(resolveAgentsControllerBehaviorConfig(env).artifactsMaxEntries).toBe(7)
    expect(resolveAgentsControllerAuthSecretConfig(env)?.name).toBe('agents-auth')
  })

  it('does not read the legacy generic AGENTS_AGENT_IMAGE runner alias', () => {
    expect(
      resolveAgentRunnerDefaultsConfig({
        AGENTS_AGENT_IMAGE: 'registry.example/agents-runner:legacy-alias',
      }).defaultRunnerImage,
    ).toBeNull()
  })

  it('reads canonical ImplementationSource webhook env names only', () => {
    expect(
      resolveImplementationSourceWebhookConfig({
        AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_NAMESPACES: 'agents,dev',
        AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_QUEUE_SIZE: '25',
        AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_BASE_DELAY_SECONDS: '2',
        AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_DELAY_SECONDS: '30',
        AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_ATTEMPTS: '4',
      }),
    ).toEqual({
      namespacesRaw: 'agents,dev',
      queueSize: 25,
      retryBaseDelaySeconds: 2,
      retryMaxDelaySeconds: 30,
      retryMaxAttempts: 4,
    })

    expect(resolveImplementationSourceWebhookConfig({})).toEqual({
      namespacesRaw: null,
      queueSize: null,
      retryBaseDelaySeconds: null,
      retryMaxDelaySeconds: null,
      retryMaxAttempts: null,
    })
  })

  it('reads runtime debris cleanup env with safe defaults', () => {
    expect(resolveRuntimeDebrisCleanupConfig({})).toEqual({
      maxDeletesPerNamespace: 25,
      mode: 'disabled',
      orphanPodRetentionSeconds: 86400,
    })

    expect(
      resolveRuntimeDebrisCleanupConfig({
        AGENTS_CONTROLLER_RUNTIME_DEBRIS_CLEANUP_MODE: 'delete',
        AGENTS_CONTROLLER_ORPHAN_POD_RETENTION_SECONDS: '3600',
        AGENTS_CONTROLLER_RUNTIME_DEBRIS_MAX_DELETES_PER_NAMESPACE: '7',
      }),
    ).toEqual({
      maxDeletesPerNamespace: 7,
      mode: 'delete',
      orphanPodRetentionSeconds: 3600,
    })
  })
})
