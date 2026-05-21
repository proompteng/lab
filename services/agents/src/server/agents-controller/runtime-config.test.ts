import { describe, expect, it } from 'vitest'

import {
  resolveAgentRunnerDefaultsConfig,
  resolveAgentsControllerAuthSecretConfig,
  resolveAgentsControllerBehaviorConfig,
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

  it('does not read legacy Jangar env names in the Agents controller', () => {
    const env = {
      JANGAR_AGENT_RUNNER_IMAGE: 'registry.example/jangar-runner:compat',
      JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS: '120',
      JANGAR_AGENTRUN_ARTIFACTS_MAX: '5',
      JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME: 'jangar-auth',
    }

    expect(resolveAgentRunnerDefaultsConfig(env).defaultRunnerImage).toBeNull()
    expect(resolveAgentRunnerDefaultsConfig(env).jobTtlSeconds).toBe(600)
    expect(resolveAgentsControllerBehaviorConfig(env).artifactsMaxEntries).toBe(50)
    expect(resolveAgentsControllerAuthSecretConfig(env)).toBeNull()
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
        JANGAR_IMPLEMENTATION_SOURCE_WEBHOOK_QUEUE_SIZE: '999',
      }),
    ).toEqual({
      namespacesRaw: 'agents,dev',
      queueSize: 25,
      retryBaseDelaySeconds: 2,
      retryMaxDelaySeconds: 30,
      retryMaxAttempts: 4,
    })

    expect(
      resolveImplementationSourceWebhookConfig({
        JANGAR_IMPLEMENTATION_SOURCE_WEBHOOK_NAMESPACES: 'jangar',
        JANGAR_IMPLEMENTATION_SOURCE_WEBHOOK_QUEUE_SIZE: '999',
      }),
    ).toEqual({
      namespacesRaw: null,
      queueSize: null,
      retryBaseDelaySeconds: null,
      retryMaxDelaySeconds: null,
      retryMaxAttempts: null,
    })
  })
})
