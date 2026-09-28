import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
  createControlPlaneRuntimeEvidenceService,
  type DeploymentRolloutStatus,
  type WorkflowsReliabilityStatus,
} from './control-plane-runtime-evidence'
import type { KubeGatewayDeployment, KubeGatewayJob } from './kube-gateway'

const now = new Date('2026-05-20T12:00:00.000Z')

const job = (overrides: Partial<KubeGatewayJob>): KubeGatewayJob => ({
  metadata: {
    name: 'job-1',
    namespace: 'agents',
    generation: 1,
    labels: { 'agents.proompteng.ai/agent-run': 'run-1' },
    creationTimestamp: '2026-05-20T11:50:00.000Z',
  },
  status: {
    active: 0,
    failed: 0,
    startTime: '2026-05-20T11:50:00.000Z',
    completionTime: null,
    conditions: [],
  },
  ...overrides,
})

const deployment = (name: string, overrides: Partial<KubeGatewayDeployment> = {}): KubeGatewayDeployment => ({
  metadata: {
    name,
    namespace: 'agents',
    generation: 1,
    labels: {},
    creationTimestamp: '2026-05-20T11:00:00.000Z',
  },
  spec: { replicas: 1 },
  status: {
    readyReplicas: 1,
    availableReplicas: 1,
    updatedReplicas: 1,
    unavailableReplicas: 0,
    conditions: [
      { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable', lastTransitionTime: null },
      { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable', lastTransitionTime: null },
    ],
  },
  ...overrides,
})

describe('control-plane runtime evidence', () => {
  it('collects AgentRun job reliability and deployment rollout evidence through the injected kube gateway', async () => {
    const listJobs = vi.fn(async () => [
      job({
        status: { active: 1, failed: 0, startTime: '2026-05-20T11:59:00.000Z', completionTime: null, conditions: [] },
      }),
      job({
        metadata: {
          name: 'failed-job',
          namespace: 'agents',
          generation: 1,
          labels: { 'agents.proompteng.ai/agent-run': 'failed-run' },
          creationTimestamp: '2026-05-20T11:30:00.000Z',
        },
        status: {
          active: 0,
          failed: 1,
          startTime: '2026-05-20T11:30:00.000Z',
          completionTime: '2026-05-20T11:35:00.000Z',
          conditions: [
            {
              type: 'Failed',
              status: 'True',
              reason: 'BackoffLimitExceeded',
              lastTransitionTime: '2026-05-20T11:35:00.000Z',
            },
          ],
        },
      }),
    ])
    const listDeployments = vi.fn(async () => [
      deployment('agents'),
      deployment('agents-controllers', {
        status: {
          readyReplicas: 1,
          availableReplicas: 0,
          updatedReplicas: 1,
          unavailableReplicas: 1,
          conditions: [
            { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', lastTransitionTime: null },
            { type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated', lastTransitionTime: null },
          ],
        },
      }),
    ])

    const service = createControlPlaneRuntimeEvidenceService({
      env: {
        AGENTS_WORKFLOW_RELIABILITY_WINDOW_MINUTES: '45',
        AGENTS_CONTROL_PLANE_ROLLOUT_DEPLOYMENTS: 'agents,agents-controllers',
      },
      kubeGateway: { listJobs, listDeployments },
    })

    const result = await Effect.runPromise(service.collect({ namespace: 'agents', now }))

    expect(listJobs).toHaveBeenCalledWith('agents', 'agents.proompteng.ai/agent-run')
    expect(result.workflows).toMatchObject<Partial<WorkflowsReliabilityStatus>>({
      active_job_runs: 1,
      recent_failed_jobs: 1,
      backoff_limit_exceeded_jobs: 1,
      window_minutes: 45,
      data_confidence: 'high',
    })
    expect(result.workflows.top_failure_reasons).toEqual([{ reason: 'BackoffLimitExceeded', count: 1 }])
    expect(result.rolloutHealth).toMatchObject({
      status: 'degraded',
      observed_deployments: 2,
      degraded_deployments: 1,
      deployments: expect.arrayContaining([
        expect.objectContaining<Partial<DeploymentRolloutStatus>>({ name: 'agents', status: 'healthy' }),
        expect.objectContaining<Partial<DeploymentRolloutStatus>>({
          name: 'agents-controllers',
          status: 'degraded',
        }),
      ]),
    })
  })

  it('does not count failed pods on an active retrying Job as a terminal workflow failure', async () => {
    const listJobs = vi.fn(async () => [
      job({
        status: {
          active: 1,
          failed: 1,
          startTime: '2026-05-20T11:55:00.000Z',
          completionTime: null,
          conditions: [
            {
              type: 'FailureTarget',
              status: 'True',
              reason: 'FailedCreate',
              lastTransitionTime: '2026-05-20T11:56:00.000Z',
            },
          ],
        },
      }),
    ])
    const service = createControlPlaneRuntimeEvidenceService({
      kubeGateway: {
        listJobs,
        listDeployments: vi.fn(async () => [deployment('agents'), deployment('agents-controllers')]),
      },
    })

    const result = await Effect.runPromise(service.collect({ namespace: 'agents', now }))

    expect(result.workflows).toMatchObject({
      active_job_runs: 1,
      recent_failed_jobs: 0,
      backoff_limit_exceeded_jobs: 0,
      top_failure_reasons: [],
    })
  })

  it('downgrades workflow confidence when a namespace collection fails', async () => {
    const service = createControlPlaneRuntimeEvidenceService({
      env: { AGENTS_WORKFLOW_RELIABILITY_NAMESPACES: 'agents,agents-ci' },
      kubeGateway: {
        listJobs: vi.fn(async (namespace: string) => {
          if (namespace === 'agents-ci') throw new Error('forbidden')
          return []
        }),
        listDeployments: vi.fn(async () => [deployment('agents'), deployment('agents-controllers')]),
      },
    })

    const result = await Effect.runPromise(service.collect({ namespace: 'agents', now }))

    expect(result.workflows).toMatchObject({
      data_confidence: 'degraded',
      collection_errors: 1,
      collected_namespaces: 1,
      target_namespaces: 2,
    })
    expect(result.workflows.message).toContain('agents-ci: forbidden')
  })
})
