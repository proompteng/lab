import { describe, expect, it } from 'vitest'

import { installAgentsEnvCompatibility, toJangarEnvName } from './env-compat'

describe('Agents env compatibility', () => {
  it('maps canonical AGENTS env names to JANGAR compatibility names', () => {
    const env = {
      AGENTS_AGENT_RUNNER_IMAGE: 'registry.example/agents-runner:next',
      JANGAR_AGENT_RUNNER_IMAGE: 'registry.example/jangar-runner:old',
      PORT: '8080',
    }

    installAgentsEnvCompatibility(env)

    expect(env.JANGAR_AGENT_RUNNER_IMAGE).toBe('registry.example/agents-runner:next')
    expect(env.PORT).toBe('8080')
  })

  it('leaves non-Agents names alone', () => {
    expect(toJangarEnvName('PORT')).toBeNull()
    expect(toJangarEnvName('AGENTS_GRPC_ENABLED')).toBe('JANGAR_GRPC_ENABLED')
  })
})
