import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  buildAgentsControlPlaneStatus,
  getAgentsControlPlaneStatus,
  type AgentsControlPlaneStatusDependencies,
} from './control-plane-status'
import type { GrpcStatus } from './control-plane-grpc'
import type { ControlPlaneRuntimeEvidence } from './control-plane-runtime-evidence'

const now = new Date('2026-05-19T12:00:00.000Z')

const grpc: GrpcStatus = {
  enabled: false,
  address: '',
  status: 'disabled',
  message: 'gRPC disabled',
}

const leaderElection = {
  enabled: true,
  required: true,
  isLeader: true,
  leaseName: 'agents-control-plane',
  leaseNamespace: 'agents',
  identity: 'agents-0',
  lastTransitionAt: '2026-05-19T11:00:00.000Z',
  lastAttemptAt: '2026-05-19T11:59:00.000Z',
  lastSuccessAt: '2026-05-19T11:59:00.000Z',
  lastError: null,
}

const runtimeEvidence: ControlPlaneRuntimeEvidence = {
  workflows: {
    active_job_runs: 1,
    recent_failed_jobs: 1,
    backoff_limit_exceeded_jobs: 1,
    window_minutes: 60,
    top_failure_reasons: [{ reason: 'BackoffLimitExceeded', count: 1 }],
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

const healthyController = {
  enabled: true,
  started: true,
  namespaces: ['agents'],
  crdsReady: true,
  missingCrds: [],
  lastCheckedAt: '2026-05-19T11:58:00.000Z',
}

const deps: AgentsControlPlaneStatusDependencies = {
  now: () => now,
  env: { DATABASE_URL: 'postgres://agents-db' },
  getLeaderElectionStatus: () => leaderElection,
  getAgentsControllerHealth: () => ({
    ...healthyController,
    agentRunIngestion: [
      {
        namespace: 'agents',
        lastWatchEventAt: '2026-05-19T11:59:30.000Z',
        lastResyncAt: '2026-05-19T11:59:00.000Z',
        untouchedRunCount: 0,
        oldestUntouchedAgeSeconds: null,
      },
    ],
  }),
  getOrchestrationControllerHealth: () => healthyController,
  getSupportingControllerHealth: () => healthyController,
  assessAgentRunIngestion: (namespace) => ({
    namespace,
    lastWatchEventAt: '2026-05-19T11:59:30.000Z',
    lastResyncAt: '2026-05-19T11:59:00.000Z',
    untouchedRunCount: 0,
    oldestUntouchedAgeSeconds: null,
    status: 'healthy',
    message: 'AgentRun ingestion healthy',
    dispatchPaused: false,
  }),
  collectRuntimeEvidence: () => Effect.succeed(runtimeEvidence),
}

describe('buildAgentsControlPlaneStatus', () => {
  it('builds the generic Agents-owned status shape without domain placeholders', () => {
    const status = buildAgentsControlPlaneStatus(
      { namespace: 'agents', service: 'agents', grpc, now, runtimeEvidence },
      deps,
    )

    expect(status.service).toBe('agents')
    expect(status.generated_at).toBe('2026-05-19T12:00:00.000Z')
    expect(status.leader_election).toMatchObject({
      is_leader: true,
      lease_name: 'agents-control-plane',
      lease_namespace: 'agents',
      identity: 'agents-0',
    })
    expect(status.controllers[0]).toMatchObject({
      name: 'agents-controller',
      scope_namespaces: ['agents'],
      status: 'healthy',
      authority: { mode: 'local', namespace: 'agents', fresh: true },
    })
    expect(status.runtime_adapters.map((adapter) => adapter.name)).toEqual(['workflow', 'job', 'custom'])
    expect(status.database).toMatchObject({
      configured: true,
      connected: false,
      status: 'unknown',
      migration_consistency: { status: 'unknown' },
    })
    expect(status.agentrun_ingestion).toMatchObject({
      namespace: 'agents',
      status: 'healthy',
      untouched_run_count: 0,
    })
    expect(status.workflows).toMatchObject({
      active_job_runs: 1,
      data_confidence: 'high',
      top_failure_reasons: [{ reason: 'BackoffLimitExceeded', count: 1 }],
    })
    expect(status.rollout_health).toMatchObject({
      status: 'healthy',
      observed_deployments: 2,
    })
    expect(status.namespaces).toEqual([{ namespace: 'agents', status: 'healthy', degraded_components: [] }])
    expect(status).not.toHaveProperty('torghut_consumer_evidence')
    expect(status).not.toHaveProperty('dependency_quorum')
    expect(status).not.toHaveProperty('material_action_verdicts')
  })

  it('wraps status-service dependency failures in an Effect error', async () => {
    await expect(
      getAgentsControlPlaneStatus(
        { namespace: 'agents', service: 'agents' },
        {
          ...deps,
          resolveGrpcStatus: async () => {
            throw new Error('grpc probe failed')
          },
        },
      ),
    ).rejects.toThrow('grpc probe failed')
  })
})
