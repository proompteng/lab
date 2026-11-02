import { describe, expect, it } from 'vitest'

import { JANGAR_RUNTIME_PROFILES, resolveJangarRuntimeProfile } from '~/server/runtime-profile'

describe('runtime profile resolution', () => {
  it('defaults to the HTTP control-plane profile', () => {
    expect(resolveJangarRuntimeProfile({})).toBe(JANGAR_RUNTIME_PROFILES.httpServer)
  })

  it('ignores Agents-owned runtime profiles after controller extraction', () => {
    expect(resolveJangarRuntimeProfile({ AGENTS_SERVER_PROFILE: 'agents-controllers' })).toBe(
      JANGAR_RUNTIME_PROFILES.httpServer,
    )
    expect(resolveJangarRuntimeProfile({ AGENTS_SERVER_PROFILE: 'agents-control-plane' })).toBe(
      JANGAR_RUNTIME_PROFILES.httpServer,
    )
    expect(resolveJangarRuntimeProfile({ JANGAR_SERVER_PROFILE: 'controller' })).toBe(
      JANGAR_RUNTIME_PROFILES.httpServer,
    )
  })

  it('keeps Jangar-local utility profiles only', () => {
    expect(resolveJangarRuntimeProfile({ JANGAR_SERVER_PROFILE: 'vite-dev-api' })).toBe(
      JANGAR_RUNTIME_PROFILES.viteDevApi,
    )
    expect(resolveJangarRuntimeProfile({ JANGAR_SERVER_PROFILE: 'test' })).toBe(JANGAR_RUNTIME_PROFILES.test)
  })
})
