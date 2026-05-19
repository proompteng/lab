import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../config'

describe('resolveConfig', () => {
  it('defaults to kube mode even when address is set', () => {
    const { resolved, warnings } = resolveConfig({}, { address: '127.0.0.1:50051' })
    expect(resolved.mode).toBe('kube')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('prefers Agents gRPC env names over Jangar compatibility aliases', () => {
    const previousAddress = process.env.AGENTS_GRPC_ADDRESS
    const previousLegacyAddress = process.env.JANGAR_GRPC_ADDRESS
    const previousToken = process.env.AGENTS_GRPC_TOKEN
    const previousLegacyToken = process.env.JANGAR_GRPC_TOKEN
    try {
      process.env.AGENTS_GRPC_ADDRESS = 'agents-grpc.agents.svc.cluster.local:50051'
      process.env.JANGAR_GRPC_ADDRESS = 'jangar-grpc.jangar.svc.cluster.local:50051'
      process.env.AGENTS_GRPC_TOKEN = 'agents-token'
      process.env.JANGAR_GRPC_TOKEN = 'jangar-token'

      const { resolved } = resolveConfig({ grpc: true }, {})

      expect(resolved.address).toBe('agents-grpc.agents.svc.cluster.local:50051')
      expect(resolved.token).toBe('agents-token')
    } finally {
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
