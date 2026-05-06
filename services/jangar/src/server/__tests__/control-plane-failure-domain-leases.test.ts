import { describe, expect, it } from 'vitest'

import {
  buildFailureDomainLeaseSet,
  emptyFailureDomainKubernetesEvidence,
  type FailureDomainRouteProbe,
} from '~/server/control-plane-failure-domain-leases'
import type { ControlPlaneRolloutHealth, DatabaseStatus } from '~/server/control-plane-status-types'
import type { KubeGatewayEvent, KubeGatewayPod } from '~/server/kube-gateway'
import type {
  DatabaseMigrationConsistency,
  RuntimeKitStatus,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'

const now = new Date('2026-05-05T12:00:00.000Z')

const healthyMigrationConsistency: DatabaseMigrationConsistency = {
  status: 'healthy',
  migration_table: 'kysely_migration',
  registered_count: 25,
  applied_count: 25,
  unapplied_count: 0,
  unexpected_count: 0,
  latest_registered: '20260418_embedding_dimension_4096',
  latest_applied: '20260418_embedding_dimension_4096',
  missing_migrations: [],
  unexpected_migrations: [],
  message: '',
}

const databaseStatus = (overrides: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
  configured: true,
  connected: true,
  status: 'healthy',
  message: '',
  latency_ms: 3,
  migration_consistency: healthyMigrationConsistency,
  ...overrides,
})

const routeProbe = (overrides: Partial<FailureDomainRouteProbe> = {}): FailureDomainRouteProbe => ({
  status: 'healthy',
  reachable: true,
  url: 'http://jangar.jangar.svc.cluster.local/health',
  status_code: 200,
  latency_ms: 5,
  message: 'route probe succeeded',
  observed_at: now.toISOString(),
  ...overrides,
})

const rolloutHealth = (overrides: Partial<ControlPlaneRolloutHealth> = {}): ControlPlaneRolloutHealth => ({
  status: 'healthy',
  observed_deployments: 1,
  degraded_deployments: 0,
  deployments: [
    {
      name: 'agents',
      namespace: 'agents',
      status: 'healthy',
      desired_replicas: 1,
      ready_replicas: 1,
      available_replicas: 1,
      updated_replicas: 1,
      unavailable_replicas: 0,
      message: 'deployment rollout healthy',
    },
  ],
  message: '1 configured deployment(s) healthy',
  ...overrides,
})

const workflows = (overrides: Partial<WorkflowsReliabilityStatus> = {}): WorkflowsReliabilityStatus => ({
  active_job_runs: 0,
  recent_failed_jobs: 0,
  backoff_limit_exceeded_jobs: 0,
  window_minutes: 15,
  top_failure_reasons: [],
  data_confidence: 'high',
  collection_errors: 0,
  collected_namespaces: 1,
  target_namespaces: 1,
  message: '',
  ...overrides,
})

const runtimeKit = (overrides: Partial<RuntimeKitStatus> = {}): RuntimeKitStatus => ({
  runtime_kit_id: 'runtime-kit:collaboration:1',
  kit_class: 'collaboration',
  subject_ref: 'jangar:codex:nats-collaboration',
  image_ref: 'runtime:local',
  workspace_contract_version: 'shadow-v1',
  component_digest: 'digest-collaboration',
  decision: 'healthy',
  observed_at: now.toISOString(),
  fresh_until: '2026-05-05T12:05:00.000Z',
  producer_revision: 'shadow-v1',
  reason_codes: [],
  components: [],
  ...overrides,
})

const pod = (overrides: Partial<KubeGatewayPod> = {}): KubeGatewayPod => ({
  metadata: {
    name: 'agents-0',
    namespace: 'agents',
    generation: 1,
    labels: {},
    creationTimestamp: '2026-05-05T11:55:00.000Z',
  },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'True', reason: null, lastTransitionTime: null }],
    containerStatuses: [{ name: 'app', image: 'jangar:test', ready: true, state: { running: true } }],
  },
  ...overrides,
})

const event = (overrides: Partial<KubeGatewayEvent> = {}): KubeGatewayEvent => ({
  metadata: {
    name: 'event-1',
    namespace: 'agents',
    generation: null,
    labels: {},
    creationTimestamp: '2026-05-05T11:59:00.000Z',
  },
  type: 'Warning',
  reason: 'Failed',
  message: '',
  firstTimestamp: '2026-05-05T11:59:00.000Z',
  lastTimestamp: '2026-05-05T11:59:00.000Z',
  eventTime: null,
  involvedObject: {
    kind: 'Pod',
    name: 'agents-0',
    namespace: 'agents',
  },
  ...overrides,
})

const leaseSet = (overrides: Partial<Parameters<typeof buildFailureDomainLeaseSet>[0]> = {}) =>
  buildFailureDomainLeaseSet({
    now,
    namespace: 'agents',
    service: 'jangar',
    database: databaseStatus(),
    routeProbe: routeProbe(),
    rolloutHealth: rolloutHealth(),
    workflows: workflows(),
    runtimeKits: [runtimeKit()],
    kubernetesEvidence: emptyFailureDomainKubernetesEvidence(),
    ...overrides,
  })

const findLease = (leases: ReturnType<typeof leaseSet>['leases'], domain: string) =>
  leases.find((lease) => lease.domain === domain)

const findHoldback = (holdbacks: ReturnType<typeof leaseSet>['holdbacks'], actionClass: string) =>
  holdbacks.find((holdback) => holdback.action_class === actionClass)

describe('failure-domain lease synthesis', () => {
  it('expires the database lease on service refusal and keeps source schema unknown', () => {
    const result = leaseSet({
      database: databaseStatus({
        connected: false,
        status: 'degraded',
        message: 'connect ECONNREFUSED 10.98.225.178:5432',
      }),
    })

    expect(findLease(result.leases, 'database')).toMatchObject({
      status: 'expired',
      reason_codes: ['database.service_refused'],
    })
    expect(findLease(result.leases, 'source_schema')).toMatchObject({
      status: 'unknown',
      reason_codes: ['source_schema.database_unroutable'],
    })
    expect(findHoldback(result.holdbacks, 'dispatch_normal')).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['database.service_refused', 'source_schema.database_unroutable']),
    })
  })

  it('does not issue a valid database lease when a CNPG pod is terminating under DisruptionTarget', () => {
    const result = leaseSet({
      kubernetesEvidence: {
        pods: [
          pod({
            metadata: {
              name: 'jangar-db-1',
              namespace: 'jangar',
              generation: 1,
              labels: { 'cnpg.io/cluster': 'jangar-db' },
              creationTimestamp: '2026-05-05T11:00:00.000Z',
              deletionTimestamp: '2026-05-05T11:59:00.000Z',
            },
            status: {
              phase: 'Running',
              conditions: [
                { type: 'Ready', status: 'False', reason: null, lastTransitionTime: null },
                { type: 'DisruptionTarget', status: 'True', reason: null, lastTransitionTime: null },
              ],
              containerStatuses: [{ name: 'postgres', image: 'postgres:test', ready: true, state: { running: true } }],
            },
          }),
          pod({
            metadata: {
              name: 'torghut-quant-verify-sched-cron-29634232-db7gp',
              namespace: 'agents',
              generation: 1,
              labels: {
                'agents.proompteng.ai/agent-run': 'torghut-quant-verify-sched-cron-29634232',
                'agents.proompteng.ai/runtime': 'codex',
              },
              creationTimestamp: '2026-05-05T11:55:00.000Z',
            },
            status: {
              phase: 'Failed',
              conditions: [{ type: 'Ready', status: 'False', reason: null, lastTransitionTime: null }],
              containerStatuses: [
                {
                  name: 'agent',
                  image: 'jangar:test',
                  ready: false,
                  state: { terminated: { reason: 'Error', message: null, exitCode: 1 } },
                },
              ],
            },
          }),
        ],
        events: [],
        collection_errors: [],
      },
    })

    expect(findLease(result.leases, 'database')).toMatchObject({
      status: 'expired',
      reason_codes: expect.arrayContaining([
        'database.pod_disruption_target',
        'database.pod_terminating',
        'database.container_ready_pod_not_ready',
      ]),
    })
  })

  it('does not treat arbitrary runner pod suffixes containing db as database evidence', () => {
    const result = leaseSet({
      kubernetesEvidence: {
        pods: [
          pod({
            metadata: {
              name: 'jangar-control-plane-plan-sched-cron-29634020-cndb7',
              namespace: 'agents',
              generation: 1,
              labels: {
                'agents.proompteng.ai/agent-run': 'jangar-control-plane-plan-sched-cron-29634020',
                'agents.proompteng.ai/runtime': 'codex',
              },
              creationTimestamp: '2026-05-05T11:55:00.000Z',
            },
            status: {
              phase: 'Running',
              conditions: [{ type: 'Ready', status: 'False', reason: null, lastTransitionTime: null }],
              containerStatuses: [{ name: 'agent', image: 'jangar:test', ready: true, state: { running: true } }],
            },
          }),
          pod({
            metadata: {
              name: 'jangar-control-plane-plan-sched-zczg7-step-1-attempt-1-4dbnk',
              namespace: 'agents',
              generation: 1,
              labels: {
                'agents.proompteng.ai/agent-run': 'jangar-control-plane-plan-sched-zczg7',
                'agents.proompteng.ai/runtime': 'codex',
              },
              creationTimestamp: '2026-05-05T11:55:00.000Z',
            },
            status: {
              phase: 'Running',
              conditions: [{ type: 'Ready', status: 'False', reason: null, lastTransitionTime: null }],
              containerStatuses: [{ name: 'agent', image: 'jangar:test', ready: true, state: { running: true } }],
            },
          }),
        ],
        events: [],
        collection_errors: [],
      },
    })

    expect(findLease(result.leases, 'database')).toMatchObject({
      status: 'valid',
      reason_codes: [],
      evidence_refs: ['database:probe:select_1'],
    })
    expect(findLease(result.leases, 'source_schema')).toMatchObject({
      status: 'valid',
      reason_codes: [],
    })
    expect(findHoldback(result.holdbacks, 'merge_ready')).toMatchObject({
      decision: 'allow',
      reason_codes: [],
    })
  })

  it('holds normal dispatch and Torghut capital on route refusal while repair dispatch remains allowed', () => {
    const result = leaseSet({
      routeProbe: routeProbe({
        status: 'degraded',
        reachable: false,
        status_code: null,
        message: 'connect ECONNREFUSED 10.96.10.20:80',
      }),
    })

    expect(findLease(result.leases, 'route')).toMatchObject({
      status: 'expired',
      reason_codes: ['route.unreachable'],
    })
    expect(findHoldback(result.holdbacks, 'dispatch_normal')).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['route.unreachable']),
    })
    expect(findHoldback(result.holdbacks, 'torghut_capital')).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['route.unreachable']),
    })
    expect(findHoldback(result.holdbacks, 'dispatch_repair')).toMatchObject({
      decision: 'allow',
      reason_codes: [],
    })
  })

  it('holds deploy widening on image pull failures and normal dispatch on missing ConfigMaps', () => {
    const result = leaseSet({
      kubernetesEvidence: {
        pods: [
          pod({
            metadata: {
              name: 'agents-78f6cc44f6-z9rsl',
              namespace: 'agents',
              generation: 1,
              labels: { app: 'agents' },
              creationTimestamp: '2026-05-05T11:55:00.000Z',
            },
            status: {
              phase: 'Pending',
              conditions: [{ type: 'Ready', status: 'False', reason: null, lastTransitionTime: null }],
              containerStatuses: [
                {
                  name: 'agents',
                  image: 'registry.ide-newton.ts.net/lab/jangar-control-plane:86423d3e',
                  ready: false,
                  state: { waiting: { reason: 'ImagePullBackOff', message: 'failed to pull image' } },
                },
              ],
            },
          }),
        ],
        events: [
          event({
            metadata: {
              name: 'missing-configmap',
              namespace: 'agents',
              generation: null,
              labels: {},
              creationTimestamp: '2026-05-05T11:59:00.000Z',
            },
            reason: 'FailedMount',
            message: 'configmap "jangar-control-plane-verify-inputs" not found',
          }),
        ],
        collection_errors: [],
      },
    })

    expect(findLease(result.leases, 'registry')).toMatchObject({
      status: 'expired',
      reason_codes: ['registry.image_pull_timeout'],
    })
    expect(findLease(result.leases, 'workflow_artifact')).toMatchObject({
      status: 'expired',
      reason_codes: ['workflow_artifact.configmap_missing'],
    })
    expect(findHoldback(result.holdbacks, 'deploy_widen')).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['registry.image_pull_timeout']),
    })
    expect(findHoldback(result.holdbacks, 'dispatch_normal')).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['workflow_artifact.configmap_missing']),
    })
  })
})
