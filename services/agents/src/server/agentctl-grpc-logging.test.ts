import { status as GrpcStatus, type ServerWritableStream } from '@grpc/grpc-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startAgentctlGrpcServer, streamAgentRunLogs } from './agentctl-grpc'

const ORIGINAL_ENV = { ...process.env }

describe('agentctl gRPC runtime logging', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env = { ...ORIGINAL_ENV }
    delete process.env.AGENTS_RUNTIME_SERVICE
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

  it('uses Agents log labels without runtime identity env', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(startAgentctlGrpcServer()).toBeNull()

    expect(info).toHaveBeenCalledWith('[agents] agentctl grpc disabled for control plane')
  })

  it('returns INTERNAL when AgentRun lookup fails before log streaming starts', async () => {
    const destroy = vi.fn()
    const call = {
      request: { namespace: 'agents', name: 'run-a', follow: false },
      metadata: { get: () => [] },
      destroy,
    } as unknown as ServerWritableStream<{ namespace?: string; name?: string; follow?: boolean }, unknown>
    const kube = {
      get: vi.fn(async () => {
        throw new Error('kubernetes API unavailable')
      }),
    }

    await streamAgentRunLogs(call, kube as never)

    expect(destroy).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'kubernetes API unavailable',
        code: GrpcStatus.INTERNAL,
      }),
    )
  })
})
