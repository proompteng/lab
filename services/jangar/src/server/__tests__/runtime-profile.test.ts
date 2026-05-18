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

  it('keeps legacy Jangar profile env as a compatibility alias', () => {
    expect(resolveJangarRuntimeProfile({ JANGAR_SERVER_PROFILE: 'controller' })).toBe(
      JANGAR_RUNTIME_PROFILES.agentsControllers,
    )
  })
})
