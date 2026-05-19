import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../config'

describe('resolveConfig', () => {
  it('defaults to kube mode even when address is set', () => {
    const { resolved, warnings } = resolveConfig({}, { address: '127.0.0.1:50051' })
    expect(resolved.mode).toBe('kube')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('ignores Jangar compatibility aliases for gRPC config', () => {
    const previousServer = process.env.AGENTCTL_SERVER
    const previousAgentctlAddress = process.env.AGENTCTL_ADDRESS
    const previousAgentctlToken = process.env.AGENTCTL_TOKEN
    const previousAddress = process.env.AGENTS_GRPC_ADDRESS
    const previousLegacyAddress = process.env.JANGAR_GRPC_ADDRESS
    const previousToken = process.env.AGENTS_GRPC_TOKEN
    const previousLegacyToken = process.env.JANGAR_GRPC_TOKEN
    try {
      delete process.env.AGENTCTL_SERVER
      delete process.env.AGENTCTL_ADDRESS
      delete process.env.AGENTCTL_TOKEN
      delete process.env.AGENTS_GRPC_ADDRESS
      process.env.JANGAR_GRPC_ADDRESS = 'jangar-grpc.jangar.svc.cluster.local:50051'
      delete process.env.AGENTS_GRPC_TOKEN
      process.env.JANGAR_GRPC_TOKEN = 'jangar-token'

      const { resolved } = resolveConfig({ grpc: true }, {})

      expect(resolved.address).toBe('agents-grpc.agents.svc.cluster.local:50051')
      expect(resolved.token).toBeUndefined()
    } finally {
      if (previousServer === undefined) delete process.env.AGENTCTL_SERVER
      else process.env.AGENTCTL_SERVER = previousServer
      if (previousAgentctlAddress === undefined) delete process.env.AGENTCTL_ADDRESS
      else process.env.AGENTCTL_ADDRESS = previousAgentctlAddress
      if (previousAgentctlToken === undefined) delete process.env.AGENTCTL_TOKEN
      else process.env.AGENTCTL_TOKEN = previousAgentctlToken
      if (previousAddress === undefined) delete process.env.AGENTS_GRPC_ADDRESS
      else process.env.AGENTS_GRPC_ADDRESS = previousAddress
      if (previousLegacyAddress === undefined) delete process.env.JANGAR_GRPC_ADDRESS
      else process.env.JANGAR_GRPC_ADDRESS = previousLegacyAddress
      if (previousToken === undefined) delete process.env.AGENTS_GRPC_TOKEN
      else process.env.AGENTS_GRPC_TOKEN = previousToken
      if (previousLegacyToken === undefined) delete process.env.JANGAR_GRPC_TOKEN
      else process.env.JANGAR_GRPC_TOKEN = previousLegacyToken
    }
  })
})
