import { describe, expect, it } from 'vitest'

import {
  resolveAgentRunnerDefaultsConfig,
  resolveAgentsControllerAuthSecretConfig,
  resolveAgentsControllerBehaviorConfig,
} from './runtime-config'

describe('Agents controller runtime config', () => {
  it('prefers canonical AGENTS env names over JANGAR compatibility aliases', () => {
    const env = {
      AGENTS_AGENT_RUNNER_IMAGE: 'registry.example/agents-runner:next',
      JANGAR_AGENT_RUNNER_IMAGE: 'registry.example/jangar-runner:old',
      AGENTS_AGENT_RUNNER_JOB_TTL_SECONDS: '900',
      JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS: '60',
      AGENTS_AGENTRUN_ARTIFACTS_MAX: '7',
      JANGAR_AGENTRUN_ARTIFACTS_MAX: '3',
      AGENTS_AGENTS_CONTROLLER_AUTH_SECRET_NAME: 'agents-auth',
      JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME: 'jangar-auth',
    }

    expect(resolveAgentRunnerDefaultsConfig(env).defaultRunnerImage).toBe('registry.example/agents-runner:next')
    expect(resolveAgentRunnerDefaultsConfig(env).jobTtlSeconds).toBe(900)
    expect(resolveAgentsControllerBehaviorConfig(env).artifactsMaxEntries).toBe(7)
    expect(resolveAgentsControllerAuthSecretConfig(env)?.name).toBe('agents-auth')
  })

  it('keeps JANGAR env names as compatibility aliases', () => {
    const env = {
      JANGAR_AGENT_RUNNER_IMAGE: 'registry.example/jangar-runner:compat',
      JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS: '120',
      JANGAR_AGENTRUN_ARTIFACTS_MAX: '5',
      JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME: 'jangar-auth',
    }

    expect(resolveAgentRunnerDefaultsConfig(env).defaultRunnerImage).toBe('registry.example/jangar-runner:compat')
    expect(resolveAgentRunnerDefaultsConfig(env).jobTtlSeconds).toBe(120)
    expect(resolveAgentsControllerBehaviorConfig(env).artifactsMaxEntries).toBe(5)
    expect(resolveAgentsControllerAuthSecretConfig(env)?.name).toBe('jangar-auth')
  })
})
