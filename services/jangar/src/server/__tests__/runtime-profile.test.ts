import { describe, expect, it } from 'vitest'

import { JANGAR_RUNTIME_PROFILES, resolveJangarRuntimeProfile } from '~/server/runtime-profile'

describe('runtime profile resolution', () => {
  it('defaults to the HTTP control-plane profile', () => {
    expect(resolveJangarRuntimeProfile({})).toBe(JANGAR_RUNTIME_PROFILES.httpServer)
  })

  it('selects the Agents controllers profile from canonical Agents env', () => {
    expect(resolveJangarRuntimeProfile({ AGENTS_SERVER_PROFILE: 'agents-controllers' })).toBe(
      JANGAR_RUNTIME_PROFILES.agentsControllers,
    )
  })

  it('selects the Agents control-plane profile without serving Jangar client assets', () => {
    const profile = resolveJangarRuntimeProfile({ AGENTS_SERVER_PROFILE: 'agents-control-plane' })

    expect(profile).toBe(JANGAR_RUNTIME_PROFILES.agentsControlPlane)
    expect(profile.serveClient).toBe(false)
    expect(profile.startup).toBe(JANGAR_RUNTIME_PROFILES.httpServer.startup)
  })

  it('accepts concise control-plane aliases for the transitional Agents image', () => {
    expect(resolveJangarRuntimeProfile({ AGENTS_SERVER_PROFILE: 'control-plane' })).toBe(
      JANGAR_RUNTIME_PROFILES.agentsControlPlane,
    )
    expect(resolveJangarRuntimeProfile({ AGENTS_SERVER_PROFILE: 'api' })).toBe(
      JANGAR_RUNTIME_PROFILES.agentsControlPlane,
    )
  })

  it('keeps legacy Jangar profile env as a compatibility alias', () => {
    expect(resolveJangarRuntimeProfile({ JANGAR_SERVER_PROFILE: 'controller' })).toBe(
      JANGAR_RUNTIME_PROFILES.agentsControllers,
    )
  })
})
