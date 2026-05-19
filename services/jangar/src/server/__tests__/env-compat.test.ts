import { describe, expect, it } from 'vitest'

import { installJangarEnvCompatibility, toAgentsEnvName, toJangarEnvName, type MutableEnv } from '../env-compat'

describe('Jangar env compatibility', () => {
  it('maps canonical Agents env names into Jangar env names locally', () => {
    const env: MutableEnv = {
      AGENTS_PORT: '8080',
      AGENTS_GRPC_ENABLED: 'true',
      JANGAR_PORT: '3000',
    }

    installJangarEnvCompatibility(env)

    expect(env.JANGAR_PORT).toBe('8080')
    expect(env.JANGAR_GRPC_ENABLED).toBe('true')
  })

  it('maps Jangar env names into Agents env names for reused Agents modules', () => {
    const env: MutableEnv = {
      JANGAR_GRPC_ENABLED: 'true',
      JANGAR_GRPC_PORT: '50051',
      AGENTS_GRPC_PORT: '60000',
    }

    installJangarEnvCompatibility(env)

    expect(env.AGENTS_GRPC_ENABLED).toBe('true')
    expect(env.AGENTS_GRPC_PORT).toBe('60000')
  })

  it('ignores non-Agents env names', () => {
    expect(toJangarEnvName('PORT')).toBeNull()
    expect(toJangarEnvName('JANGAR_PORT')).toBeNull()
    expect(toAgentsEnvName('PORT')).toBeNull()
    expect(toAgentsEnvName('AGENTS_PORT')).toBeNull()
  })
})
