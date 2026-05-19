import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureAgentCommsRuntime: vi.fn(),
  startControlPlaneCache: vi.fn(async () => {}),
  startTorghutQuantRuntime: vi.fn(),
  startWhitepaperFinalizeConsumer: vi.fn(),
}))

vi.mock('../agent-comms-runtime', () => ({
  ensureAgentCommsRuntime: mocks.ensureAgentCommsRuntime,
}))

vi.mock('../control-plane-cache', () => ({
  startControlPlaneCache: mocks.startControlPlaneCache,
}))

vi.mock('../torghut-quant-runtime', () => ({
  startTorghutQuantRuntime: mocks.startTorghutQuantRuntime,
}))

vi.mock('../whitepaper-finalize-consumer', () => ({
  startWhitepaperFinalizeConsumer: mocks.startWhitepaperFinalizeConsumer,
}))

const resetRuntimeStartupState = () => {
  Reflect.deleteProperty(
    globalThis as typeof globalThis & { __jangarRuntimeStartup?: unknown },
    '__jangarRuntimeStartup',
  )
}

describe('ensureRuntimeStartup', () => {
  beforeEach(() => {
    resetRuntimeStartupState()
    vi.clearAllMocks()
  })

  it('boots each non-gRPC subsystem once for the dev API profile', async () => {
    const { JANGAR_RUNTIME_PROFILES } = await import('../runtime-profile')
    const { ensureRuntimeStartup } = await import('../runtime-startup')

    ensureRuntimeStartup(JANGAR_RUNTIME_PROFILES.viteDevApi.startup)
    ensureRuntimeStartup(JANGAR_RUNTIME_PROFILES.viteDevApi.startup)

    expect(mocks.ensureAgentCommsRuntime).toHaveBeenCalledTimes(1)
    expect(mocks.startControlPlaneCache).toHaveBeenCalledTimes(1)
    expect(mocks.startTorghutQuantRuntime).toHaveBeenCalledTimes(1)
    expect(mocks.startWhitepaperFinalizeConsumer).toHaveBeenCalledTimes(1)
  })

  it('boots only Jangar agent-comms support for the legacy controllers profile', async () => {
    const { JANGAR_RUNTIME_PROFILES } = await import('../runtime-profile')
    const { ensureRuntimeStartup } = await import('../runtime-startup')

    ensureRuntimeStartup(JANGAR_RUNTIME_PROFILES.agentsControllers.startup)
    ensureRuntimeStartup(JANGAR_RUNTIME_PROFILES.agentsControllers.startup)

    expect(mocks.ensureAgentCommsRuntime).toHaveBeenCalledTimes(1)
    expect(mocks.startControlPlaneCache).not.toHaveBeenCalled()
    expect(mocks.startTorghutQuantRuntime).not.toHaveBeenCalled()
    expect(mocks.startWhitepaperFinalizeConsumer).not.toHaveBeenCalled()
  })

  it('boots only Jangar cache support for the legacy control-plane profile', async () => {
    const { JANGAR_RUNTIME_PROFILES } = await import('../runtime-profile')
    const { ensureRuntimeStartup } = await import('../runtime-startup')

    ensureRuntimeStartup(JANGAR_RUNTIME_PROFILES.agentsControlPlane.startup)
    ensureRuntimeStartup(JANGAR_RUNTIME_PROFILES.agentsControlPlane.startup)

    expect(mocks.ensureAgentCommsRuntime).not.toHaveBeenCalled()
    expect(mocks.startControlPlaneCache).toHaveBeenCalledTimes(1)
    expect(mocks.startTorghutQuantRuntime).not.toHaveBeenCalled()
    expect(mocks.startWhitepaperFinalizeConsumer).not.toHaveBeenCalled()
  })

  it('skips all startup side effects for the test profile', async () => {
    const { JANGAR_RUNTIME_PROFILES } = await import('../runtime-profile')
    const { ensureRuntimeStartup } = await import('../runtime-startup')

    ensureRuntimeStartup(JANGAR_RUNTIME_PROFILES.test.startup)

    expect(mocks.ensureAgentCommsRuntime).not.toHaveBeenCalled()
    expect(mocks.startControlPlaneCache).not.toHaveBeenCalled()
    expect(mocks.startTorghutQuantRuntime).not.toHaveBeenCalled()
    expect(mocks.startWhitepaperFinalizeConsumer).not.toHaveBeenCalled()
  })
})
