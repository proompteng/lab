import { afterEach, describe, expect, it, vi } from 'vitest'

import { AUTHORITY_PROVENANCE_SETTLEMENT_DESIGN_ARTIFACT } from '~/server/control-plane-authority-provenance-settlement'
import {
  buildControlPlaneStatus,
  buildExecutionTrust,
  projectControlPlaneStatus,
  type DatabaseStatus as ControlPlaneDatabaseStatus,
} from '~/server/control-plane-status'
import { CLEARANCE_MARKET_DESIGN_ARTIFACT } from '~/server/control-plane-clearance-market'
import { CONTROLLER_INGESTION_SETTLEMENT_DESIGN_ARTIFACT } from '~/server/control-plane-controller-ingestion-settlement'
import { CONSUMER_EVIDENCE_LEASES_DESIGN_ARTIFACT } from '~/server/control-plane-consumer-evidence-leases'
import { EVIDENCE_PRESSURE_LEDGER_DESIGN_ARTIFACT } from '~/server/control-plane-evidence-pressure-ledger'
import { MATERIAL_EVIDENCE_SETTLEMENT_DESIGN_ARTIFACT } from '~/server/control-plane-material-evidence-settlement'
import { MATERIAL_REENTRY_CLEARINGHOUSE_DESIGN_ARTIFACT } from '~/server/control-plane-material-reentry-clearinghouse'
import { READY_TRUTH_ARBITER_DESIGN_ARTIFACT } from '~/server/control-plane-ready-truth-arbiter'
import { ROLLOUT_PROOF_PASSPORT_DESIGN_ARTIFACT } from '~/server/control-plane-rollout-proof-passport'
import { SOURCE_SERVING_CONTRACT_VERDICT_DESIGN_ARTIFACT } from '~/server/control-plane-source-serving-contract-verdict'
import { STAGE_CREDIT_LEDGER_DESIGN_ARTIFACT } from '~/server/control-plane-stage-credit-ledger'
import { TERMINAL_DEBT_COMPACTION_DESIGN_ARTIFACT } from '~/server/control-plane-terminal-debt-compaction'
import * as kubeGatewayModule from '~/server/kube-gateway'
import type {
  ControlPlaneHeartbeatRow,
  ControlPlaneHeartbeatStoreGetInput,
} from '~/server/control-plane-heartbeat-store'
import type { KubeGateway, KubeGatewayDeployment, KubeGatewayPod, KubeGatewaySwarm } from '~/server/kube-gateway'
import type {
  AdmissionPassportStatus,
  ControlPlaneWatchReliability,
  DatabaseMigrationConsistency,
  ExecutionTrustStage,
  ExecutionTrustStatus,
  ExecutionTrustSwarm,
  ProjectionWatermarkStatus,
  RecoveryWarrantStatus,
  RuntimeProofCellStatus,
  RuntimeKitStatus,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import { getRegisteredMigrationNames } from '~/server/kysely-migrations'

const createTestKubeGateway = (overrides: Partial<KubeGateway> = {}): KubeGateway => ({
  listDeployments: vi.fn(async () => []),
  listAgentRuns: vi.fn(async () => []),
  listJobs: vi.fn(async () => []),
  listPods: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => []),
  listCustomResourceDefinitions: vi.fn(async () => []),
  getLease: vi.fn(async () => null),
  createLease: vi.fn(async () => {
    throw new Error('not implemented in test gateway')
  }),
  replaceLease: vi.fn(async () => {
    throw new Error('not implemented in test gateway')
  }),
  probeNamespacedResource: vi.fn(async () => 'ok' as const),
  serviceExists: vi.fn(async () => true),
  listSwarms: vi.fn(async () => []),
  ...overrides,
})

let currentKubeGateway: KubeGateway = createTestKubeGateway()

const setKubeGateway = (gateway: KubeGateway) => {
  currentKubeGateway = gateway
  return gateway
}

const setRolloutDeploymentList = (items: KubeGatewayDeployment[] = [], pods: KubeGatewayPod[] = []) =>
  setKubeGateway(
    createTestKubeGateway({
      listDeployments: vi.fn(async () => items),
      listPods: vi.fn(async () => pods),
    }),
  )

const healthyRuntimePod = (image = 'runtime:local'): KubeGatewayPod => ({
  metadata: {
    name: 'jangar-0',
    namespace: 'agents',
    generation: 1,
    labels: {},
    creationTimestamp: '2026-01-20T00:00:00Z',
  },
  status: {
    phase: 'Running',
    conditions: [],
    containerStatuses: [
      {
        name: 'app',
        image,
        image_id: image,
        ready: true,
        state: { running: true },
      },
    ],
  },
})

const healthyRolloutDeployment: KubeGatewayDeployment = {
  metadata: {
    name: 'agents',
    namespace: 'agents',
    generation: 1,
    labels: {},
    creationTimestamp: '2026-01-20T00:00:00Z',
  },
  spec: { replicas: 1 },
  status: {
    readyReplicas: 1,
    availableReplicas: 1,
    updatedReplicas: 1,
    unavailableReplicas: 0,
    conditions: [
      { type: 'Available', status: 'True', reason: null, lastTransitionTime: null },
      { type: 'Progressing', status: 'True', reason: null, lastTransitionTime: null },
    ],
  },
}

const unavailableAgentsRolloutDeployment: KubeGatewayDeployment = {
  ...healthyRolloutDeployment,
  status: {
    readyReplicas: 0,
    availableReplicas: 0,
    updatedReplicas: 1,
    unavailableReplicas: 1,
    conditions: [
      { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', lastTransitionTime: null },
      { type: 'Progressing', status: 'True', reason: null, lastTransitionTime: null },
    ],
  },
}

const healthyAgentsControllersRolloutDeployment: KubeGatewayDeployment = {
  metadata: {
    name: 'agents-controllers',
    namespace: 'agents',
    generation: 1,
    labels: {},
    creationTimestamp: '2026-01-20T00:00:00Z',
  },
  spec: { replicas: 1 },
  status: {
    readyReplicas: 1,
    availableReplicas: 1,
    updatedReplicas: 1,
    unavailableReplicas: 0,
    conditions: [
      { type: 'Available', status: 'True', reason: null, lastTransitionTime: null },
      { type: 'Progressing', status: 'True', reason: null, lastTransitionTime: null },
    ],
  },
}

const availableButDegradedAgentsControllersRolloutDeployment: KubeGatewayDeployment = {
  metadata: {
    name: 'agents-controllers',
    namespace: 'agents',
    generation: 1,
    labels: {},
    creationTimestamp: '2026-01-20T00:00:00Z',
  },
  spec: { replicas: 2 },
  status: {
    readyReplicas: 2,
    availableReplicas: 2,
    updatedReplicas: 1,
    unavailableReplicas: 1,
    conditions: [
      { type: 'Available', status: 'True', reason: null, lastTransitionTime: null },
      { type: 'Progressing', status: 'True', reason: null, lastTransitionTime: null },
    ],
  },
}

const healthyController = {
  enabled: true,
  started: true,
  namespaces: ['agents'],
  crdsReady: true,
  missingCrds: [],
  lastCheckedAt: '2026-01-20T00:00:00Z',
  agentRunIngestion: [
    {
      namespace: 'agents',
      lastWatchEventAt: '2026-01-20T00:00:00Z',
      lastResyncAt: '2026-01-20T00:00:00Z',
      untouchedRunCount: 0,
      oldestUntouchedAgeSeconds: null,
    },
  ],
}

type HeartbeatComponent =
  | 'agents-controller'
  | 'supporting-controller'
  | 'orchestration-controller'
  | 'workflow-runtime'

const buildHeartbeatRows = (
  overrides: Partial<Record<HeartbeatComponent, Partial<ControlPlaneHeartbeatRow>>> = {},
): ControlPlaneHeartbeatRow[] =>
  (
    [
      'agents-controller',
      'supporting-controller',
      'orchestration-controller',
      'workflow-runtime',
    ] as const satisfies HeartbeatComponent[]
  ).map((component) => {
    const override = overrides[component] ?? {}
    return {
      namespace: 'agents',
      component,
      workload_role: 'controllers',
      pod_name: 'agents-controllers-0',
      deployment_name: 'agents-controllers',
      enabled: true,
      status: 'healthy',
      message: '',
      leadership_state: 'leader',
      observed_at: '2026-01-20T00:00:00Z',
      expires_at: '2026-01-21T00:00:00Z',
      ...override,
    }
  })

const createHeartbeatResolver =
  (rows: ControlPlaneHeartbeatRow[] = buildHeartbeatRows()) =>
  async (input: ControlPlaneHeartbeatStoreGetInput) =>
    rows.find(
      (row) =>
        row.namespace === input.namespace &&
        row.component === input.component &&
        (input.workloadRole == null || row.workload_role === input.workloadRole),
    ) ?? null

const buildTemporalAdapter = (
  overrides: Partial<{
    available: boolean
    status: 'healthy' | 'configured' | 'degraded' | 'disabled' | 'unknown'
    message: string
    endpoint: string
  }> = {},
) => ({
  name: 'temporal' as const,
  available: true,
  status: 'configured' as const,
  message: '',
  endpoint: 'temporal:7233',
  authority: {
    mode: 'local' as const,
    namespace: 'agents',
    source_deployment: '',
    source_pod: '',
    observed_at: '2026-01-20T00:00:00Z',
    fresh: true,
    message: 'using local controller state',
  },
  ...overrides,
})

const buildWorkflowsReliabilityStatus = (
  overrides: Partial<WorkflowsReliabilityStatus> = {},
): WorkflowsReliabilityStatus => ({
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

const watchReliabilityHealthy: ControlPlaneWatchReliability = {
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 2,
  total_events: 14,
  total_errors: 0,
  total_restarts: 0,
  streams: [
    {
      resource: 'agents',
      namespace: 'agents',
      events: 10,
      errors: 0,
      restarts: 0,
      last_seen_at: '2026-01-20T00:00:00Z',
    },
    {
      resource: 'agentruns',
      namespace: 'agents',
      events: 4,
      errors: 0,
      restarts: 0,
      last_seen_at: '2026-01-20T00:00:00Z',
    },
  ],
}

const watchReliabilityDegraded: ControlPlaneWatchReliability = {
  status: 'degraded',
  window_minutes: 15,
  observed_streams: 2,
  total_events: 3,
  total_errors: 2,
  total_restarts: 1,
  streams: [
    {
      resource: 'agents',
      namespace: 'agents',
      events: 2,
      errors: 1,
      restarts: 1,
      last_seen_at: '2026-01-20T00:00:00Z',
    },
    {
      resource: 'jobs',
      namespace: 'agents',
      events: 1,
      errors: 1,
      restarts: 0,
      last_seen_at: '2026-01-20T00:00:00Z',
    },
  ],
}

const registeredMigrations = getRegisteredMigrationNames()
const latestMigration = registeredMigrations.at(-1) ?? null

const healthyMigrationConsistency: DatabaseMigrationConsistency = {
  status: 'healthy',
  migration_table: 'kysely_migration',
  registered_count: registeredMigrations.length,
  applied_count: registeredMigrations.length,
  unapplied_count: 0,
  unexpected_count: 0,
  latest_registered: latestMigration,
  latest_applied: latestMigration,
  missing_migrations: [],
  unexpected_migrations: [],
  message: '',
}

const buildDatabaseStatus = (
  overrides: Partial<ControlPlaneDatabaseStatus> = {},
  migrationOverrides: Partial<DatabaseMigrationConsistency> = {},
): ControlPlaneDatabaseStatus => {
  const { migration_consistency: explicitMigrationConsistency, ...databaseOverrides } = overrides
  return {
    configured: true,
    connected: true,
    status: 'healthy',
    message: '',
    latency_ms: 1,
    migration_consistency: {
      ...healthyMigrationConsistency,
      ...migrationOverrides,
      ...explicitMigrationConsistency,
    },
    ...databaseOverrides,
  }
}

describe('control-plane status', () => {
  afterEach(() => {
    currentKubeGateway = createTestKubeGateway()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    delete process.env.JANGAR_WORKFLOWS_WARNING_BACKOFF_THRESHOLD
    delete process.env.JANGAR_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD
    delete process.env.JANGAR_WORKFLOWS_WINDOW_MINUTES
    delete process.env.JANGAR_WORKFLOWS_SWARMS
    delete process.env.JANGAR_CONTROL_PLANE_WATCH_RELIABILITY_BLOCK_ERRORS
    delete process.env.JANGAR_CONTROL_PLANE_WATCH_RELIABILITY_BLOCK_RESTARTS
    delete process.env.JANGAR_CONTROL_PLANE_EXECUTION_TRUST
    delete process.env.JANGAR_CONTROL_PLANE_EXECUTION_TRUST_SUMMARY_LIMIT
    delete process.env.JANGAR_CONTROL_PLANE_EXECUTION_TRUST_SWARMS
    delete process.env.JANGAR_CONTROL_PLANE_ROUTE_HEALTH_URL
    delete process.env.JANGAR_CONTROL_PLANE_ROUTE_PROBE_ENABLED
    delete process.env.JANGAR_CONTROL_PLANE_ROUTE_NAMESPACE
    delete process.env.JANGAR_FAILURE_DOMAIN_EVIDENCE_NAMESPACES
    delete process.env.JANGAR_CLEARANCE_MARKET_ENABLED
    delete process.env.JANGAR_READY_TRUTH_ARBITER_MODE
    delete process.env.JANGAR_EVIDENCE_PRESSURE_LEDGER_ENABLED
    delete process.env.JANGAR_EVIDENCE_PRESSURE_LEDGER_MODE
    delete process.env.JANGAR_SOURCE_HEAD_SHA
    delete process.env.JANGAR_GITOPS_REVISION
  })

  const buildExecutionTrustSwarmResource = (
    options: {
      metadataGeneration?: number
      observedGeneration?: number | null
      phase?: string
      freezeReason?: string | null
      freezeUntil?: string | null
      requirementsPending?: number
      requirementsLastSeen?: string | null
      stageStates?: Record<string, Record<string, string | number | boolean>>
    } = {},
  ): KubeGatewaySwarm => ({
    metadata: {
      name: 'jangar-control-plane',
      namespace: 'agents',
      generation: options.metadataGeneration ?? 1,
      labels: {},
      creationTimestamp: '2026-01-20T00:00:00Z',
    },
    status: {
      observedGeneration: options.observedGeneration ?? 4,
      phase: options.phase ?? 'Active',
      freeze: {
        reason: options.freezeReason ?? null,
        until: options.freezeUntil ?? null,
      },
      requirements: {
        pending: options.requirementsPending ?? 0,
      },
      lastDiscoverAt: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
      lastPlanAt: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
      lastImplementAt: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
      lastVerifyAt: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
      stageStates: {
        discover: {
          phase: 'Running',
          healthy: true,
          cadence: '1m',
          lastRunTime: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
          consecutiveFailures: 0,
        },
        plan: {
          phase: 'Running',
          healthy: true,
          cadence: '1m',
          lastRunTime: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
          consecutiveFailures: 0,
        },
        implement: {
          phase: 'Running',
          healthy: true,
          cadence: '1m',
          lastRunTime: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
          consecutiveFailures: 0,
        },
        verify: {
          phase: 'Running',
          healthy: true,
          cadence: '1m',
          lastRunTime: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
          consecutiveFailures: 0,
        },
        ...options.stageStates,
      },
    },
  })

  const blockedExecutionTrust: ExecutionTrustStatus = {
    status: 'blocked',
    reason: 'execution trust blocked',
    last_evaluated_at: '2026-01-20T00:20:00Z',
    blocking_windows: [
      {
        type: 'swarms',
        scope: 'agents',
        name: 'jangar-control-plane',
        reason: 'active freeze on jangar-control-plane',
        class: 'blocked',
      },
    ],
    evidence_summary: ['swarms:agents:jangar-control-plane:active freeze on jangar-control-plane'],
  }

  const blockedExecutionTrustSwarm: ExecutionTrustSwarm = {
    name: 'jangar-control-plane',
    namespace: 'agents',
    phase: 'Frozen',
    ready: false,
    updated_at: '2026-01-20T00:10:00Z',
    observed_generation: 4,
    freeze: {
      reason: 'StageStaleness',
      until: '2026-01-20T01:00:00Z',
    },
    requirements_pending: 2,
    requirements_pending_class: 'blocked',
    last_discover_at: '2026-01-20T00:00:00Z',
    last_plan_at: '2026-01-20T00:00:00Z',
    last_implement_at: '2026-01-20T00:00:00Z',
    last_verify_at: '2026-01-20T00:00:00Z',
  }

  const blockedExecutionTrustStages: ExecutionTrustStage[] = [
    {
      swarm: 'jangar-control-plane',
      namespace: 'agents',
      stage: 'discover',
      phase: 'Frozen',
      last_run_at: '2026-01-20T00:00:00Z',
      next_expected_at: '2026-01-20T00:01:00Z',
      configured_every_ms: 60000,
      age_ms: 1200000,
      stale_after_ms: 120000,
      stale: true,
      recent_failed_jobs: 0,
      recent_backoff_limit_exceeded_jobs: 0,
      last_failure_reason: 'discover blocked by swarm freeze',
      data_confidence: 'high',
    },
  ]

  const healthyExecutionTrust: ExecutionTrustStatus = {
    status: 'healthy',
    reason: 'execution trust is healthy.',
    last_evaluated_at: '2026-01-20T00:20:00Z',
    blocking_windows: [],
    evidence_summary: [],
  }

  const healthyExecutionTrustSnapshot = {
    executionTrust: healthyExecutionTrust,
    swarms: [] as ExecutionTrustSwarm[],
    stages: [] as ExecutionTrustStage[],
  }

  const buildRuntimeKit = (overrides: Partial<RuntimeKitStatus> = {}): RuntimeKitStatus => ({
    runtime_kit_id: 'runtime-kit:serving:1',
    kit_class: 'serving',
    subject_ref: 'jangar:/ready',
    image_ref: 'runtime:local',
    workspace_contract_version: 'shadow-v1',
    component_digest: 'digest-serving',
    decision: 'healthy',
    observed_at: '2026-01-20T00:00:00Z',
    fresh_until: '2026-01-20T00:05:00Z',
    producer_revision: 'shadow-v1',
    reason_codes: [],
    components: [],
    ...overrides,
  })

  const buildAdmissionPassport = (overrides: Partial<AdmissionPassportStatus> = {}): AdmissionPassportStatus => ({
    admission_passport_id: 'passport:serving:1',
    consumer_class: 'serving',
    authority_session_id: 'authority-session:1',
    recovery_case_set_digest: 'recovery-1',
    runtime_kit_set_digest: 'runtime-1',
    decision: 'allow',
    reason_codes: [],
    required_subjects: [],
    required_runtime_kits: ['runtime-kit:serving:1'],
    issued_at: '2026-01-20T00:00:00Z',
    fresh_until: '2026-01-20T00:05:00Z',
    producer_revision: 'shadow-v1',
    ...overrides,
  })

  const buildRecoveryWarrant = (overrides: Partial<RecoveryWarrantStatus> = {}): RecoveryWarrantStatus => ({
    recovery_warrant_id: 'recovery-warrant:serving:1',
    recovery_epoch_id: 'recovery-epoch:serving:1',
    swarm_name: 'jangar-control-plane',
    execution_class: 'serving',
    admitted_revision: 'shadow-v1',
    admitted_image_digest: null,
    runtime_kit_digest: 'runtime-1',
    admission_passport_id: 'passport:serving:1',
    required_proof_cell_ids: ['runtime-proof-cell:serving:1'],
    active_backlog_seat_count: 0,
    projection_watermark_ids: ['projection-watermark:ready:1'],
    status: 'sealed',
    opened_at: '2026-01-20T00:00:00Z',
    sealed_at: '2026-01-20T00:00:00Z',
    superseded_at: null,
    reason_codes: [],
    ...overrides,
  })

  const buildRuntimeProofCell = (overrides: Partial<RuntimeProofCellStatus> = {}): RuntimeProofCellStatus => ({
    runtime_proof_cell_id: 'runtime-proof-cell:serving:1',
    recovery_warrant_id: 'recovery-warrant:serving:1',
    runtime_kit_id: 'runtime-kit:serving:1',
    proof_kind: 'runtime_kit',
    proof_subject: 'runtime-kit:serving:1',
    expected_ref: 'digest-serving',
    observed_ref: 'healthy',
    artifact_ref: 'jangar:/ready',
    content_hash: 'digest-serving',
    status: 'healthy',
    required: true,
    reason_codes: [],
    observed_at: '2026-01-20T00:00:00Z',
    expires_at: '2026-01-20T00:05:00Z',
    ...overrides,
  })

  const buildProjectionWatermark = (overrides: Partial<ProjectionWatermarkStatus> = {}): ProjectionWatermarkStatus => ({
    projection_watermark_id: 'projection-watermark:ready:1',
    consumer_key: 'jangar_ready',
    recovery_warrant_id: 'recovery-warrant:serving:1',
    projection_digest: 'projection-digest-1',
    source_ref: 'admission-passport:passport:serving:1',
    observed_at: '2026-01-20T00:00:00Z',
    expires_at: '2026-01-20T00:05:00Z',
    status: 'fresh',
    reason_codes: [],
    ...overrides,
  })

  const buildRuntimeAdmissionSnapshot = (
    overrides: Partial<{
      runtimeKits: RuntimeKitStatus[]
      admissionPassports: AdmissionPassportStatus[]
      servingPassportId: string | null
      recoveryWarrants: RecoveryWarrantStatus[]
      runtimeProofCells: RuntimeProofCellStatus[]
      projectionWatermarks: ProjectionWatermarkStatus[]
    }> = {},
  ) => ({
    runtimeKits: overrides.runtimeKits ?? [
      buildRuntimeKit(),
      buildRuntimeKit({
        runtime_kit_id: 'runtime-kit:collaboration:1',
        kit_class: 'collaboration',
        subject_ref: 'jangar:codex:nats-collaboration',
        component_digest: 'digest-collaboration',
      }),
    ],
    admissionPassports: overrides.admissionPassports ?? [
      buildAdmissionPassport(),
      buildAdmissionPassport({
        admission_passport_id: 'passport:swarm_implement:1',
        consumer_class: 'swarm_implement',
        runtime_kit_set_digest: 'runtime-2',
        required_runtime_kits: ['runtime-kit:collaboration:1'],
      }),
    ],
    servingPassportId: overrides.servingPassportId ?? 'passport:serving:1',
    recoveryWarrants: overrides.recoveryWarrants ?? [
      buildRecoveryWarrant(),
      buildRecoveryWarrant({
        recovery_warrant_id: 'recovery-warrant:implement:1',
        execution_class: 'implement',
        runtime_kit_digest: 'runtime-2',
        admission_passport_id: 'passport:swarm_implement:1',
        required_proof_cell_ids: ['runtime-proof-cell:implement:1'],
        projection_watermark_ids: ['projection-watermark:status:1'],
      }),
    ],
    runtimeProofCells: overrides.runtimeProofCells ?? [
      buildRuntimeProofCell(),
      buildRuntimeProofCell({
        runtime_proof_cell_id: 'runtime-proof-cell:implement:1',
        recovery_warrant_id: 'recovery-warrant:implement:1',
        runtime_kit_id: 'runtime-kit:collaboration:1',
        proof_subject: 'runtime-kit:collaboration:1',
        expected_ref: 'digest-collaboration',
        artifact_ref: 'jangar:codex:nats-collaboration',
        content_hash: 'digest-collaboration',
      }),
    ],
    projectionWatermarks: overrides.projectionWatermarks ?? [
      buildProjectionWatermark(),
      buildProjectionWatermark({
        projection_watermark_id: 'projection-watermark:status:1',
        consumer_key: 'control_plane_status',
        recovery_warrant_id: 'recovery-warrant:implement:1',
        source_ref: 'admission-passport:passport:swarm_implement:1',
      }),
    ],
  })

  const healthyRuntimeAdmissionSnapshot = buildRuntimeAdmissionSnapshot()

  const buildStatus = (
    options: Parameters<typeof buildControlPlaneStatus>[0],
    deps: Parameters<typeof buildControlPlaneStatus>[1] = {},
  ) =>
    buildControlPlaneStatus(options, {
      kubeGateway: currentKubeGateway,
      resolveExecutionTrust: async () => healthyExecutionTrustSnapshot,
      resolveRuntimeAdmission: () => healthyRuntimeAdmissionSnapshot,
      resolveTorghutConsumerEvidence: async () => ({
        status: {
          status: 'disabled',
          endpoint: '',
          receipt_id: null,
          generated_at: null,
          fresh_until: null,
          candidate_id: null,
          dataset_snapshot_ref: null,
          max_notional: null,
          reason_codes: [],
          message: 'test consumer evidence disabled',
        },
      }),
      ...deps,
    })

  it('returns healthy summary when components are healthy', async () => {
    process.env.JANGAR_SOURCE_HEAD_SHA = '99470fcfa0000000000000000000000000000000'
    process.env.JANGAR_GITOPS_REVISION = '99470fcfa0000000000000000000000000000000'
    setRolloutDeploymentList(
      [healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment],
      [healthyRuntimePod()],
    )
    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => ({
          ...buildDatabaseStatus(),
          latency_ms: 4,
        }),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveEmpiricalServices: async () => ({
          forecast: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'forecast service ready',
            authoritative: true,
            calibration_status: 'ready',
            eligible_models: ['chronos'],
          },
          lean: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'LEAN runner ready',
            authoritative: true,
            authoritative_modes: ['research_backtest', 'shadow_replay'],
          },
          jobs: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'empirical jobs fresh',
            authoritative: true,
            eligible_jobs: ['benchmark_parity', 'foundation_router_parity', 'janus_event_car', 'janus_hgrm_reward'],
            stale_jobs: [],
          },
        }),
      },
    )

    expect(status.service).toBe('jangar')
    expect(status.controllers).toHaveLength(3)
    expect(status.runtime_adapters).toHaveLength(4)
    expect(status.runtime_kits).toEqual(healthyRuntimeAdmissionSnapshot.runtimeKits)
    expect(status.admission_passports).toEqual(healthyRuntimeAdmissionSnapshot.admissionPassports)
    expect(status.serving_passport_id).toBe('passport:serving:1')
    expect(status.recovery_warrants).toEqual(healthyRuntimeAdmissionSnapshot.recoveryWarrants)
    expect(status.runtime_proof_cells).toEqual(healthyRuntimeAdmissionSnapshot.runtimeProofCells)
    expect(status.projection_watermarks).toEqual(healthyRuntimeAdmissionSnapshot.projectionWatermarks)
    expect(status.workflows).toEqual({
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
    })
    expect(status.dependency_quorum).toMatchObject({
      decision: 'allow',
      reasons: [],
      message: 'Control-plane admission dependencies are healthy.',
    })
    expect(status.failure_domain_leases).toMatchObject({
      mode: 'shadow',
      design_artifact:
        'docs/agents/designs/75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md',
    })
    expect(status.failure_domain_leases.leases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: 'database',
          status: 'valid',
        }),
        expect.objectContaining({
          domain: 'route',
          status: 'valid',
        }),
      ]),
    )
    expect(status.failure_domain_leases.holdbacks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'allow',
        }),
      ]),
    )
    expect(status.reconciled_action_clocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'serve_readonly',
          decision: 'allow',
          conflict_class: 'none',
        }),
        expect.objectContaining({
          action_class: 'dispatch_repair',
          decision: 'allow',
          conflict_class: 'none',
        }),
        expect.objectContaining({
          action_class: 'torghut_capital',
          decision: 'allow',
          producer_revision: '2026-05-06-action-clock-shadow-v1',
        }),
      ]),
    )
    expect(status.negative_evidence_router).toMatchObject({
      mode: 'observe',
      design_artifact: 'docs/agents/designs/111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md',
      evidence_window_minutes: 15,
    })
    expect(status.control_plane_controller_witness).toMatchObject({
      mode: 'shadow',
      design_artifact:
        'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
      decision: 'allow',
      deployment_available: true,
      watch_epoch_current: true,
      controller_self_report_current: true,
    })
    expect(status.controller_ingestion_settlement).toMatchObject({
      schema_version: 'jangar.controller-ingestion-settlement.v1',
      mode: 'observe',
      governing_design_refs: expect.arrayContaining([CONTROLLER_INGESTION_SETTLEMENT_DESIGN_ARTIFACT]),
      controller_witness_ref: status.control_plane_controller_witness.quorum_id,
      source_serving_verdict_ref: expect.any(String),
      selected_repair_ticket: {
        max_notional: '0',
      },
    })
    expect(status.action_slo_budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'serve_readonly',
          decision: 'allow',
        }),
        expect.objectContaining({
          action_class: 'live_micro_canary',
          decision: 'hold',
          blocked_reasons: ['torghut_consumer_evidence_missing'],
        }),
      ]),
    )
    expect(status.material_action_verdict_epoch).toMatchObject({
      mode: 'shadow',
      design_artifact:
        'docs/agents/designs/120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md',
      negative_evidence_router_epoch_ref: status.negative_evidence_router.router_epoch_id,
      controller_witness_ref: status.control_plane_controller_witness.quorum_id,
    })
    expect(status.source_rollout_truth_exchange).toMatchObject({
      mode: 'shadow',
      design_artifact:
        'docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md',
      source_head_sha: '99470fcfa0000000000000000000000000000000',
      gitops_revision: '99470fcfa0000000000000000000000000000000',
      database_projection_ref: expect.stringContaining('database:healthy:healthy'),
      watch_cache_ref: expect.stringContaining('watch:healthy'),
    })
    expect(status.source_rollout_truth_exchange.torghut_proof_floor.state).toBe('repair_only')
    expect(status.source_rollout_truth_exchange.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'deploy_widen',
          settlement_state: 'converged',
          action_decision: 'allow',
        }),
        expect.objectContaining({
          action_class: 'paper_canary',
          settlement_state: 'proof_floor_repair_only',
        }),
      ]),
    )
    expect(status.repair_warrant_exchange).toMatchObject({
      mode: 'observe',
      design_artifact:
        'docs/agents/designs/146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md',
      status: 'healthy',
      source_epoch_id: status.source_rollout_truth_exchange.exchange_id,
      schedule_debt_window: {
        firebreak_state: 'clear',
      },
    })
    expect(status.repair_warrant_exchange.active_warrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          admission_state: 'admitted',
          max_notional: 0,
        }),
      ]),
    )
    expect(status.material_action_verdicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'serve_readonly',
          decision: 'allow',
        }),
        expect.objectContaining({
          action_class: 'live_micro_canary',
          decision: 'block',
          blocking_reason_codes: expect.arrayContaining(['torghut_consumer_evidence_missing']),
          evidence_refs: expect.arrayContaining([status.repair_warrant_exchange.exchange_id]),
        }),
      ]),
    )
    expect(status.material_action_activation_receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'allow',
          controller_witness_refs: status.control_plane_controller_witness.witness_refs,
          route_stability_escrow_ref: status.route_stability_escrow.escrow_id,
          transport_contract_refs: expect.arrayContaining([status.route_stability_escrow.escrow_id]),
        }),
      ]),
    )
    expect(status.route_stability_escrow).toMatchObject({
      mode: 'shadow',
      design_artifact:
        'docs/agents/designs/143-jangar-route-stable-status-snapshot-escrow-and-repair-actuation-windows-2026-05-07.md',
      controller_witness_ref: status.control_plane_controller_witness.quorum_id,
      route_stability_window: {
        state: 'stable',
        live_route_success_count: 1,
        controller_authority_mode: 'heartbeat',
      },
    })
    expect(status.route_stability_escrow.material_action_contracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'allow',
          route_requirement: 'live_required',
          controller_requirement: 'heartbeat_required',
        }),
      ]),
    )
    expect(status.ready_action_exchange).toMatchObject({
      mode: 'observe',
      design_artifact:
        'docs/agents/designs/183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md',
      status: 'block',
      allowed_action_classes: expect.arrayContaining(['serve_readonly', 'torghut_observe']),
      blocked_action_classes: expect.arrayContaining(['live_micro_canary', 'live_scale']),
    })
    expect(status.dependency_verdict_exchange).toMatchObject({
      mode: 'observe',
      design_artifact:
        'docs/agents/designs/186-jangar-route-warrant-dispatch-custody-and-dependency-verdicts-2026-05-13.md',
      torghut_route_warrant_ref: null,
      held_action_classes: expect.arrayContaining(['observe', 'repair', 'implement', 'paper']),
      blocked_action_classes: ['live'],
    })
    expect(status.source_serving_contract_verdict_exchange).toMatchObject({
      mode: 'observe',
      design_artifact: SOURCE_SERVING_CONTRACT_VERDICT_DESIGN_ARTIFACT,
      observed_contracts: [],
      missing_contracts: expect.arrayContaining(['route_warrant_exchange', 'repair_bid_settlement_ledger']),
      held_action_classes: expect.arrayContaining(['dispatch_repair', 'dispatch_normal', 'deploy_widen']),
      blocked_action_classes: ['live_support'],
    })
    expect(status.source_serving_contract_verdict_exchange.verdicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'serve_readonly',
          decision: 'allow',
        }),
        expect.objectContaining({
          action_class: 'dispatch_repair',
          decision: 'hold',
          blocking_reason_codes: expect.arrayContaining([
            'source_serving_contract_missing:repair_bid_settlement_ledger',
          ]),
        }),
      ]),
    )
    expect(status.consumer_evidence_leases).toMatchObject({
      schema_version: 'jangar.consumer-evidence-lease-set.v1',
      mode: 'shadow',
      design_artifact: CONSUMER_EVIDENCE_LEASES_DESIGN_ARTIFACT,
      consumer: 'torghut',
      namespace: 'agents',
      controller_witness_ref: status.control_plane_controller_witness.quorum_id,
    })
    expect(status.consumer_evidence_leases.action_leases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'serve_readonly',
          decision: 'allow',
        }),
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'allow',
        }),
        expect.objectContaining({
          action_class: 'live_scale',
          decision: 'block',
          reason_codes: expect.arrayContaining(['torghut_consumer_evidence_missing']),
        }),
      ]),
    )
    expect(status.dependency_verdict_exchange.verdicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'serve_readonly',
          decision: 'allow',
          allowed_scope: 'read_only',
        }),
        expect.objectContaining({
          action_class: 'repair',
          decision: 'hold',
          blocking_reason_codes: expect.arrayContaining(['route_warrant_missing']),
        }),
      ]),
    )
    expect(status.action_custody_receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'serve_readonly',
          decision: 'allow',
          material_action_verdict_ref: expect.stringContaining('material-action-verdict:serve_readonly'),
        }),
        expect.objectContaining({
          action_class: 'paper_canary',
          decision: 'hold',
          torghut_consumer_evidence_ref: null,
        }),
        expect.objectContaining({
          action_class: 'live_scale',
          decision: 'block',
          forbidden_shortcuts: expect.arrayContaining([
            'current_consumer_evidence_cannot_upgrade_capital_when_max_notional_zero',
          ]),
        }),
      ]),
    )
    expect(status.stage_clearance_packets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'plan',
          action_class: 'dispatch_normal',
          decision: 'allow',
          dependency_verdict_ref: expect.stringContaining('dependency-verdict:implement:'),
          governing_requirement_refs: expect.arrayContaining([
            'docs/agents/designs/184-jangar-stage-clearance-packets-and-freeze-aware-launch-governor-2026-05-12.md',
          ]),
        }),
        expect.objectContaining({
          stage: 'torghut',
          action_class: 'live_scale',
          decision: 'block',
          max_notional: 0,
        }),
      ]),
    )
    const clearanceMarketLedger = status.clearance_market_ledger!
    expect(clearanceMarketLedger).toMatchObject({
      schema_version: 'jangar.clearance-market.v1',
      evidence_mode: 'shadow',
      governing_design_refs: expect.arrayContaining([CLEARANCE_MARKET_DESIGN_ARTIFACT]),
    })
    expect(clearanceMarketLedger.retained_failure_debt.map((debt) => debt.window)).toEqual(['15m', '6h', '7d'])
    expect(clearanceMarketLedger.rollout_truth_settlement.database_projection).toMatchObject({
      mode: 'status_projection',
      evidence_ref: status.source_rollout_truth_exchange.database_projection_ref,
    })
    expect(clearanceMarketLedger.action_clearance).toContainEqual(
      expect.objectContaining({
        action_class: 'serve_readonly',
        governing_design_refs: expect.arrayContaining([CLEARANCE_MARKET_DESIGN_ARTIFACT]),
        evidence_refs: expect.arrayContaining([status.source_rollout_truth_exchange.exchange_id]),
      }),
    )
    expect(status.stage_credit_ledger).toMatchObject({
      schema_version: 'jangar.stage-credit-ledger.v1',
      evidence_mode: 'observe',
      governing_design_refs: expect.arrayContaining([STAGE_CREDIT_LEDGER_DESIGN_ARTIFACT]),
      retained_failure_debt_refs: expect.arrayContaining([expect.stringContaining('clearance-failure-debt:7d:')]),
    })
    expect(status.stage_credit_ledger?.stage_accounts).toContainEqual(
      expect.objectContaining({
        stage: 'plan',
        action_class: 'dispatch_normal',
        decision: 'allow',
        available_credit: expect.any(Number),
      }),
    )
    expect(status.ready_truth_arbiter).toMatchObject({
      schema_version: 'jangar.ready-truth-arbiter.v1',
      mode: 'shadow',
      governing_design_refs: expect.arrayContaining([READY_TRUTH_ARBITER_DESIGN_ARTIFACT]),
      serving_readiness: 'ok',
      material_readiness: 'hold',
      argo_health: 'healthy',
      controller_witness_ref: status.control_plane_controller_witness.quorum_id,
      stage_credit_ledger_ref: status.stage_credit_ledger?.ledger_id,
      source_serving_verdict_ref: status.source_serving_contract_verdict_exchange.exchange_id,
      allowed_action_classes: expect.arrayContaining(['serve_readonly', 'torghut_observe']),
      held_action_classes: expect.arrayContaining(['dispatch_normal', 'deploy_widen', 'merge_ready']),
    })
    expect(status.rollout_proof_passport).toMatchObject({
      schema_version: 'jangar.rollout-proof-passport.v1',
      governing_design_refs: expect.arrayContaining([ROLLOUT_PROOF_PASSPORT_DESIGN_ARTIFACT]),
      status: 'collecting',
      serving_readiness: 'ok',
      material_action_decision: 'hold',
      reason_codes: expect.arrayContaining([
        'source_ci_retention_receipt_missing',
        'manifest_image_digest_missing',
        'registry_image_digest_missing',
      ]),
    })
    expect(status.runner_capacity_futures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema_version: 'jangar.runner-capacity-future.v1',
          stage: 'plan',
          action_class: 'dispatch_normal',
          capacity_state: 'constrained',
          reason_codes: expect.arrayContaining(['runner_capacity_image_digest_missing']),
          value_gates: expect.arrayContaining(['failed_agentrun_rate', 'manual_intervention_count']),
        }),
      ]),
    )
    expect(status.stage_launch_tickets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema_version: 'jangar.stage-launch-ticket.v1',
          stage: 'plan',
          action_class: 'dispatch_normal',
          decision: 'hold',
          rollout_proof_passport_ref: status.rollout_proof_passport.passport_id,
        }),
      ]),
    )
    expect(status.authority_provenance_settlement).toMatchObject({
      schema_version: 'jangar.authority-provenance-settlement.v1',
      evidence_mode: 'shadow',
      governing_design_refs: expect.arrayContaining([AUTHORITY_PROVENANCE_SETTLEMENT_DESIGN_ARTIFACT]),
      settlement_state: expect.any(String),
      rollback_target: 'JANGAR_AUTHORITY_PROVENANCE_SETTLEMENT_MODE=observe',
    })
    expect(status.authority_provenance_settlement.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'controller_process',
          status: 'current',
        }),
        expect.objectContaining({
          surface: 'source_gitops',
        }),
      ]),
    )
    expect(status.authority_provenance_settlement.action_class_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_normal',
        }),
        expect.objectContaining({
          action_class: 'deploy_widen',
        }),
        expect.objectContaining({
          action_class: 'merge_ready',
        }),
      ]),
    )
    expect(status.evidence_pressure_ledger).toMatchObject({
      schema_version: 'jangar.evidence-pressure-ledger.v1',
      evidence_mode: 'observe',
      governing_design_refs: expect.arrayContaining([EVIDENCE_PRESSURE_LEDGER_DESIGN_ARTIFACT]),
      watch_backoff_policy: {
        state: 'calm',
      },
      scheduler_handoff: {
        status: 'allow',
      },
    })
    expect(status.terminal_debt_compaction_ledger).toMatchObject({
      schema_version: 'jangar.terminal-debt-compaction-ledger.v1',
      evidence_mode: 'observe',
      governing_design_refs: expect.arrayContaining([TERMINAL_DEBT_COMPACTION_DESIGN_ARTIFACT]),
      active_debt_summary: {
        count: 0,
      },
      retained_audit_summary: {
        count: 0,
      },
      scheduler_contract: {
        status: 'allow',
        would_hold_action_classes: [],
      },
    })
    expect(status.material_evidence_settlement_spine).toMatchObject({
      schema_version: 'jangar.material-evidence-settlement-spine.v1',
      mode: 'observe',
      governing_design_refs: expect.arrayContaining([MATERIAL_EVIDENCE_SETTLEMENT_DESIGN_ARTIFACT]),
      material_truth: {
        material_gate_ref: status.material_gate_digest.digest_id,
        controller_ingestion_settlement_ref: status.controller_ingestion_settlement.settlement_id,
      },
    })
    expect(status.torghut_action_slo_budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'torghut_observe',
          decision: 'allow',
        }),
        expect.objectContaining({
          action_class: 'paper_canary',
          decision: 'shadow_only',
        }),
      ]),
    )
    expect(status.namespaces).toHaveLength(1)
    expect(status.namespaces[0]?.status).toBe('healthy')
    expect(status.namespaces[0]?.degraded_components ?? []).toHaveLength(0)
    expect(status.watch_reliability).toEqual(watchReliabilityHealthy)
    expect(status.watch_reliability.streams).toHaveLength(2)
    expect(status.agentrun_ingestion).toEqual({
      namespace: 'agents',
      status: 'healthy',
      message: 'AgentRun ingestion healthy',
      last_watch_event_at: '2026-01-20T00:00:00Z',
      last_resync_at: '2026-01-20T00:00:00Z',
      untouched_run_count: 0,
      oldest_untouched_age_seconds: null,
    })
    expect(status.rollout_health.status).toBe('healthy')
    expect(status.rollout_health.observed_deployments).toBe(2)
    expect(status.rollout_health.degraded_deployments).toBe(0)
    expect(status.database.migration_consistency).toEqual(healthyMigrationConsistency)
    expect(status.empirical_services.forecast.authoritative).toBe(true)
    expect(status.empirical_services.lean.authoritative).toBe(true)
    expect(status.empirical_services.jobs.authoritative).toBe(true)
    expect(status.torghut_consumer_evidence.status).toBe('disabled')
  })

  it('projects material evidence settlement from Torghut queue-head topline evidence', async () => {
    setRolloutDeploymentList(
      [healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment],
      [healthyRuntimePod()],
    )

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveTorghutConsumerEvidence: async () => ({
          status: {
            status: 'current',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
            receipt_id: 'torghut-route-proven-profit:status-test',
            generated_at: '2026-01-20T00:00:00Z',
            fresh_until: '2026-01-20T00:05:00Z',
            candidate_id: 'chip-paper-microbar-composite@execution-proof',
            dataset_snapshot_ref: 'torghut-chip-full-day-20260505-4c330ce9-r1',
            max_notional: '0',
            revenue_repair_business_state: 'repair_only',
            revenue_repair_ready: false,
            revenue_repair_queue: [
              {
                code: 'repair_alpha_readiness',
                reason: 'alpha_readiness_not_promotion_eligible',
                dimension: 'alpha_readiness',
                action: 'clear_hypothesis_blockers_before_capital',
                priority: 70,
                expected_unblock_value: 2,
                source: 'proof_floor.repair_ladder',
                value_gate: 'routeable_candidate_count',
                required_output_receipt: 'torghut.executable-alpha-receipts.v1',
                required_receipts: ['alpha_readiness_receipt', 'hypothesis_promotion_receipt', 'capital_replay_board'],
                max_notional: '0',
                capital_rule: 'zero_notional_repair_only',
                observed_count: 1,
              },
            ],
            accepted_routeable_candidate_count: 0,
            reason_codes: [],
            message: 'consumer evidence current',
          },
        }),
      },
    )

    expect(status.material_evidence_settlement_spine).toMatchObject({
      schema_version: 'jangar.material-evidence-settlement-spine.v1',
      mode: 'observe',
      decision: 'hold',
      transport_truth: {
        consumer_evidence_status: 'current',
        revenue_repair_topline_status: 'queue_head_inferred',
        revenue_repair_topline_source: 'revenue_repair_queue_head',
      },
      business_truth: {
        business_state: 'repair_only',
        revenue_ready: false,
        selected_value_gate: 'routeable_candidate_count',
        routeable_candidate_count: 0,
        max_notional: '0',
      },
      repair_dispatch_budget: {
        ticket_class: 'none',
        max_notional: '0',
      },
    })
    expect(status.material_evidence_settlement_spine.reason_codes).toEqual(
      expect.arrayContaining(['topline_inferred_from_queue_head', 'dispatch_repair_hold']),
    )
  })

  it('projects a compact schedule-runner status payload', async () => {
    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    const projection = projectControlPlaneStatus(status, 'schedule-runner') as Record<string, unknown>

    expect(projection.admission_passports).toEqual(status.admission_passports)
    expect(projection.stage_clearance_packets).toEqual(status.stage_clearance_packets)
    expect(projection.material_reentry_clearinghouse).toEqual(status.material_reentry_clearinghouse)
    expect(projection.workflows).toBeUndefined()
    expect(projection.swarms).toBeUndefined()
  })

  it('attaches Torghut stage-clearance custody before publishing material status', async () => {
    process.env.JANGAR_SOURCE_HEAD_SHA = '99470fcfa0000000000000000000000000000000'
    process.env.JANGAR_GITOPS_REVISION = '99470fcfa0000000000000000000000000000000'
    setRolloutDeploymentList(
      [healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment],
      [healthyRuntimePod()],
    )

    const status = await buildStatus(
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
        now: () => new Date('2026-05-13T06:00:30.000Z'),
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveTorghutConsumerEvidence: async () => ({
          status: {
            status: 'current',
            endpoint: 'http://torghut/trading/consumer-evidence',
            receipt_id: 'torghut-route-proven-profit:clock-custody',
            generated_at: '2026-05-13T06:00:00.000Z',
            fresh_until: '2026-05-13T06:02:00.000Z',
            candidate_id: null,
            dataset_snapshot_ref: null,
            max_notional: '0',
            decision: 'repair_only',
            reason_codes: [],
            message: 'current',
            evidence_clock_arbiter_id: 'evidence-clock-arbiter:clock-custody',
            evidence_clock_state: 'current',
            evidence_clock_custody_status: 'missing',
            evidence_clock_custody_ref: null,
            routeable_profit_candidate_exchange_id: 'routeable-profit-candidate-exchange:clock-custody',
            routeable_exchange_routeable_candidate_count: 0,
            routeable_exchange_zero_notional_repair_lot_ids: ['evidence-clock-repair-lot:stage-custody'],
            routeable_exchange_rejected_candidate_count: 1,
          },
          negativeEvidence: {
            readiness_status: 'degraded',
            paper_settlement_clean: false,
            consumer_evidence_receipt_id: 'torghut-route-proven-profit:clock-custody',
            consumer_evidence_status: 'current',
            consumer_evidence_fresh_until: '2026-05-13T06:02:00.000Z',
            consumer_evidence_reason_codes: [],
            evidence_clock_arbiter_id: 'evidence-clock-arbiter:clock-custody',
            evidence_clock_status: 'current',
            evidence_clock_custody_status: 'missing',
            evidence_clock_custody_ref: null,
            evidence_clock_custody_reason_codes: ['evidence_clock_custody_receipt_missing'],
            routeable_profit_candidate_exchange_id: 'routeable-profit-candidate-exchange:clock-custody',
            routeable_exchange_zero_notional_repair_lot_ids: ['evidence-clock-repair-lot:stage-custody'],
            routeable_exchange_routeable_candidate_count: 0,
            routeable_exchange_rejected_candidate_count: 1,
          },
        }),
      },
    )

    const torghutPaperPacket = status.stage_clearance_packets.find(
      (packet) => packet.stage === 'torghut' && packet.action_class === 'paper_canary',
    )

    expect(torghutPaperPacket).toMatchObject({
      decision: 'hold',
      max_notional: 0,
    })
    expect(status.torghut_consumer_evidence).toMatchObject({
      evidence_clock_arbiter_id: 'evidence-clock-arbiter:clock-custody',
      evidence_clock_custody_status: 'blocked',
      evidence_clock_custody_ref: torghutPaperPacket?.packet_id,
    })
    expect(torghutPaperPacket?.reason_codes).not.toContain('evidence_clock_custody_missing')
    expect(torghutPaperPacket?.reason_codes).toEqual(expect.arrayContaining(['evidence_clock_custody_blocked']))
  })

  it('projects clearance market authority splits while holding normal dispatch', async () => {
    setRolloutDeploymentList(
      [unavailableAgentsRolloutDeployment, healthyAgentsControllersRolloutDeployment],
      [healthyRuntimePod()],
    )
    const degradedTrust: ExecutionTrustStatus = {
      ...healthyExecutionTrust,
      status: 'degraded',
      reason: 'execution trust degraded by stale implement stage',
      blocking_windows: [
        {
          type: 'stages',
          scope: 'agents/jangar-control-plane',
          name: 'implement',
          reason: 'implement stage stale',
          class: 'degraded',
        },
      ],
      evidence_summary: ['stages:agents/jangar-control-plane:implement stage stale'],
    }

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () =>
          buildWorkflowsReliabilityStatus({
            recent_failed_jobs: 2,
            backoff_limit_exceeded_jobs: 1,
          }),
        resolveExecutionTrust: async () => ({
          executionTrust: degradedTrust,
          swarms: [],
          stages: [],
        }),
        resolveTorghutConsumerEvidence: async () => ({
          status: {
            status: 'current',
            endpoint: 'http://torghut/trading/consumer-evidence',
            receipt_id: 'torghut-consumer-evidence:1',
            generated_at: '2026-01-20T00:00:00Z',
            fresh_until: '2026-01-20T00:05:00Z',
            candidate_id: null,
            dataset_snapshot_ref: 'dataset:stale-quant',
            max_notional: '0',
            route_repair_value: 14,
            decision: 'repair',
            profit_freshness_frontier_id: 'profit-freshness:1',
            reason_codes: ['quant_ingestion_stale', 'market_context_stale'],
            message: 'zero-notional repair required before normal dispatch',
          },
        }),
      },
    )

    const clearanceMarketLedger = status.clearance_market_ledger!
    expect(clearanceMarketLedger.authority_splits.map((split) => `${split.domain}:${split.decision}`)).toEqual(
      expect.arrayContaining(['torghut:repair_only', 'torghut:hold', 'rollout:hold', 'runtime_admission:hold']),
    )
    expect(clearanceMarketLedger.authority_splits.flatMap((split) => split.reason_codes)).toEqual(
      expect.arrayContaining([
        'torghut_zero_notional_repair_only',
        'quant_ingestion_stale',
        'agents_api_degraded',
        'agents_controllers_available',
        'execution_trust_degraded',
        'runtime_passport_allow_split',
      ]),
    )
    const actionClearance = new Map(
      clearanceMarketLedger.action_clearance.map((action) => [action.action_class, action]),
    )
    expect(actionClearance.get('dispatch_repair')).toMatchObject({ decision: 'repair_only' })
    expect(actionClearance.get('dispatch_normal')).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['execution_trust_degraded', 'torghut_quant_evidence_stale']),
    })
    expect(actionClearance.get('merge_ready')).toMatchObject({ decision: 'hold' })
    expect(clearanceMarketLedger.retained_failure_debt.find((debt) => debt.window === '15m')).toMatchObject({
      state: 'active',
      failed_count: 2,
      backoff_count: 1,
    })
    const stageCreditAccounts = new Map(
      status.stage_credit_ledger?.stage_accounts.map((account) => [
        `${account.stage}:${account.action_class}`,
        account,
      ]) ?? [],
    )
    expect(stageCreditAccounts.get('plan:dispatch_normal')).toMatchObject({
      decision: 'hold',
      available_credit: 0,
      reason_codes: expect.arrayContaining(['stage_credit_insufficient']),
    })
    expect(stageCreditAccounts.get('repair:dispatch_repair')).toMatchObject({
      decision: 'repair_only',
      selected_repair_lot_ref: expect.stringContaining('clearance-repair-lot:'),
    })
  })

  it('keeps serving readiness ok while material readiness holds on controller runtime and execution debt', async () => {
    setRolloutDeploymentList(
      [healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment],
      [healthyRuntimePod()],
    )
    const degradedTrust: ExecutionTrustStatus = {
      ...healthyExecutionTrust,
      status: 'degraded',
      reason: 'execution trust degraded by swarm freeze StageStaleness',
      blocking_windows: [
        {
          type: 'swarms',
          scope: 'agents',
          name: 'jangar-control-plane',
          reason: 'active freeze on jangar-control-plane: StageStaleness',
          class: 'degraded',
        },
      ],
      evidence_summary: ['swarms:agents:jangar-control-plane:StageStaleness'],
    }

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(
          buildHeartbeatRows({
            'agents-controller': {
              status: 'degraded',
              message: 'agents controller not started',
            },
            'workflow-runtime': {
              status: 'degraded',
              message: 'workflow and job runtimes not started',
            },
          }),
        ),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveExecutionTrust: async () => ({
          executionTrust: degradedTrust,
          swarms: [blockedExecutionTrustSwarm],
          stages: blockedExecutionTrustStages,
        }),
      },
    )

    expect(status.ready_truth_arbiter).toMatchObject({
      mode: 'shadow',
      serving_readiness: 'ok',
      material_readiness: 'hold',
      argo_health: 'healthy',
      allowed_action_classes: expect.arrayContaining(['serve_readonly', 'torghut_observe']),
      held_action_classes: expect.arrayContaining(['dispatch_normal', 'deploy_widen', 'merge_ready']),
      controller_witness_ref: status.control_plane_controller_witness.quorum_id,
      stage_credit_ledger_ref: status.stage_credit_ledger?.ledger_id,
      source_serving_verdict_ref: status.source_serving_contract_verdict_exchange.exchange_id,
    })
    expect(status.ready_truth_arbiter.ready_status_truth_reasons).toEqual(
      expect.arrayContaining([
        'controller_witness_repair_only',
        'runtime_adapter_workflow_degraded',
        'runtime_adapter_job_degraded',
        'execution_trust_degraded',
      ]),
    )
    expect(status.ready_truth_arbiter.merge_gate_receipt).toMatchObject({
      action_class: 'merge_ready',
      decision: 'hold',
    })
    expect(status.namespaces[0]?.status).toBe('degraded')
  })

  it('exposes evidence pressure ledger when watch rate limits should hold normal dispatch', async () => {
    setRolloutDeploymentList(
      [healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment],
      [healthyRuntimePod()],
    )

    const rateLimitedWatch: ControlPlaneWatchReliability = {
      status: 'degraded',
      window_minutes: 15,
      observed_streams: 1,
      total_events: 2,
      total_errors: 4,
      total_restarts: 2,
      streams: [
        {
          resource: 'agentruns.agents.proompteng.ai',
          namespace: 'agents',
          events: 2,
          errors: 4,
          restarts: 2,
          last_seen_at: '2026-01-20T00:00:00Z',
          error_reasons: {
            watch_rate_limited: 4,
          },
          restart_reasons: {
            watch_rate_limited: 2,
          },
        },
      ],
    }

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => rateLimitedWatch,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveTorghutConsumerEvidence: async () => ({
          status: {
            status: 'current',
            endpoint: 'http://torghut/trading/consumer-evidence',
            receipt_id: 'torghut-consumer-evidence:pressure',
            generated_at: '2026-01-20T00:00:00Z',
            fresh_until: '2026-01-20T00:05:00Z',
            candidate_id: null,
            dataset_snapshot_ref: null,
            max_notional: '0',
            repair_bid_settlement_ledger_id: 'repair-bid-settlement:pressure',
            repair_bid_settlement_dispatchable_lot_ids: ['repair-lot:watch-pressure'],
            reason_codes: [],
            message: 'current zero-notional repair evidence',
          },
        }),
      },
    )

    expect(status.evidence_pressure_ledger).toMatchObject({
      watch_backoff_policy: {
        state: 'brownout',
        max_new_agent_runs_per_stage: 0,
      },
      scheduler_handoff: {
        status: 'hold',
        held_action_classes: expect.arrayContaining(['dispatch_normal']),
        repair_action_classes: expect.arrayContaining(['dispatch_repair']),
      },
    })
    expect(status.evidence_pressure_ledger?.pressure_sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_class: 'kubernetes_watch',
          severity: 'hold',
          reason_codes: expect.arrayContaining(['kubernetes_watch_rate_limited']),
        }),
      ]),
    )
    expect(status.evidence_pressure_ledger?.action_pressure_budget).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_class: 'serve_readonly', decision: 'allow' }),
        expect.objectContaining({ action_class: 'dispatch_repair', decision: 'repair_only' }),
        expect.objectContaining({ action_class: 'dispatch_normal', decision: 'hold' }),
        expect.objectContaining({ action_class: 'merge_ready', decision: 'hold' }),
      ]),
    )
  })

  it('exposes repair-bid admission receipts from current Torghut settlement lots', async () => {
    setRolloutDeploymentList(
      [healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment],
      [healthyRuntimePod()],
    )

    const status = await buildStatus(
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
        now: () => new Date('2026-05-13T05:20:00.000Z'),
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveTorghutConsumerEvidence: async () => ({
          status: {
            status: 'current',
            endpoint: 'http://torghut/trading/consumer-evidence',
            receipt_id: 'torghut-route-proven-profit:test',
            generated_at: '2026-05-13T05:20:00.000Z',
            fresh_until: '2026-05-13T05:21:00.000Z',
            candidate_id: null,
            dataset_snapshot_ref: null,
            max_notional: '0',
            reason_codes: [],
            message: 'current',
            repair_bid_settlement_ledger_id: 'repair-bid-settlement-ledger:test',
            repair_bid_settlement_status: 'current',
            repair_bid_settlement_fresh_until: '2026-05-13T05:21:00.000Z',
            repair_bid_settlement_capital_decision: 'repair_only',
            repair_bid_settlement_max_notional: '0',
            repair_bid_settlement_selected_lot_ids: ['compacted-repair-lot:quant'],
            repair_bid_settlement_dispatchable_lot_ids: ['compacted-repair-lot:quant'],
            repair_bid_settlement_held_lot_ids: [],
            repair_bid_settlement_active_dedupe_keys: [],
            repair_bid_settlement_compacted_lots: [
              {
                lot_id: 'compacted-repair-lot:quant',
                lot_class: 'quant_pipeline',
                target_value_gate: 'zero_notional_or_stale_evidence_rate',
                priority: 100,
                expected_gate_delta: 'retire_jangar_quant_ingestion_degraded',
                raw_reason_codes: ['jangar_quant_ingestion_degraded'],
                root_cause_hypothesis: 'scoped quant ingestion proof is degraded',
                required_input_refs: ['route-evidence-clearinghouse:test'],
                required_output_receipt: 'torghut.quant-pipeline-current-receipt.v1',
                required_output_receipt_count: 1,
                validation_commands: ['pytest services/torghut/tests/test_repair_bid_settlement.py -k quant_pipeline'],
                dedupe_key: 'PA3SX7FYNUTF:15m:quant_pipeline',
                ttl_seconds: 900,
                max_runtime_seconds: 1200,
                max_parallelism: 1,
                max_notional: '0',
                state: 'selected',
                dispatchable: true,
                hold_reason_codes: [],
                source_bid_ids: ['route-evidence-repair-bid:quant'],
              },
            ],
            repair_bid_settlement_reason_codes: ['jangar_quant_ingestion_degraded'],
          },
        }),
      },
    )

    expect(status.repair_bid_admission).toMatchObject({
      mode: 'observe',
      design_artifact: 'docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md',
      torghut_settlement_ledger_ref: 'repair-bid-settlement-ledger:test',
      admitted_lot_ids: ['compacted-repair-lot:quant'],
    })
    expect(status.repair_bid_admission.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          decision: 'allow',
          max_notional: 0,
        }),
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'hold',
          denied_reason_codes: expect.arrayContaining(['torghut_repair_lots_unsettled']),
        }),
        expect.objectContaining({
          action_class: 'live_scale',
          decision: 'block',
        }),
      ]),
    )
    expect(status.repair_bid_admission.dispatch_tickets).toEqual([
      expect.objectContaining({
        torghut_lot_id: 'compacted-repair-lot:quant',
        launch_allowed: true,
        max_notional: 0,
      }),
    ])
    expect(status.material_reentry_clearinghouse).toMatchObject({
      schema_version: 'jangar.material-reentry-clearinghouse.v1',
      mode: 'observe',
      design_artifact: MATERIAL_REENTRY_CLEARINGHOUSE_DESIGN_ARTIFACT,
    })
    expect(status.material_reentry_clearinghouse.action_receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          required_output_receipt: expect.any(String),
          max_notional: 0,
        }),
      ]),
    )
  })

  it('projects source rollout truth and keeps normal dispatch repair-only when GitOps lags source', async () => {
    process.env.JANGAR_SOURCE_HEAD_SHA = '99470fcfa0000000000000000000000000000000'
    process.env.JANGAR_GITOPS_REVISION = '4c44179970000000000000000000000000000000'
    setRolloutDeploymentList(
      [healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment],
      [healthyRuntimePod()],
    )

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    const exchange = status.source_rollout_truth_exchange
    const serveReceipt = exchange.receipts.find((receipt) => receipt.action_class === 'serve_readonly')
    const dispatchReceipt = exchange.receipts.find((receipt) => receipt.action_class === 'dispatch_normal')
    const deployReceipt = exchange.receipts.find((receipt) => receipt.action_class === 'deploy_widen')
    const dispatchVerdict = status.material_action_verdicts.find(
      (verdict) => verdict.action_class === 'dispatch_normal',
    )

    expect(serveReceipt).toMatchObject({
      settlement_state: 'rollout_lagging_source',
      action_decision: 'allow',
      blocking_reasons: [],
    })
    expect(dispatchReceipt).toMatchObject({
      settlement_state: 'rollout_lagging_source',
      action_decision: 'repair_only',
      blocking_reasons: expect.arrayContaining(['source_head_gitops_revision_mismatch']),
    })
    expect(deployReceipt).toMatchObject({
      action_decision: 'hold',
      rollback_target: 'hold rollout widening until GitOps revision, desired image, and live image converge',
    })
    expect(dispatchVerdict).toMatchObject({
      decision: 'repair_only',
      downgrade_reason_codes: expect.arrayContaining(['source_head_gitops_revision_mismatch']),
    })
  })

  it('surfaces blocked collaboration runtime kits without changing the serving passport id', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveEmpiricalServices: async () => ({
          forecast: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'forecast service ready',
            authoritative: true,
          },
          lean: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'LEAN runner ready',
            authoritative: true,
          },
          jobs: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'empirical jobs fresh',
            authoritative: true,
            eligible_jobs: [],
            stale_jobs: [],
          },
        }),
        resolveRuntimeAdmission: () =>
          buildRuntimeAdmissionSnapshot({
            runtimeKits: [
              buildRuntimeKit(),
              buildRuntimeKit({
                runtime_kit_id: 'runtime-kit:collaboration:2',
                kit_class: 'collaboration',
                subject_ref: 'jangar:codex:nats-collaboration',
                component_digest: 'digest-collaboration',
                decision: 'blocked',
                reason_codes: ['runtime_kit_component_missing:codex_nats_publish'],
              }),
            ],
            admissionPassports: [
              buildAdmissionPassport(),
              buildAdmissionPassport({
                admission_passport_id: 'passport:swarm_implement:2',
                consumer_class: 'swarm_implement',
                runtime_kit_set_digest: 'runtime-2',
                decision: 'block',
                reason_codes: ['runtime_kit_component_missing:codex_nats_publish'],
                required_runtime_kits: ['runtime-kit:collaboration:2'],
              }),
            ],
            recoveryWarrants: [
              buildRecoveryWarrant(),
              buildRecoveryWarrant({
                recovery_warrant_id: 'recovery-warrant:implement:2',
                execution_class: 'implement',
                runtime_kit_digest: 'runtime-2',
                admission_passport_id: 'passport:swarm_implement:2',
                required_proof_cell_ids: ['runtime-proof-cell:implement:2'],
                projection_watermark_ids: ['projection-watermark:status:2'],
                status: 'broken',
                sealed_at: null,
                reason_codes: ['runtime_kit_component_missing:codex_nats_publish'],
              }),
            ],
            runtimeProofCells: [
              buildRuntimeProofCell(),
              buildRuntimeProofCell({
                runtime_proof_cell_id: 'runtime-proof-cell:implement:2',
                recovery_warrant_id: 'recovery-warrant:implement:2',
                runtime_kit_id: 'runtime-kit:collaboration:2',
                proof_subject: 'binary:codex-nats-publish',
                expected_ref: 'codex-nats-publish',
                observed_ref: null,
                artifact_ref: 'checked_paths=[codex-nats-publish]',
                content_hash: null,
                status: 'missing',
                reason_codes: ['runtime_kit_component_missing:codex_nats_publish'],
              }),
            ],
            projectionWatermarks: [
              buildProjectionWatermark(),
              buildProjectionWatermark({
                projection_watermark_id: 'projection-watermark:status:2',
                consumer_key: 'control_plane_status',
                recovery_warrant_id: 'recovery-warrant:implement:2',
                source_ref: 'admission-passport:passport:swarm_implement:2',
                status: 'degraded',
                reason_codes: ['runtime_kit_component_missing:codex_nats_publish'],
              }),
            ],
          }),
      },
    )

    expect(status.serving_passport_id).toBe('passport:serving:1')
    expect(status.runtime_kits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kit_class: 'collaboration',
          decision: 'blocked',
        }),
      ]),
    )
    expect(status.admission_passports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer_class: 'swarm_implement',
          decision: 'block',
        }),
      ]),
    )
    expect(status.recovery_warrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_class: 'implement',
          status: 'broken',
          reason_codes: expect.arrayContaining(['runtime_kit_component_missing:codex_nats_publish']),
        }),
      ]),
    )
    expect(status.runtime_proof_cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recovery_warrant_id: 'recovery-warrant:implement:2',
          proof_kind: 'runtime_kit',
          status: 'missing',
        }),
      ]),
    )
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('runtime_kit:collaboration')
  })

  it('marks degraded components when controllers or database fail', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])
    const degradedController = {
      enabled: true,
      started: false,
      namespaces: ['agents'],
      crdsReady: false,
      missingCrds: ['agents.agents.proompteng.ai'],
      lastCheckedAt: '2026-01-20T00:00:00Z',
      agentRunIngestion: [
        {
          namespace: 'agents',
          lastWatchEventAt: '2026-01-20T00:00:00Z',
          lastResyncAt: '2026-01-20T00:00:00Z',
          untouchedRunCount: 3,
          oldestUntouchedAgeSeconds: 180,
        },
      ],
    }

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(
          buildHeartbeatRows({
            'agents-controller': {
              status: 'degraded',
              message: 'agents controller not started',
            },
            'supporting-controller': {
              status: 'degraded',
              message: 'supporting controller lagging',
            },
            'workflow-runtime': {
              status: 'degraded',
              message: 'workflow runtime not started',
            },
          }),
        ),
        getAgentsControllerHealth: () => degradedController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () =>
          buildTemporalAdapter({
            available: false,
            status: 'degraded',
            message: 'missing config',
          }),
        checkDatabase: async () => ({
          ...buildDatabaseStatus({
            configured: false,
            connected: false,
            status: 'disabled',
            message: 'DATABASE_URL not set',
            latency_ms: 0,
          }),
        }),
        getWatchReliabilitySummary: () => watchReliabilityDegraded,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveEmpiricalServices: async () => ({
          forecast: {
            status: 'degraded',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'forecast service readiness failed',
            authoritative: false,
          },
          lean: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'LEAN runner ready',
            authoritative: true,
            authoritative_modes: ['research_backtest'],
          },
          jobs: {
            status: 'degraded',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'stale empirical jobs: benchmark_parity',
            authoritative: false,
            eligible_jobs: ['foundation_router_parity'],
            stale_jobs: ['benchmark_parity'],
          },
        }),
      },
    )

    const degraded = status.namespaces[0]?.degraded_components ?? []
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(status.dependency_quorum.decision).toBe('block')
    expect(status.dependency_quorum.degradation_scope).toBe('global')
    expect(status.dependency_quorum.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment: 'control_runtime',
          status: 'blocked',
          scope: 'global',
          confidence: 'low',
          reasons: expect.arrayContaining([
            'agents_controller_unavailable',
            'supporting_controller_degraded',
            'workflow_runtime_unavailable',
            'control_plane_database_unhealthy',
          ]),
        }),
      ]),
    )
    expect(degraded).toContain('agents-controller')
    expect(degraded).toContain('runtime:temporal')
    expect(degraded).toContain('database')
    expect(degraded).toContain('watch_reliability')
    expect(degraded).toContain('agentrun_ingestion')
    expect(degraded).toContain('empirical:forecast')
    expect(degraded).toContain('empirical:jobs')
    expect(degraded).not.toContain('grpc')
    expect(status.watch_reliability.status).toBe('degraded')
    expect(status.watch_reliability.total_errors).toBe(2)
    expect(status.agentrun_ingestion.status).toBe('degraded')
    expect(status.agentrun_ingestion.untouched_run_count).toBe(3)
    expect(status.agentrun_ingestion.oldest_untouched_age_seconds).toBe(180)
    expect(status.control_plane_controller_witness).toMatchObject({
      decision: 'hold_material',
      reason_codes: ['controller_ingestion_stalled'],
    })
    expect(status.action_slo_budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'hold',
          blocked_reasons: expect.arrayContaining(['controller_ingestion_stalled']),
        }),
      ]),
    )
    expect(status.empirical_services.jobs.status).toBe('degraded')
  })

  it('keeps delay scope global when only control runtime degrades', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(
          buildHeartbeatRows({
            'supporting-controller': {
              status: 'degraded',
              message: 'supporting controller lagging',
            },
          }),
        ),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.dependency_quorum).toMatchObject({
      decision: 'delay',
      reasons: ['supporting_controller_degraded'],
      message: 'Control-plane dependency quorum is degraded; delay capital promotion.',
      degradation_scope: 'global',
    })
    expect(status.dependency_quorum.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment: 'control_runtime',
          status: 'degraded',
          scope: 'global',
          confidence: 'medium',
          reasons: ['supporting_controller_degraded'],
        }),
      ]),
    )
  })

  it('blocks rollout quorum when empirical jobs are degraded', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveEmpiricalServices: async () => ({
          forecast: {
            status: 'degraded',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'forecast service readiness failed',
            authoritative: false,
          },
          lean: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'LEAN runner ready',
            authoritative: false,
            authoritative_modes: [],
          },
          jobs: {
            status: 'degraded',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'stale empirical jobs: benchmark_parity',
            authoritative: false,
            eligible_jobs: ['foundation_router_parity'],
            stale_jobs: ['benchmark_parity'],
          },
        }),
      },
    )

    expect(status.dependency_quorum).toMatchObject({
      decision: 'block',
      reasons: ['empirical_jobs_degraded'],
      message: 'Control-plane dependency quorum is blocked.',
    })
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('empirical:forecast')
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('empirical:jobs')
    expect(status.namespaces[0]?.degraded_components ?? []).not.toContain('empirical:lean')
    expect(status.empirical_services.forecast.status).toBe('degraded')
    expect(status.empirical_services.lean.authoritative).toBe(false)
    expect(status.empirical_services.jobs).toMatchObject({
      status: 'degraded',
      stale_jobs: ['benchmark_parity'],
    })
  })

  it('blocks rollout quorum when watch reliability exceeds block thresholds', async () => {
    process.env.JANGAR_CONTROL_PLANE_WATCH_RELIABILITY_BLOCK_ERRORS = '2'
    process.env.JANGAR_CONTROL_PLANE_WATCH_RELIABILITY_BLOCK_RESTARTS = '2'
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const status = await buildStatus(
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
        now: () => new Date('2026-01-20T00:20:00Z'),
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () =>
          buildTemporalAdapter({
            message: 'temporal configuration resolved',
          }),
        checkDatabase: async () => ({
          ...buildDatabaseStatus({
            latency_ms: 1,
          }),
        }),
        getWatchReliabilitySummary: () => ({
          ...watchReliabilityDegraded,
          total_errors: 3,
          total_restarts: 3,
          streams: [
            {
              resource: 'agents',
              namespace: 'agents',
              events: 2,
              errors: 3,
              restarts: 3,
              last_seen_at: '2026-01-20T00:20:00Z',
            },
            {
              resource: 'agentruns',
              namespace: 'agents',
              events: 1,
              errors: 0,
              restarts: 0,
              last_seen_at: '2026-01-20T00:20:00Z',
            },
          ],
        }),
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveEmpiricalServices: async () => ({
          forecast: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'forecast service ready',
            authoritative: true,
            calibration_status: 'ready',
            eligible_models: ['chronos'],
          },
          lean: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'LEAN runner ready',
            authoritative: true,
            authoritative_modes: ['research_backtest'],
          },
          jobs: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'empirical jobs fresh',
            authoritative: true,
            eligible_jobs: ['benchmark_parity', 'foundation_router_parity'],
            stale_jobs: [],
          },
        }),
      },
    )

    expect(status.dependency_quorum).toMatchObject({
      decision: 'block',
      reasons: ['watch_reliability_blocked'],
      message: 'Control-plane dependency quorum is blocked.',
    })
    expect(status.dependency_quorum.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment: 'watch_stream',
          status: 'blocked',
          scope: 'global',
          confidence: 'low',
          reasons: ['watch_reliability_blocked'],
        }),
      ]),
    )
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('watch_reliability')
    expect(status.watch_reliability.status).toBe('degraded')
  })

  it('delays rollout when watch reliability is degraded but below block thresholds', async () => {
    process.env.JANGAR_CONTROL_PLANE_WATCH_RELIABILITY_BLOCK_ERRORS = '10'
    process.env.JANGAR_CONTROL_PLANE_WATCH_RELIABILITY_BLOCK_RESTARTS = '10'
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const status = await buildStatus(
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
        now: () => new Date('2026-01-20T00:20:00Z'),
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () =>
          buildTemporalAdapter({
            message: 'temporal configuration resolved',
          }),
        checkDatabase: async () => ({
          ...buildDatabaseStatus({
            latency_ms: 1,
          }),
        }),
        getWatchReliabilitySummary: () => ({
          ...watchReliabilityDegraded,
          total_errors: 3,
          total_restarts: 3,
          streams: [
            {
              resource: 'agents',
              namespace: 'agents',
              events: 2,
              errors: 3,
              restarts: 3,
              last_seen_at: '2026-01-20T00:20:00Z',
            },
            {
              resource: 'agentruns',
              namespace: 'agents',
              events: 1,
              errors: 0,
              restarts: 0,
              last_seen_at: '2026-01-20T00:20:00Z',
            },
          ],
        }),
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveEmpiricalServices: async () => ({
          forecast: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'forecast service ready',
            authoritative: true,
            calibration_status: 'ready',
            eligible_models: ['chronos'],
          },
          lean: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'LEAN runner ready',
            authoritative: true,
            authoritative_modes: ['research_backtest'],
          },
          jobs: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'empirical jobs fresh',
            authoritative: true,
            eligible_jobs: ['benchmark_parity', 'foundation_router_parity'],
            stale_jobs: [],
          },
        }),
      },
    )

    expect(status.dependency_quorum).toMatchObject({
      decision: 'delay',
      reasons: ['watch_reliability_degraded'],
      message: 'Control-plane dependency quorum is degraded; delay capital promotion.',
    })
    expect(status.dependency_quorum.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment: 'watch_stream',
          status: 'degraded',
          scope: 'single_capability',
          confidence: 'medium',
          reasons: ['watch_reliability_degraded'],
        }),
      ]),
    )
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('watch_reliability')
    expect(status.watch_reliability.status).toBe('degraded')
  })

  it('marks workflows as degraded when backoff count crosses warning threshold', async () => {
    process.env.JANGAR_WORKFLOWS_WARNING_BACKOFF_THRESHOLD = '2'
    process.env.JANGAR_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD = '3'
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const status = await buildStatus(
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
        now: () => new Date('2026-01-20T00:20:00Z'),
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () =>
          buildTemporalAdapter({
            message: 'temporal configuration resolved',
          }),
        checkDatabase: async () => ({
          ...buildDatabaseStatus({
            latency_ms: 1,
          }),
        }),
        getWorkflowsReliabilityStatus: async () =>
          buildWorkflowsReliabilityStatus({
            active_job_runs: 2,
            recent_failed_jobs: 4,
            backoff_limit_exceeded_jobs: 2,
            top_failure_reasons: [
              { reason: 'BackoffLimitExceeded', count: 3 },
              { reason: 'DeadlineExceeded', count: 1 },
            ],
          }),
      },
    )

    expect(status.workflows.active_job_runs).toBe(2)
    expect(status.workflows.recent_failed_jobs).toBe(4)
    expect(status.workflows.backoff_limit_exceeded_jobs).toBe(2)
    expect(status.workflows.top_failure_reasons).toEqual([
      { reason: 'BackoffLimitExceeded', count: 3 },
      { reason: 'DeadlineExceeded', count: 1 },
    ])
    expect(status.dependency_quorum).toMatchObject({
      decision: 'delay',
      reasons: ['workflow_backoff_warning'],
      message:
        'Control-plane dependency quorum is degraded; delay capital promotion. recent workflow reasons: BackoffLimitExceeded, DeadlineExceeded',
    })
    expect(status.dependency_quorum.degradation_scope).toBe('single_capability')
    expect(status.dependency_quorum.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment: 'dependency_quorum',
          status: 'degraded',
          scope: 'single_capability',
          confidence: 'medium',
          reasons: ['workflow_backoff_warning'],
        }),
      ]),
    )
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('workflows')
    expect(status.namespaces[0]?.degraded_components ?? []).not.toContain('runtime:workflows')
  })

  it('marks workflow confidence unknown when workflow list lookup fails', async () => {
    setKubeGateway(
      createTestKubeGateway({
        listDeployments: vi.fn(async () => [healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment]),
        listJobs: vi.fn(async () => {
          throw new Error('simulated kubernetes failure')
        }),
      }),
    )

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () =>
          buildTemporalAdapter({
            message: 'temporal configuration resolved',
          }),
        checkDatabase: async () => ({
          ...buildDatabaseStatus({
            latency_ms: 1,
          }),
        }),
      },
    )

    expect(status.workflows).toEqual({
      active_job_runs: 0,
      recent_failed_jobs: 0,
      backoff_limit_exceeded_jobs: 0,
      window_minutes: 15,
      top_failure_reasons: [],
      data_confidence: 'unknown',
      collection_errors: 1,
      collected_namespaces: 0,
      target_namespaces: 1,
      message:
        'workflow reliability unavailable (1/1 namespace queries failed); sample errors: agents: simulated kubernetes failure',
    })
    expect(status.dependency_quorum).toMatchObject({
      decision: 'block',
      reasons: ['workflows_data_unknown'],
      message:
        'Control-plane dependency quorum is blocked. workflow reliability unavailable (1/1 namespace queries failed); sample errors: agents: simulated kubernetes failure',
    })
    expect(status.dependency_quorum.degradation_scope).toBe('global')
    expect(status.dependency_quorum.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment: 'dependency_quorum',
          status: 'blocked',
          scope: 'global',
          confidence: 'low',
        }),
      ]),
    )
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('workflows')
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('runtime:workflows')
  })

  it('throws when kube gateway construction fails', async () => {
    vi.spyOn(kubeGatewayModule, 'createKubeGateway').mockImplementation(() => {
      throw new Error('simulated kube gateway creation failure')
    })
    await expect(
      buildControlPlaneStatus(
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
          getHeartbeat: createHeartbeatResolver(),
          getAgentsControllerHealth: () => healthyController,
          getSupportingControllerHealth: () => healthyController,
          getOrchestrationControllerHealth: () => healthyController,
          resolveTemporalAdapter: async () =>
            buildTemporalAdapter({
              message: 'temporal configuration resolved',
            }),
          checkDatabase: async () => buildDatabaseStatus(),
          resolveExecutionTrust: async () => healthyExecutionTrustSnapshot,
          resolveRuntimeAdmission: () => healthyRuntimeAdmissionSnapshot,
        },
      ),
    ).rejects.toThrow('simulated kube gateway creation failure')
  })

  it('marks namespace degraded when migration consistency reports drift', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment])

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () =>
          buildTemporalAdapter({
            message: 'temporal configuration resolved',
          }),
        checkDatabase: async () =>
          buildDatabaseStatus(
            {
              status: 'degraded',
              message: 'migration drift detected',
            },
            {
              status: 'degraded',
              unapplied_count: 1,
              unexpected_count: 0,
              missing_migrations: ['20260305_future_migration'],
              unexpected_migrations: [],
              message: 'migration drift detected',
            },
          ),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.database.migration_consistency.status).toBe('degraded')
    expect(status.database.migration_consistency.unapplied_count).toBe(1)
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('database')
    expect(status.namespaces[0]?.status).toBe('degraded')
  })

  it('uses authoritative heartbeat rows when the serving pod has controllers disabled locally', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const locallyDisabledController = {
      enabled: false,
      started: false,
      namespaces: ['agents'],
      crdsReady: null,
      missingCrds: [],
      lastCheckedAt: '2026-01-20T00:00:00Z',
      agentRunIngestion: [],
    }

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => locallyDisabledController,
        getSupportingControllerHealth: () => locallyDisabledController,
        getOrchestrationControllerHealth: () => locallyDisabledController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.controllers.every((controller) => controller.status === 'healthy')).toBe(true)
    expect(status.controllers.every((controller) => controller.authority.mode === 'heartbeat')).toBe(true)
    expect(status.controllers[0]?.authority.source_deployment).toBe('agents-controllers')
    expect(status.runtime_adapters.find((adapter) => adapter.name === 'workflow')?.authority.mode).toBe('heartbeat')
    expect(status.dependency_quorum).toMatchObject({
      decision: 'allow',
      reasons: [],
      message: 'Control-plane admission dependencies are healthy.',
    })
    expect(status.control_plane_controller_witness).toMatchObject({
      decision: 'allow_with_split',
      reason_codes: ['controller_process_heartbeat_authoritative'],
      deployment_available: true,
      watch_epoch_current: true,
      controller_self_report_current: true,
    })
    expect(status.negative_evidence_router.negative_evidence_refs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'agentrun_ingestion_unknown',
        }),
      ]),
    )
    expect(status.action_slo_budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'allow',
        }),
      ]),
    )
  })

  it('uses healthy agents-controllers rollout when split-topology heartbeats report disabled controllers', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const locallyDisabledController = {
      enabled: false,
      started: false,
      namespaces: ['agents'],
      crdsReady: null,
      missingCrds: [],
      lastCheckedAt: '2026-01-20T00:00:00Z',
      agentRunIngestion: [],
    }

    const splitTopologyRows = buildHeartbeatRows({
      'agents-controller': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'agents controller disabled',
      },
      'supporting-controller': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'supporting controller disabled',
      },
      'orchestration-controller': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'orchestration controller disabled',
      },
      'workflow-runtime': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'workflow runtime disabled',
      },
    })

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(splitTopologyRows),
        getAgentsControllerHealth: () => locallyDisabledController,
        getSupportingControllerHealth: () => locallyDisabledController,
        getOrchestrationControllerHealth: () => locallyDisabledController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.controllers.every((controller) => controller.status === 'healthy')).toBe(true)
    expect(status.controllers.every((controller) => controller.authority.mode === 'rollout')).toBe(true)
    expect(status.controllers[0]?.authority.source_deployment).toBe('agents-controllers')
    expect(status.runtime_adapters.find((adapter) => adapter.name === 'workflow')).toMatchObject({
      available: true,
      status: 'configured',
      authority: {
        mode: 'rollout',
        source_deployment: 'agents-controllers',
      },
    })
    expect(status.runtime_adapters.find((adapter) => adapter.name === 'job')).toMatchObject({
      available: true,
      status: 'configured',
      authority: {
        mode: 'rollout',
        source_deployment: 'agents-controllers',
      },
    })
    expect(status.dependency_quorum).toMatchObject({
      decision: 'allow',
      reasons: [],
      message: 'Control-plane admission dependencies are healthy.',
    })
    expect(status.control_plane_controller_witness).toMatchObject({
      decision: 'repair_only',
      reason_codes: ['controller_witness_split'],
      deployment_available: true,
      watch_epoch_current: true,
      controller_self_report_current: false,
    })
    expect(status.negative_evidence_router.negative_evidence_refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'current_runtime_negative',
          reason: 'controller_witness_split',
        }),
      ]),
    )
    expect(status.negative_evidence_router.negative_evidence_refs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'agentrun_ingestion_unknown',
        }),
      ]),
    )
    expect(status.action_slo_budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          decision: 'allow',
        }),
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'repair_only',
          downgrade_reasons: ['controller_witness_split'],
        }),
      ]),
    )
    expect(status.material_action_activation_receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'hold',
          controller_witness_refs: status.control_plane_controller_witness.witness_refs,
        }),
      ]),
    )
    expect(status.source_rollout_truth_exchange.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_normal',
          settlement_state: 'heartbeat_projection_split',
          action_decision: 'hold',
        }),
      ]),
    )
  })

  it('uses available agents-controllers rollout when split-topology rollout is degraded mid-update', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, availableButDegradedAgentsControllersRolloutDeployment])

    const locallyDisabledController = {
      enabled: false,
      started: false,
      namespaces: ['agents'],
      crdsReady: null,
      missingCrds: [],
      lastCheckedAt: '2026-01-20T00:00:00Z',
      agentRunIngestion: [],
    }

    const splitTopologyRows = buildHeartbeatRows({
      'agents-controller': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'agents controller disabled',
      },
      'supporting-controller': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'supporting controller disabled',
      },
      'orchestration-controller': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'orchestration controller disabled',
      },
      'workflow-runtime': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'workflow runtime disabled',
      },
    })

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(splitTopologyRows),
        getAgentsControllerHealth: () => locallyDisabledController,
        getSupportingControllerHealth: () => locallyDisabledController,
        getOrchestrationControllerHealth: () => locallyDisabledController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.controllers.every((controller) => controller.status === 'healthy')).toBe(true)
    expect(status.controllers.every((controller) => controller.authority.mode === 'rollout')).toBe(true)
    expect(status.controllers[0]?.message).toBe('derived from available agents-controllers rollout')
    expect(status.runtime_adapters.find((adapter) => adapter.name === 'workflow')?.message).toBe(
      'workflow runtime derived from available agents-controllers rollout',
    )
    expect(status.dependency_quorum).toMatchObject({
      decision: 'allow',
      reasons: [],
      message: 'Control-plane admission dependencies are healthy.',
    })
  })

  it('fails closed to unknown authority when a controller heartbeat is missing', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment])

    const rows = buildHeartbeatRows().filter(
      (row) => row.component !== 'agents-controller' && row.component !== 'workflow-runtime',
    )

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(rows),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.controllers.find((controller) => controller.name === 'agents-controller')).toMatchObject({
      status: 'unknown',
      authority: {
        mode: 'unknown',
      },
    })
    expect(status.runtime_adapters.find((adapter) => adapter.name === 'workflow')).toMatchObject({
      status: 'unknown',
      authority: {
        mode: 'unknown',
      },
    })
    expect(status.dependency_quorum.decision).toBe('block')
    expect(status.dependency_quorum.reasons).toContain('agents_controller_status_unknown')
    expect(status.dependency_quorum.reasons).toContain('workflow_runtime_status_unknown')
    expect(status.dependency_quorum.reasons).not.toContain('agents_controller_unavailable')
    expect(status.dependency_quorum.degradation_scope).toBe('global')
  })

  it('buildExecutionTrust marks blocked trust when a tracked swarm has an active freeze', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Frozen',
          freezeReason: 'ConsecutiveFailures',
          freezeUntil: '2026-01-20T00:40:00Z',
          requirementsPending: 2,
          requirementsLastSeen: '2026-01-20T00:00:00Z',
          stageStates: {
            discover: {
              phase: 'Frozen',
              healthy: false,
              cadence: '1m',
              lastRunTime: '2026-01-20T00:00:00Z',
              consecutiveFailures: 1,
            },
            plan: {
              phase: 'Running',
              healthy: false,
              cadence: '1m',
              lastRunTime: '2026-01-20T00:00:00Z',
              consecutiveFailures: 1,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('blocked')
    expect(snapshot.executionTrust.blocking_windows.some((window) => window.class === 'blocked')).toBe(true)
    expect(snapshot.executionTrust.reason).toContain('execution trust blocked')
    expect(snapshot.swarms).toHaveLength(1)
    expect(snapshot.swarms[0]?.freeze).toMatchObject({
      reason: 'ConsecutiveFailures',
    })
    expect(snapshot.stages).toHaveLength(4)
    expect(snapshot.stages.some((stage) => stage.phase === 'Frozen')).toBe(true)
  })

  it('buildExecutionTrust degrades instead of blocking during active stale-stage recovery freezes', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Frozen',
          freezeReason: 'StageStaleness',
          freezeUntil: '2026-01-20T00:40:00Z',
          requirementsPending: 2,
          requirementsLastSeen: '2026-01-20T00:00:00Z',
          stageStates: {
            discover: {
              phase: 'Frozen',
              healthy: false,
              cadence: '1m',
              lastRunTime: '2026-01-20T00:00:00Z',
              consecutiveFailures: 0,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('degraded')
    expect(snapshot.executionTrust.blocking_windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'swarms',
          name: 'jangar-control-plane',
          reason: 'swarm freeze active (StageStaleness)',
          class: 'degraded',
        }),
        expect.objectContaining({
          type: 'stages',
          name: 'jangar-control-plane:discover',
          reason: 'discover delayed by swarm freeze',
          class: 'degraded',
        }),
      ]),
    )
  })

  it('buildExecutionTrust ignores inactive NotFrozen freeze records with future timestamps', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Frozen',
          freezeReason: 'NotFrozen',
          freezeUntil: '2026-01-20T00:40:00Z',
          requirementsPending: 0,
          requirementsLastSeen: '2026-01-20T00:19:00Z',
          stageStates: {
            discover: {
              phase: 'Frozen',
              healthy: true,
              fresh: true,
              cadence: '1m',
              recentSuccessAt: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
            plan: {
              phase: 'Frozen',
              healthy: true,
              fresh: true,
              cadence: '1m',
              recentSuccessAt: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
            implement: {
              phase: 'Frozen',
              healthy: true,
              fresh: true,
              cadence: '1m',
              recentSuccessAt: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
            verify: {
              phase: 'Frozen',
              healthy: true,
              fresh: true,
              cadence: '1m',
              recentSuccessAt: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('healthy')
    expect(snapshot.executionTrust.blocking_windows).toEqual([])
    expect(snapshot.swarms[0]).toMatchObject({
      phase: 'Active',
      ready: true,
      freeze: {
        reason: 'NotFrozen',
        until: '2026-01-20T00:40:00Z',
      },
    })
    expect(snapshot.stages.map((stage) => stage.phase)).toEqual(['Active', 'Active', 'Active', 'Active'])
  })

  it('buildExecutionTrust degrades when freeze expiry is unreconciled', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Frozen',
          freezeReason: 'StageStaleness',
          freezeUntil: '2026-01-20T00:05:00Z',
          requirementsPending: 0,
          requirementsLastSeen: '2026-01-20T00:19:00Z',
          stageStates: {
            discover: {
              phase: 'Running',
              healthy: true,
              cadence: '1m',
              lastRunTime: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
            plan: {
              phase: 'Running',
              healthy: true,
              cadence: '1m',
              lastRunTime: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
            implement: {
              phase: 'Running',
              healthy: true,
              cadence: '1m',
              lastRunTime: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
            verify: {
              phase: 'Running',
              healthy: true,
              cadence: '1m',
              lastRunTime: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('degraded')
    expect(snapshot.executionTrust.blocking_windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'swarms',
          name: 'jangar-control-plane',
          reason: 'freeze expiry unreconciled (StageStaleness)',
          class: 'degraded',
        }),
      ]),
    )
    expect(snapshot.swarms[0]).toMatchObject({
      name: 'jangar-control-plane',
      phase: 'Recovering',
      ready: false,
    })
    expect(snapshot.stages[0]).toMatchObject({
      stage: 'discover',
      phase: 'Running',
      last_failure_reason: 'discover waiting for freeze reconciliation',
    })
  })

  it('buildExecutionTrust keeps expired frozen stages degraded while reconciliation is pending', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Frozen',
          freezeReason: 'StageStaleness',
          freezeUntil: '2026-01-20T00:05:00Z',
          requirementsPending: 5,
          requirementsLastSeen: '2026-01-19T00:00:00Z',
          stageStates: {
            discover: {
              phase: 'Frozen',
              healthy: false,
              cadence: '1h',
              lastRunTime: '2026-01-19T00:00:00Z',
              consecutiveFailures: 0,
            },
            plan: {
              phase: 'Frozen',
              healthy: false,
              cadence: '1h',
              lastRunTime: '2026-01-19T00:00:00Z',
              consecutiveFailures: 0,
            },
            implement: {
              phase: 'Frozen',
              healthy: false,
              cadence: '1h',
              lastRunTime: '2026-01-19T00:00:00Z',
              consecutiveFailures: 0,
            },
            verify: {
              phase: 'Frozen',
              healthy: false,
              cadence: '1h',
              lastRunTime: '2026-01-19T00:00:00Z',
              consecutiveFailures: 0,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('degraded')
    expect(snapshot.executionTrust.blocking_windows.some((window) => window.class === 'blocked')).toBe(false)
    expect(snapshot.executionTrust.blocking_windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'swarms',
          name: 'jangar-control-plane',
          reason: 'freeze expiry unreconciled (StageStaleness)',
          class: 'degraded',
        }),
        expect.objectContaining({
          type: 'stages',
          name: 'jangar-control-plane:discover',
          reason: 'discover waiting for freeze reconciliation',
          class: 'degraded',
        }),
      ]),
    )
    expect(snapshot.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'discover',
          phase: 'Recovering',
          stale: true,
          last_failure_reason: 'discover waiting for freeze reconciliation',
        }),
      ]),
    )
  })

  it('buildExecutionTrust marks degraded trust when requirements and stages are unhealthy', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Active',
          requirementsPending: 1,
          requirementsLastSeen: '2026-01-20T00:00:00Z',
          stageStates: {
            discover: {
              phase: 'Running',
              healthy: true,
              cadence: '1h',
              lastRunTime: '2026-01-20T00:00:00Z',
              consecutiveFailures: 0,
            },
            plan: {
              phase: 'Running',
              healthy: false,
              cadence: '1h',
              lastRunTime: '2026-01-20T00:00:00Z',
              consecutiveFailures: 0,
            },
            implement: {
              phase: 'Running',
              healthy: true,
              cadence: '1h',
              lastRunTime: '2026-01-20T00:00:00Z',
              consecutiveFailures: 3,
            },
            verify: {
              phase: 'Running',
              healthy: true,
              cadence: '1h',
              lastRunTime: '2026-01-20T00:00:00Z',
              consecutiveFailures: 0,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('degraded')
    expect(snapshot.executionTrust.blocking_windows.some((window) => window.class === 'degraded')).toBe(true)
    expect(snapshot.executionTrust.blocking_windows.some((window) => window.class === 'blocked')).toBe(false)
    expect(snapshot.swarms).toHaveLength(1)
    expect(snapshot.stages).toHaveLength(4)
  })

  it('buildExecutionTrust uses recent stage successes when schedule lastRunTime is stale', async () => {
    const recentSuccessAt = '2026-01-20T02:30:00Z'
    const staleRunAt = '2026-01-20T00:00:00Z'
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Active',
          requirementsPending: 0,
          requirementsLastSeen: staleRunAt,
          stageStates: {
            discover: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentSuccessAt,
              consecutiveFailures: 0,
            },
            plan: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentSuccessAt,
              consecutiveFailures: 0,
            },
            implement: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentSuccessAt,
              consecutiveFailures: 0,
            },
            verify: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentSuccessAt,
              consecutiveFailures: 0,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T03:00:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('healthy')
    expect(snapshot.executionTrust.blocking_windows).toHaveLength(0)
    expect(snapshot.stages.every((stage) => stage.last_run_at === new Date(recentSuccessAt).toISOString())).toBe(true)
    expect(snapshot.stages.every((stage) => stage.stale === false)).toBe(true)
  })

  it('buildExecutionTrust uses recent active runs when schedule lastRunTime is stale', async () => {
    const recentActiveAt = '2026-01-20T02:30:00Z'
    const staleRunAt = '2026-01-20T00:00:00Z'
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Active',
          requirementsPending: 0,
          requirementsLastSeen: staleRunAt,
          stageStates: {
            discover: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentActiveAt,
              consecutiveFailures: 0,
            },
            plan: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentActiveAt,
              consecutiveFailures: 0,
            },
            implement: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentActiveAt,
              consecutiveFailures: 0,
            },
            verify: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentActiveAt,
              consecutiveFailures: 0,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T03:00:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('healthy')
    expect(snapshot.executionTrust.blocking_windows).toHaveLength(0)
    expect(snapshot.stages.every((stage) => stage.last_run_at === new Date(recentActiveAt).toISOString())).toBe(true)
    expect(snapshot.stages.every((stage) => stage.stale === false)).toBe(true)
  })

  it('buildExecutionTrust prefers status observed generation over metadata generation', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          metadataGeneration: 9,
          observedGeneration: 4,
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.swarms[0]?.observed_generation).toBe(4)
  })

  it('always includes execution trust fields in status', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const status = await buildStatus(
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveEmpiricalServices: async () => ({
          forecast: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'forecast service ready',
            authoritative: true,
            calibration_status: 'ready',
            eligible_models: ['chronos'],
          },
          lean: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'LEAN runner ready',
            authoritative: true,
            authoritative_modes: ['research_backtest'],
          },
          jobs: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'empirical jobs fresh',
            authoritative: true,
            eligible_jobs: ['benchmark_parity', 'foundation_router_parity'],
            stale_jobs: [],
          },
        }),
      },
    )

    expect(status.execution_trust).toEqual(healthyExecutionTrust)
    expect(status.swarms).toEqual([])
    expect(status.stages).toEqual([])
    expect(status.dependency_quorum).toMatchObject({
      decision: 'allow',
      reasons: [],
      message: 'Control-plane admission dependencies are healthy.',
    })
  })

  it('adds execution trust to quorum segments and blocks on blocked trust', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const status = await buildStatus(
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
        now: () => new Date('2026-01-20T00:20:00Z'),
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveEmpiricalServices: async () => ({
          forecast: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'forecast service ready',
            authoritative: true,
            calibration_status: 'ready',
            eligible_models: ['chronos'],
          },
          lean: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'LEAN runner ready',
            authoritative: true,
            authoritative_modes: ['research_backtest'],
          },
          jobs: {
            status: 'healthy',
            endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
            message: 'empirical jobs fresh',
            authoritative: true,
            eligible_jobs: ['benchmark_parity', 'foundation_router_parity'],
            stale_jobs: [],
          },
        }),
        resolveExecutionTrust: async () => ({
          executionTrust: blockedExecutionTrust,
          swarms: [blockedExecutionTrustSwarm],
          stages: blockedExecutionTrustStages,
        }),
      },
    )

    expect(status.execution_trust).toMatchObject(blockedExecutionTrust)
    expect(status.swarms).toEqual([blockedExecutionTrustSwarm])
    expect(status.stages).toEqual(blockedExecutionTrustStages)
    expect(status.dependency_quorum).toMatchObject({
      decision: 'block',
      reasons: ['execution_trust_blocked'],
      message: 'Control-plane dependency quorum is blocked.',
    })
    expect(status.dependency_quorum.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment: 'freshness_authority',
          status: 'blocked',
          scope: 'global',
          confidence: 'low',
          reasons: ['execution_trust_blocked'],
        }),
      ]),
    )
    expect(status.stage_clearance_packets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'discover',
          action_class: 'dispatch_normal',
          decision: 'hold',
          max_launches: 0,
          reason_codes: expect.arrayContaining(['swarm_freeze_active', 'stage_discover_stale']),
        }),
      ]),
    )
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('execution_trust')
  })
})
