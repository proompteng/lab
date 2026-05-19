import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startAgentctlGrpcServer } from './agentctl-grpc'

const ORIGINAL_ENV = { ...process.env }

describe('agentctl gRPC runtime logging', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env = { ...ORIGINAL_ENV }
    delete process.env.AGENTS_RUNTIME_SERVICE
    delete process.env.JANGAR_GRPC_ENABLED
    delete process.env.AGENTS_GRPC_ENABLED
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = { ...ORIGINAL_ENV }
  })

  it('uses Agents log labels in Agents runtime mode', () => {
    process.env.AGENTS_RUNTIME_SERVICE = 'agents'
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(startAgentctlGrpcServer()).toBeNull()

    expect(info).toHaveBeenCalledWith('[agents] agentctl grpc disabled for control plane')
  })

  it('keeps legacy Jangar labels outside Agents runtime mode', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(startAgentctlGrpcServer()).toBeNull()

    expect(info).toHaveBeenCalledWith('[jangar] agentctl grpc disabled for control plane')
  })
})
