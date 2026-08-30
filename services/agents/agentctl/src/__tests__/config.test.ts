import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../config'

describe('resolveConfig', () => {
  it('defaults to kube mode even when address is set', () => {
    const { resolved, warnings } = resolveConfig({}, { address: '127.0.0.1:50051' })
    expect(resolved.mode).toBe('kube')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('reads canonical Agents gRPC env config', () => {
    const previousServer = process.env.AGENTCTL_SERVER
    const previousAgentctlAddress = process.env.AGENTCTL_ADDRESS
    const previousAgentctlToken = process.env.AGENTCTL_TOKEN
    const previousAddress = process.env.AGENTS_GRPC_ADDRESS
    const previousToken = process.env.AGENTS_GRPC_TOKEN
    try {
      delete process.env.AGENTCTL_SERVER
      delete process.env.AGENTCTL_ADDRESS
      delete process.env.AGENTCTL_TOKEN
      process.env.AGENTS_GRPC_ADDRESS = 'agents-grpc.agents.svc.cluster.local:50051'
      process.env.AGENTS_GRPC_TOKEN = 'agents-token'

      const { resolved } = resolveConfig({ grpc: true }, {})

      expect(resolved.address).toBe('agents-grpc.agents.svc.cluster.local:50051')
      expect(resolved.token).toBe('agents-token')
    } finally {
      if (previousServer === undefined) delete process.env.AGENTCTL_SERVER
      else process.env.AGENTCTL_SERVER = previousServer
      if (previousAgentctlAddress === undefined) delete process.env.AGENTCTL_ADDRESS
      else process.env.AGENTCTL_ADDRESS = previousAgentctlAddress
      if (previousAgentctlToken === undefined) delete process.env.AGENTCTL_TOKEN
      else process.env.AGENTCTL_TOKEN = previousAgentctlToken
      if (previousAddress === undefined) delete process.env.AGENTS_GRPC_ADDRESS
      else process.env.AGENTS_GRPC_ADDRESS = previousAddress
      if (previousToken === undefined) delete process.env.AGENTS_GRPC_TOKEN
      else process.env.AGENTS_GRPC_TOKEN = previousToken
    }
  })
})
