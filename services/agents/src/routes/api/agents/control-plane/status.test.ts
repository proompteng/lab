import { describe, expect, it } from 'vitest'

import type { AgentsControlPlaneStatusDependencies } from '../../../../server/control-plane-status'
import type { GrpcStatus } from '../../../../server/control-plane-grpc'
import { buildControlPlaneStatusResponse } from './status'

const grpc: GrpcStatus = {
  enabled: false,
  address: '',
  status: 'disabled',
  message: 'gRPC disabled',
}

const healthyController = {
  enabled: true,
  started: true,
  namespaces: ['agents'],
  crdsReady: true,
  missingCrds: [],
  lastCheckedAt: '2026-05-19T11:58:00.000Z',
}

const deps: AgentsControlPlaneStatusDependencies = {
  now: () => new Date('2026-05-19T12:00:00.000Z'),
  env: {},
  resolveGrpcStatus: async () => grpc,
  getLeaderElectionStatus: () => ({
    enabled: false,
    required: false,
    isLeader: true,
    leaseName: '',
    leaseNamespace: 'agents',
    identity: 'agents-test',
    lastTransitionAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  }),
  getAgentsControllerHealth: () => ({ ...healthyController, agentRunIngestion: [] }),
  getOrchestrationControllerHealth: () => healthyController,
  getSupportingControllerHealth: () => healthyController,
  assessAgentRunIngestion: (namespace) => ({
    namespace,
    lastWatchEventAt: null,
    lastResyncAt: null,
    untouchedRunCount: 0,
    oldestUntouchedAgeSeconds: null,
    status: 'healthy',
    message: 'AgentRun ingestion healthy',
    dispatchPaused: false,
  }),
}

describe('control-plane status route', () => {
  it('serves the Agents-owned generic status contract', async () => {
    const response = await buildControlPlaneStatusResponse(
      new Request('http://agents.test/api/agents/control-plane/status?namespace=workflow'),
      deps,
    )

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toMatchObject({
      service: 'agents',
      generated_at: '2026-05-19T12:00:00.000Z',
      controllers: expect.arrayContaining([expect.objectContaining({ name: 'agents-controller' })]),
      agentrun_ingestion: { namespace: 'workflow' },
      namespaces: expect.arrayContaining([expect.objectContaining({ namespace: 'workflow', status: 'healthy' })]),
    })
  })

  it('ignores legacy projection parameters and serves the full Agents-owned contract', async () => {
    const response = await buildControlPlaneStatusResponse(
      new Request('http://agents.test/api/agents/control-plane/status?namespace=agents&view=schedule-runner'),
      deps,
    )

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toMatchObject({
      service: 'agents',
      runtime_kits: [],
      admission_passports: [],
      stage_clearance_packets: [],
      controllers: expect.arrayContaining([expect.objectContaining({ name: 'agents-controller' })]),
      database: expect.any(Object),
    })
  })
})
