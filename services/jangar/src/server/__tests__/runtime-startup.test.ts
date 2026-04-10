import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureAgentCommsRuntime: vi.fn(),
  startAgentctlGrpcServer: vi.fn(() => null),
  startControlPlaneCache: vi.fn(async () => {}),
  startTorghutQuantRuntime: vi.fn(),
}))

vi.mock('../agent-comms-runtime', () => ({
  ensureAgentCommsRuntime: mocks.ensureAgentCommsRuntime,
}))

vi.mock('../agentctl-grpc', () => ({
  startAgentctlGrpcServer: mocks.startAgentctlGrpcServer,
}))

vi.mock('../control-plane-cache', () => ({
  startControlPlaneCache: mocks.startControlPlaneCache,
}))

vi.mock('../torghut-quant-runtime', () => ({
  startTorghutQuantRuntime: mocks.startTorghutQuantRuntime,
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
    expect(mocks.startAgentctlGrpcServer).toHaveBeenCalledTimes(1)
  })

  it('skips all startup side effects for the test profile', async () => {
    const { JANGAR_RUNTIME_PROFILES } = await import('../runtime-profile')
    const { ensureRuntimeStartup } = await import('../runtime-startup')

    ensureRuntimeStartup(JANGAR_RUNTIME_PROFILES.test.startup)

    expect(mocks.ensureAgentCommsRuntime).not.toHaveBeenCalled()
    expect(mocks.startControlPlaneCache).not.toHaveBeenCalled()
    expect(mocks.startTorghutQuantRuntime).not.toHaveBeenCalled()
    expect(mocks.startAgentctlGrpcServer).not.toHaveBeenCalled()
  })
})
