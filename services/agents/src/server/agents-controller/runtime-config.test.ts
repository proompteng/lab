import { describe, expect, it } from 'vitest'

import {
  resolveAgentRunnerDefaultsConfig,
  resolveAgentsControllerAuthSecretConfig,
  resolveAgentsControllerBehaviorConfig,
} from './runtime-config'

describe('Agents controller runtime config', () => {
  it('reads canonical AGENTS env names', () => {
    const env = {
      AGENTS_AGENT_RUNNER_IMAGE: 'registry.example/agents-runner:next',
      AGENTS_AGENT_RUNNER_JOB_TTL_SECONDS: '900',
      AGENTS_AGENTRUN_ARTIFACTS_MAX: '7',
      AGENTS_AGENTS_CONTROLLER_AUTH_SECRET_NAME: 'agents-auth',
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
})
