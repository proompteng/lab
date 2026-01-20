import { describe, expect, it } from 'vitest'

import { buildControlPlaneStatus } from '~/server/control-plane-status'

type HealthOverrides = Partial<{
  enabled: boolean
  started: boolean
  crdsReady: boolean | null
  missingCrds: string[]
  lastCheckedAt: string | null
}>

const createHealth = (overrides: HealthOverrides = {}) => ({
  enabled: true,
  started: true,
  crdsReady: true,
  missingCrds: [],
  lastCheckedAt: null,
  ...overrides,
})

describe('control plane status', () => {
  it('returns healthy status when all components are healthy', async () => {
    const now = new Date('2026-01-19T01:02:03.456Z')
    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        service: 'jangar',
        grpc: {
          enabled: true,
          address: '127.0.0.1:50051',
          status: 'healthy',
          message: '',
        },
      },
      {
        now: () => now,
        getAgentsControllerHealth: () => createHealth(),
        getSupportingControllerHealth: () => createHealth(),
        getOrchestrationControllerHealth: () => createHealth(),
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: true,
          status: 'configured',
          message: 'temporal configuration resolved',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: true,
          connected: true,
          status: 'healthy',
          message: '',
          latency_ms: 12,
        }),
      },
    )

    expect(status.service).toBe('jangar')
    expect(status.generated_at).toBe('2026-01-19T01:02:03.456Z')
    expect(status.controllers).toHaveLength(3)
    expect(status.runtime_adapters).toHaveLength(4)
    expect(status.database.status).toBe('healthy')
    expect(status.grpc.status).toBe('healthy')
    expect(status.namespaces[0].status).toBe('healthy')
    expect(status.namespaces[0].degraded_components).toHaveLength(0)
  })

  it('marks degraded components when controllers or dependencies are unhealthy', async () => {
    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        service: 'jangar',
        grpc: {
          enabled: true,
          address: '127.0.0.1:50051',
          status: 'degraded',
          message: 'grpc not listening',
        },
      },
      {
        getAgentsControllerHealth: () => createHealth({ started: false }),
        getSupportingControllerHealth: () => createHealth({ enabled: false }),
        getOrchestrationControllerHealth: () => createHealth(),
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: false,
          status: 'degraded',
          message: 'temporal unreachable',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: true,
          connected: false,
          status: 'degraded',
          message: 'database timeout',
          latency_ms: 250,
        }),
      },
    )

    expect(status.namespaces[0].status).toBe('degraded')
    expect(status.namespaces[0].degraded_components).toHaveLength(7)
    expect(status.namespaces[0].degraded_components).toEqual(
      expect.arrayContaining([
        'agents-controller',
        'supporting-controller',
        'runtime:workflow',
        'runtime:job',
        'runtime:temporal',
        'database',
        'grpc',
      ]),
    )
  })
})
