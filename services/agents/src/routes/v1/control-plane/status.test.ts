import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'

import type { AgentsControlPlaneStatusDependencies } from '../../../server/control-plane-status'
import type { GrpcStatus } from '../../../server/control-plane-grpc'
import type { ControlPlaneRuntimeEvidence } from '../../../server/control-plane-runtime-evidence'
import type { ControlPlaneWatchReliability } from '../../../server/control-plane-status-contract'
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

const runtimeEvidence: ControlPlaneRuntimeEvidence = {
  workflows: {
    active_job_runs: 2,
    recent_failed_jobs: 0,
    backoff_limit_exceeded_jobs: 0,
    window_minutes: 60,
    top_failure_reasons: [],
    data_confidence: 'high',
    collection_errors: 0,
    collected_namespaces: 1,
    target_namespaces: 1,
    message: '1 namespace(s) collected for AgentRun job evidence',
  },
  rolloutHealth: {
    status: 'healthy',
    observed_deployments: 2,
    degraded_deployments: 0,
    deployments: [],
    message: '2 configured deployment(s) healthy',
  },
}

const watchReliability: ControlPlaneWatchReliability = {
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 1,
  total_events: 4,
  total_errors: 0,
  total_restarts: 0,
  streams: [
    {
      resource: 'agentruns.agents.proompteng.ai',
      namespace: 'agents',
      events: 4,
      errors: 0,
      restarts: 0,
      last_seen_at: '2026-05-19T11:59:45.000Z',
    },
  ],
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
  collectRuntimeEvidence: () => Effect.succeed(runtimeEvidence),
  collectWatchReliability: () => Effect.succeed(watchReliability),
}

describe('control-plane status route', () => {
  it('serves the Agents-owned generic status contract', async () => {
    const response = await buildControlPlaneStatusResponse(
      new Request('http://agents.test/v1/control-plane/status?namespace=platform'),
      deps,
    )

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toMatchObject({
      service: 'agents',
      generated_at: '2026-05-19T12:00:00.000Z',
      controllers: expect.arrayContaining([expect.objectContaining({ name: 'agents-controller' })]),
      agentrun_ingestion: { namespace: 'platform' },
      control_plane_controller_witness: {
        namespace: 'platform',
        controller_self_report_current: true,
      },
      workflows: { active_job_runs: 2, data_confidence: 'high' },
      rollout_health: { status: 'healthy', observed_deployments: 2 },
      watch_reliability: { status: 'healthy', observed_streams: 1, total_events: 4 },
      namespaces: expect.arrayContaining([expect.objectContaining({ namespace: 'platform', status: 'healthy' })]),
    })
  })

  it('ignores legacy projection parameters and serves the full Agents-owned contract', async () => {
    const response = await buildControlPlaneStatusResponse(
      new Request('http://agents.test/v1/control-plane/status?namespace=agents&view=schedule-runner'),
      deps,
    )

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toMatchObject({
      service: 'agents',
      runtime_kits: expect.arrayContaining([expect.objectContaining({ kit_class: 'serving' })]),
      admission_passports: expect.arrayContaining([expect.objectContaining({ consumer_class: 'serving' })]),
      controllers: expect.arrayContaining([expect.objectContaining({ name: 'agents-controller' })]),
      database: expect.any(Object),
    })
    expect(payload).not.toHaveProperty('stage_clearance_packets')
    expect(payload).not.toHaveProperty('torghut_consumer_evidence')
    expect(payload).not.toHaveProperty('dependency_quorum')
  })
})
