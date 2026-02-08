import { describe, expect, it } from 'vitest'

import { buildControlPlaneStatus } from '~/server/control-plane-status'

const healthyController = {
  enabled: true,
  started: true,
  namespaces: ['agents'],
  crdsReady: true,
  missingCrds: [],
  lastCheckedAt: '2026-01-20T00:00:00Z',
}

describe('control-plane status', () => {
  it('returns healthy summary when components are healthy', async () => {
    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        grpc: {
          enabled: true,
          address: '127.0.0.1:50051',
          status: 'healthy',
          message: '',
        },
      },
      {
        now: () => new Date('2026-01-20T00:00:00Z'),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: true,
          status: 'configured',
          message: '',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: true,
          connected: true,
          status: 'healthy',
          message: '',
          latency_ms: 4,
        }),
      },
    )

    expect(status.service).toBe('jangar')
    expect(status.controllers).toHaveLength(3)
    expect(status.runtime_adapters).toHaveLength(4)
    expect(status.namespaces).toHaveLength(1)
    expect(status.namespaces[0]?.status).toBe('healthy')
    expect(status.namespaces[0]?.degraded_components ?? []).toHaveLength(0)
  })

  it('marks degraded components when controllers or database fail', async () => {
    const degradedController = {
      enabled: true,
      started: false,
      namespaces: ['agents'],
      crdsReady: false,
      missingCrds: ['agents.agents.proompteng.ai'],
      lastCheckedAt: '2026-01-20T00:00:00Z',
    }

    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        grpc: {
          enabled: false,
          address: '',
          status: 'disabled',
          message: 'gRPC disabled',
        },
      },
      {
        now: () => new Date('2026-01-20T00:00:00Z'),
        getAgentsControllerHealth: () => degradedController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: false,
          status: 'degraded',
          message: 'missing config',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: false,
          connected: false,
          status: 'disabled',
          message: 'DATABASE_URL not set',
          latency_ms: 0,
        }),
      },
    )

    const degraded = status.namespaces[0]?.degraded_components ?? []
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(degraded).toContain('agents-controller')
    expect(degraded).toContain('runtime:temporal')
    expect(degraded).toContain('database')
    expect(degraded).not.toContain('grpc')
  })
})
