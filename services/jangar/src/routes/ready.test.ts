import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildControlPlaneControllerIngestionSettlement,
  type AgentRunIngestionStatus,
} from '@proompteng/agent-contracts'

const originalEnv = { ...process.env }
delete originalEnv.JANGAR_TORGHUT_STATUS_URL
delete originalEnv.JANGAR_TORGHUT_STATUS_TIMEOUT_MS
const originalFetch = globalThis.fetch

const buildJsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const agentsControlPlaneClientMocks = vi.hoisted(() => ({
  getAgentsReadySnapshot: vi.fn(),
  getAgentsControlPlaneStatusSnapshot: vi.fn(),
}))

const controlPlaneStatusMocks = vi.hoisted(() => ({
  buildExecutionTrust: vi.fn(),
}))

const memoryProviderHealthMocks = vi.hoisted(() => ({
  getMemoryProviderHealth: vi.fn(),
}))

const metricsMocks = vi.hoisted(() => ({
  getMetricsSinkPressureSummary: vi.fn(),
}))

const githubReviewIngestMocks = vi.hoisted(() => ({
  getGithubReviewIngestPressureSummary: vi.fn(),
}))

vi.mock('@proompteng/agent-contracts', async () => {
  const actual = await vi.importActual<typeof import('@proompteng/agent-contracts')>('@proompteng/agent-contracts')
  return {
    ...actual,
    getAgentsReadySnapshot: agentsControlPlaneClientMocks.getAgentsReadySnapshot,
    getAgentsControlPlaneStatusSnapshot: agentsControlPlaneClientMocks.getAgentsControlPlaneStatusSnapshot,
  }
})
vi.mock('~/server/memory-provider-health', () => memoryProviderHealthMocks)
vi.mock('~/server/metrics', () => metricsMocks)
vi.mock('~/server/github-review-ingest', () => githubReviewIngestMocks)
vi.mock('~/server/control-plane-execution-trust', async () => {
  const actual = await vi.importActual<typeof import('~/server/control-plane-execution-trust')>(
    '~/server/control-plane-execution-trust',
  )
  return {
    ...actual,
    buildExecutionTrust: controlPlaneStatusMocks.buildExecutionTrust,
  }
})

const buildRuntimeKit = (overrides: Record<string, unknown> = {}) => ({
  runtime_kit_id: 'runtime-kit:serving:1',
  kit_class: 'serving',
  subject_ref: 'jangar:/ready',
  image_ref: 'runtime:local',
  workspace_contract_version: 'shadow-v1',
  component_digest: 'digest-serving',
  decision: 'healthy',
  observed_at: '2026-03-08T21:00:00Z',
  fresh_until: '2026-03-08T21:05:00Z',
  producer_revision: 'shadow-v1',
  reason_codes: [],
  components: [],
  ...overrides,
})

const buildAdmissionPassport = (overrides: Record<string, unknown> = {}) => ({
  admission_passport_id: 'passport:serving:1',
  consumer_class: 'serving',
  authority_session_id: 'authority-session:1',
  recovery_case_set_digest: 'recovery-1',
  runtime_kit_set_digest: 'runtime-1',
  decision: 'allow',
  reason_codes: [],
  required_subjects: [],
  required_runtime_kits: ['runtime-kit:serving:1'],
  issued_at: '2026-03-08T21:00:00Z',
  fresh_until: '2026-03-08T21:05:00Z',
  producer_revision: 'shadow-v1',
  ...overrides,
})

const buildRecoveryWarrant = (overrides: Record<string, unknown> = {}) => ({
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
  opened_at: '2026-03-08T21:00:00Z',
  sealed_at: '2026-03-08T21:00:00Z',
  superseded_at: null,
  reason_codes: [],
  ...overrides,
})

const buildRuntimeProofCell = (overrides: Record<string, unknown> = {}) => ({
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
  observed_at: '2026-03-08T21:00:00Z',
  expires_at: '2026-03-08T21:05:00Z',
  ...overrides,
})

const buildProjectionWatermark = (overrides: Record<string, unknown> = {}) => ({
  projection_watermark_id: 'projection-watermark:ready:1',
  consumer_key: 'jangar_ready',
  recovery_warrant_id: 'recovery-warrant:serving:1',
  projection_digest: 'projection-digest-1',
  source_ref: 'admission-passport:passport:serving:1',
  observed_at: '2026-03-08T21:00:00Z',
  expires_at: '2026-03-08T21:05:00Z',
  status: 'fresh',
  reason_codes: [],
  ...overrides,
})

const buildRuntimeAdmissionSnapshot = (
  overrides: Partial<{
    runtimeKits: Array<Record<string, unknown>>
    admissionPassports: Array<Record<string, unknown>>
    servingPassportId: string | null
    recoveryWarrants: Array<Record<string, unknown>>
    runtimeProofCells: Array<Record<string, unknown>>
    projectionWatermarks: Array<Record<string, unknown>>
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
      content_hash: 'digest-collaboration',
      artifact_ref: 'jangar:codex:nats-collaboration',
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

const buildAgentsControllerHealth = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  started: true,
  namespaces: ['agents'],
  crdsReady: true,
  missingCrds: [],
  lastCheckedAt: '2026-03-08T21:00:00Z',
  agentRunIngestion: [],
  ...overrides,
})

const buildLeaderElection = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  required: true,
  isLeader: true,
  leaseName: 'agents-controller-leader',
  leaseNamespace: 'agents',
  identity: 'agents-controllers-1',
  lastTransitionAt: '2026-03-08T21:00:00Z',
  lastAttemptAt: '2026-03-08T21:00:00Z',
  lastSuccessAt: '2026-03-08T21:00:00Z',
  lastError: null,
  ...overrides,
})

const buildAgentsReadySnapshot = (overrides: Record<string, unknown> = {}) => {
  const agentsController =
    (overrides.agentsController as Record<string, unknown> | undefined) ?? buildAgentsControllerHealth()
  const orchestrationController =
    (overrides.orchestrationController as Record<string, unknown> | undefined) ?? buildAgentsControllerHealth()
  const supportingController =
    (overrides.supportingController as Record<string, unknown> | undefined) ?? buildAgentsControllerHealth()
  const namespaces = (overrides.namespaces as string[] | undefined) ?? ['agents']
  const status = (overrides.status as 'ok' | 'degraded' | undefined) ?? 'ok'
  const httpReady = (overrides.httpReady as boolean | undefined) ?? true
  const reasonCodes = (overrides.reasonCodes as string[] | undefined) ?? []
  const leaderElection = (overrides.leaderElection as Record<string, unknown> | undefined) ?? buildLeaderElection()
  const agentRunIngestion = (overrides.agentRunIngestion as Record<string, unknown>[] | undefined) ?? [
    {
      namespace: 'agents',
      status: reasonCodes.includes('agentrun_ingestion_not_ready') ? 'degraded' : 'healthy',
      message: reasonCodes.includes('agentrun_ingestion_not_ready')
        ? 'AgentRun ingestion not ready according to Agents service'
        : 'AgentRun ingestion healthy',
      last_watch_event_at: '2026-03-08T21:00:00Z',
      last_resync_at: '2026-03-08T21:00:00Z',
      untouched_run_count: 0,
      oldest_untouched_age_seconds: null,
    },
  ]

  return {
    available: true,
    httpStatus: httpReady ? 200 : 503,
    status,
    httpReady,
    reasonCodes,
    namespaces,
    leaderElection,
    agentRunIngestion,
    agentsController,
    orchestrationController,
    supportingController,
    raw: {
      schemaVersion: 'agents.proompteng.ai/ready/v1',
      status,
      service: 'agents',
      httpReady,
      reason_codes: reasonCodes,
      namespaces,
      agentrun_ingestion: agentRunIngestion,
      leaderElection,
      agentsController,
      orchestrationController,
      supportingController,
    },
    error: null,
    ...overrides,
  }
}

const buildAgentsControlPlaneStatusSnapshot = (overrides: Record<string, unknown> = {}) => {
  const namespace = (overrides.namespace as string | undefined) ?? 'agents'
  const runtimeAdmission =
    (overrides.runtimeAdmission as ReturnType<typeof buildRuntimeAdmissionSnapshot> | undefined) ??
    buildRuntimeAdmissionSnapshot()
  const agentRunIngestion =
    (overrides.agentrun_ingestion as AgentRunIngestionStatus | undefined) ??
    ({
      namespace,
      status: 'healthy',
      message: 'AgentRun ingestion healthy',
      last_watch_event_at: '2026-03-08T21:00:00Z',
      last_resync_at: '2026-03-08T21:00:00Z',
      untouched_run_count: 0,
      oldest_untouched_age_seconds: null,
    } satisfies AgentRunIngestionStatus)
  const databaseStatus = {
    configured: false,
    connected: false,
    status: 'disabled' as const,
    message: 'DATABASE_URL is not set',
    latency_ms: 0,
    migration_consistency: {
      status: 'unknown' as const,
      migration_table: null,
      registered_count: 0,
      applied_count: 0,
      unapplied_count: 0,
      unexpected_count: 0,
      latest_registered: null,
      latest_applied: null,
      missing_migrations: [],
      unexpected_migrations: [],
      message: 'migration consistency unavailable',
    },
  }
  const controllerWitness = {
    mode: 'shadow' as const,
    design_artifact:
      'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
    quorum_id: `controller-witness:${namespace}:agents-control-plane-status`,
    generated_at: '2026-03-08T21:00:00Z',
    expires_at: '2026-03-08T21:01:00Z',
    namespace,
    decision: 'allow' as const,
    reason_codes: [],
    message: 'Agents controller ingestion self-report is current',
    witness_refs: [
      `witness:kubernetes_deployment:${namespace}:agents-control-plane-status`,
      `witness:watch_epoch:${namespace}:agents-control-plane-status`,
      `witness:agentrun_ingestion:${namespace}:agents-control-plane-status`,
    ],
    deployment_available: true,
    watch_epoch_current: true,
    controller_self_report_current: true,
    witnesses: [],
    rollback_target: 'use Agents controller logs and AgentRun status conditions for controller ingestion proof',
  }
  const rolloutHealth = {
    status: 'healthy' as const,
    observed_deployments: 2,
    degraded_deployments: 0,
    deployments: [],
    message: '2 configured deployment(s) healthy',
  }
  const controllerIngestionSettlement = buildControlPlaneControllerIngestionSettlement({
    now: new Date('2026-03-08T21:00:00Z'),
    namespace,
    mode: 'observe',
    servingReadiness: 'ok',
    controllerWitness,
    agentRunIngestion,
    executionTrust: {
      status: 'healthy',
      reason: 'execution trust is healthy.',
      last_evaluated_at: '2026-03-08T21:00:00Z',
      blocking_windows: [],
      evidence_summary: [],
    },
    database: databaseStatus,
    rolloutHealth,
  })
  const status = {
    service: 'agents',
    generated_at: '2026-03-08T21:00:00Z',
    leader_election: {
      enabled: true,
      required: true,
      is_leader: true,
      lease_name: 'agents-controller-leader',
      lease_namespace: namespace,
      identity: 'agents-controllers-1',
      last_transition_at: '2026-03-08T21:00:00Z',
      last_attempt_at: '2026-03-08T21:00:00Z',
      last_success_at: '2026-03-08T21:00:00Z',
      last_error: '',
    },
    controllers: [
      {
        name: 'agents-controller',
        enabled: true,
        started: true,
        scope_namespaces: [namespace],
        crds_ready: true,
        missing_crds: [],
        last_checked_at: '2026-03-08T21:00:00Z',
        status: 'healthy',
        message: '',
        authority: {
          mode: 'local',
          namespace,
          source_deployment: '',
          source_pod: '',
          observed_at: '2026-03-08T21:00:00Z',
          fresh: true,
          message: 'agents-controller local controller state',
        },
      },
    ],
    runtime_adapters: [],
    database: databaseStatus,
    grpc: {
      enabled: false,
      address: '',
      status: 'disabled',
      message: 'gRPC disabled',
    },
    watch_reliability: {
      status: 'healthy',
      window_minutes: 15,
      observed_streams: 1,
      total_events: 8,
      total_errors: 0,
      total_restarts: 0,
      streams: [
        {
          resource: 'agentruns.agents.proompteng.ai',
          namespace,
          events: 8,
          errors: 0,
          restarts: 0,
          last_seen_at: '2026-03-08T21:00:00Z',
        },
      ],
    },
    agentrun_ingestion: agentRunIngestion,
    control_plane_controller_witness: controllerWitness,
    controller_ingestion_settlement: controllerIngestionSettlement,
    runtime_kits: runtimeAdmission.runtimeKits,
    admission_passports: runtimeAdmission.admissionPassports,
    serving_passport_id: runtimeAdmission.servingPassportId,
    recovery_warrants: runtimeAdmission.recoveryWarrants,
    runtime_proof_cells: runtimeAdmission.runtimeProofCells,
    projection_watermarks: runtimeAdmission.projectionWatermarks,
    workflows: {
      active_job_runs: 0,
      recent_failed_jobs: 0,
      backoff_limit_exceeded_jobs: 0,
      window_minutes: 60,
      top_failure_reasons: [],
      data_confidence: 'high',
      collection_errors: 0,
      collected_namespaces: 1,
      target_namespaces: 1,
      message: '1 namespace collected',
    },
    rollout_health: rolloutHealth,
    namespaces: [{ namespace, status: 'healthy', degraded_components: [] }],
    ...((overrides.controlPlaneStatus as Record<string, unknown> | undefined) ?? {}),
  }

  return {
    available: (overrides.available as boolean | undefined) ?? true,
    httpStatus: (overrides.httpStatus as number | undefined) ?? 200,
    status,
    raw: status,
    error: (overrides.error as string | null | undefined) ?? null,
  }
}

describe('getReadyHandler', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    globalThis.fetch = originalFetch
    vi.clearAllMocks()
    controlPlaneStatusMocks.buildExecutionTrust.mockReset()
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'healthy',
        reason: 'execution trust is healthy.',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [],
        evidence_summary: [],
      },
      swarms: [],
      stages: [],
    })
    memoryProviderHealthMocks.getMemoryProviderHealth.mockReturnValue({
      status: 'healthy',
      reason: 'memory embeddings configured for an explicit OpenAI-compatible endpoint',
      mode: 'self-hosted',
      fallbackActive: false,
      config: {
        apiBaseUrl: 'http://saigak.jangar.svc.cluster.local:11434/v1',
        model: 'qwen3-embedding-saigak:8b',
        dimension: 4096,
        timeoutMs: 15000,
        maxInputChars: 60000,
        hosted: false,
      },
    })
    metricsMocks.getMetricsSinkPressureSummary.mockReturnValue({
      status: 'healthy',
      endpoint: 'http://mimir/otlp/v1/metrics',
      message: 'metrics sink configured',
      reason_codes: [],
    })
    githubReviewIngestMocks.getGithubReviewIngestPressureSummary.mockReturnValue({
      status: 'healthy',
      active_missing_ref_suppressions: 0,
      reason_codes: [],
      message: 'github review ingest healthy',
      evidence_refs: [],
    })

    agentsControlPlaneClientMocks.getAgentsReadySnapshot.mockResolvedValue(buildAgentsReadySnapshot())
    agentsControlPlaneClientMocks.getAgentsControlPlaneStatusSnapshot.mockResolvedValue(
      buildAgentsControlPlaneStatusSnapshot(),
    )
  })

  it('returns 200 when leader is ready and AgentRun ingestion is healthy', async () => {
    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.agents_dependency).toMatchObject({
      status: 'healthy',
      ready: true,
      service_available: true,
      control_plane_available: true,
    })
    expect(body.memory_provider).toMatchObject({
      status: 'healthy',
    })
    expect(body.repair_bid_admission).toMatchObject({
      schema_version: 'jangar.repair-bid-admission-state.v1',
      mode: 'observe',
      torghut_settlement_ledger_ref: null,
    })
    expect(body.repair_bid_admission.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'serve_readonly',
          decision: 'allow',
        }),
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'hold',
        }),
      ]),
    )
    expect(body.evidence_pressure_ledger).toMatchObject({
      schema_version: 'jangar.evidence-pressure-ledger.v1',
      evidence_mode: 'observe',
      watch_backoff_policy: {
        state: 'calm',
      },
      scheduler_handoff: {
        status: 'allow',
      },
    })
    expect(body).not.toHaveProperty('agentsController')
    expect(body).not.toHaveProperty('leaderElection')
    expect(body).not.toHaveProperty('runtime_kits')
    expect(body).not.toHaveProperty('admission_passports')
    expect(body).not.toHaveProperty('recovery_warrants')
    expect(body).not.toHaveProperty('runtime_proof_cells')
    expect(body).not.toHaveProperty('projection_watermarks')
    expect(body).not.toHaveProperty('serving_recovery_warrant_id')
    expect(body).not.toHaveProperty('serving_runtime_proof_cells_healthy')
  }, 30_000)

  it('keeps Jangar domain gates when Agents runtime env leaks into Jangar', async () => {
    process.env.AGENTS_IMAGE = 'registry.example/lab/agents-controller:abc123'

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      status: 'ok',
      service: 'jangar',
      execution_trust: {
        status: 'healthy',
      },
      repair_bid_admission: {
        schema_version: 'jangar.repair-bid-admission-state.v1',
      },
    })
    expect(body.schemaVersion).toBeUndefined()
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenCalled()
  })

  it('projects Torghut revenue-repair business evidence and material evidence settlement at the ready boundary', async () => {
    process.env.JANGAR_TORGHUT_STATUS_URL = 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence'
    agentsControlPlaneClientMocks.getAgentsControlPlaneStatusSnapshot.mockResolvedValue(
      buildAgentsControlPlaneStatusSnapshot({
        controlPlaneStatus: {
          rollout_health: {
            status: 'unknown',
            observed_deployments: 0,
            degraded_deployments: 0,
            deployments: [],
            message: 'runtime evidence unavailable in test',
          },
        },
      }),
    )
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        buildJsonResponse({
          schema_version: 'torghut.consumer-evidence-status.v1',
          route_proven_profit_receipt: {
            schema_version: 'torghut.route-proven-profit-receipt.v1',
            receipt_id: 'torghut-route-proven-profit:ready-test',
            generated_at: '2026-05-14T00:23:00.000Z',
            fresh_until: '2026-05-14T00:38:00.000Z',
            paper_readiness_state: 'blocked',
            live_readiness_state: 'blocked',
            max_notional: '0',
            reason_codes: [],
          },
          alpha_readiness_settlement_conveyor: {
            schema_version: 'torghut.alpha-readiness-settlement-conveyor-ref.v1',
            conveyor_schema_version: 'torghut.alpha-readiness-settlement-conveyor.v1',
            conveyor_id: 'alpha-readiness-settlement-conveyor:ready-test',
            generated_at: '2026-05-14T00:23:00.000Z',
            fresh_until: '2026-05-14T00:38:00.000Z',
            status: 'no_delta',
            settlement_state: 'no_delta',
            reason_codes: ['active_no_delta_lease'],
            selected_hypothesis_id: 'H-MICRO-01',
            selected_value_gate: 'routeable_candidate_count',
            routeable_candidate_count_before: 0,
            routeable_candidate_count_after: 0,
            measured_routeable_candidate_delta: 0,
            active_no_delta_lease_count: 1,
            required_receipt: 'torghut.alpha-readiness-settlement-receipt.v1',
            validation_command:
              'uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py',
            no_delta_release_key: 'alpha-readiness-no-delta:ready-test',
            repeat_launch_decision: 'deny',
            max_notional: '0',
            capital_rule: 'zero_notional_repair_only',
            rollback_target: 'stop emitting alpha_readiness_settlement_conveyor and keep Torghut max_notional=0',
          },
        }),
      )
      .mockResolvedValueOnce(
        buildJsonResponse({
          schema_version: 'torghut.revenue-repair-digest.v1',
          business_state: 'repair_only',
          revenue_ready: false,
          repair_queue: [
            {
              code: 'repair_alpha_readiness',
              reason: 'alpha_readiness_not_promotion_eligible',
              dimension: 'alpha_readiness',
              action: 'clear_hypothesis_blockers_before_capital',
              priority: 70,
              expected_unblock_value: 4,
              source: 'proof_floor.repair_ladder',
              value_gate: 'routeable_candidate_count',
              required_output_receipt: 'torghut.executable-alpha-receipts.v1',
              required_receipts: ['alpha_readiness_receipt', 'hypothesis_promotion_receipt', 'capital_replay_board'],
              max_notional: '0',
              capital_rule: 'zero_notional_repair_only',
              observed_count: 1,
            },
          ],
          executable_alpha_repair_receipts: {
            schema_version: 'torghut.executable-alpha-repair-receipts.v1',
            generated_at: '2026-05-14T00:23:00.000Z',
            fresh_until: '2026-05-14T00:38:00.000Z',
            source_revenue_repair_ref: 'torghut-revenue-repair-digest:ready-test',
            status: 'selected',
            governing_design_ref:
              'docs/torghut/design-system/v6/199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md',
            selected_receipt_id: 'executable-alpha-repair-receipt:ready-test',
            selected_receipt: {
              schema_version: 'torghut.executable-alpha-repair-receipt.v1',
              receipt_id: 'executable-alpha-repair-receipt:ready-test',
              generated_at: '2026-05-14T00:23:00.000Z',
              fresh_until: '2026-05-14T00:38:00.000Z',
              source_revenue_repair_ref: 'torghut-revenue-repair-digest:ready-test',
              hypothesis_id: 'H-MICRO-01',
              repair_class: 'capital_replay_board_refresh',
              target_value_gate: 'routeable_candidate_count',
              reason_codes: ['alpha_readiness_not_promotion_eligible'],
              account_id: 'PA3SX7FYNUTF',
              window: '15m',
              trading_mode: 'live',
              candidate_id: 'chip-paper-microbar-composite@execution-proof',
              strategy_id: 'microbar_volume_continuation_long_top2_chip_v1@paper',
              expected_gate_delta: 'retire_alpha_readiness_not_promotion_eligible',
              required_input_refs: ['capital-replay:ready-test'],
              required_output_receipts: [
                'alpha_readiness_receipt',
                'hypothesis_promotion_receipt',
                'capital_replay_board',
                'torghut.executable-alpha-receipts.v1',
              ],
              validation_commands: [
                'uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py',
              ],
              max_notional: '0',
              capital_rule: 'zero_notional_repair_only',
              no_delta_settlement_required: true,
              jangar_reentry: {
                required_material_reentry_receipt: 'jangar.material-reentry-receipt.v1',
                action_class: 'dispatch_repair',
                max_parallelism: 1,
                max_runtime_seconds: 1200,
                value_gates: ['routeable_candidate_count'],
                rollback_target: 'keep max_notional=0 and live submit disabled',
              },
              rollback_target: 'stop emitting executable alpha repair receipts',
            },
            receipts: [],
            target_value_gate: 'routeable_candidate_count',
            routeable_candidate_count_before: 0,
            max_notional: '0',
            capital_rule: 'zero_notional_repair_only',
            reason_codes: ['alpha_readiness_not_promotion_eligible'],
            rollback_target: 'stop emitting executable alpha repair receipts',
          },
          alpha_repair_closure_board: {
            schema_version: 'torghut.alpha-repair-closure-board.v1',
            board_id: 'alpha-repair-closure-board:ready-test',
            generated_at: '2026-05-14T00:23:00.000Z',
            fresh_until: '2026-05-14T00:38:00.000Z',
            status: 'selected',
            selected_value_gate: 'routeable_candidate_count',
            max_notional: '0',
            capital_rule: 'zero_notional_repair_only',
            alpha_closure_settlement_market: {
              market_id: 'alpha-closure-settlement-market:ready-test',
              status: 'pending_no_delta',
              selected_hypothesis_id: 'H-MICRO-01',
              selected_repair_class: 'feature_replay_closure',
              required_output_receipt: 'torghut.alpha-closure-settlement-receipt.v1',
              active_dedupe_key: 'alpha-window:ready-test',
              no_delta_budget: {
                state: 'consumed',
                used_attempts: 1,
                release_conditions: ['evidence_window_changes'],
              },
            },
          },
        }),
      ) as unknown as typeof globalThis.fetch

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.business_state).toBe('repair_only')
    expect(body.revenue_ready).toBe(false)
    expect(body.affected_value_gate).toBe('routeable_candidate_count')
    expect(body.top_repair_queue_item).toMatchObject({
      code: 'repair_alpha_readiness',
      reason: 'alpha_readiness_not_promotion_eligible',
      required_output_receipt: 'torghut.executable-alpha-receipts.v1',
    })
    expect(body.repair_queue).toEqual([expect.objectContaining({ value_gate: 'routeable_candidate_count' })])
    expect(body.torghut_consumer_evidence).toMatchObject({
      revenue_repair_business_state: 'repair_only',
      revenue_repair_ready: false,
    })
    expect(body.revenue_repair_settlement_custody).toMatchObject({
      schema_version: 'jangar.revenue-repair-settlement-custody.v1',
      mode: 'observe',
      torghut_conveyor_ref: 'alpha-readiness-settlement-conveyor:ready-test',
      selected_hypothesis_id: 'H-MICRO-01',
      selected_value_gate: 'routeable_candidate_count',
      action_class: 'dispatch_repair',
      decision: 'deny',
      reason_codes: expect.arrayContaining([
        'active_no_delta_lease',
        'stage_credit_ledger_missing',
        'source_serving_dispatch_repair_verdict_missing',
        'rollout_health_unknown',
      ]),
      no_delta_release_key: 'alpha-readiness-no-delta:ready-test',
      no_delta_release_state: 'active',
      stage_health: {
        stage_credit_ledger_ref: null,
        dispatch_repair_decision: null,
        reason_codes: ['stage_credit_ledger_missing'],
      },
      rollout_proof: {
        source_serving_verdict_ref: null,
        source_serving_decision: null,
        rollout_health: 'unknown',
        reason_codes: expect.arrayContaining([
          'rollout_health_unknown',
          'source_serving_dispatch_repair_verdict_missing',
        ]),
      },
      validation_command: 'uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py',
      rollback_target: 'stop emitting alpha_readiness_settlement_conveyor and keep Torghut max_notional=0',
    })
    expect(body.controller_ingestion_settlement).toMatchObject({
      schema_version: 'jangar.controller-ingestion-settlement.v1',
      mode: 'observe',
      namespace: 'agents',
      serving_readiness: 'ok',
      controller_witness_ref: 'controller-witness:agents:agents-control-plane-status',
      database_status: 'disabled',
      source_serving_status: 'hold',
      verify_trust_foreclosure_board_ref: expect.any(String),
      selected_repair_ticket: {
        max_notional: '0',
      },
      reason_codes: expect.arrayContaining([
        'database_disabled',
        'source_serving_hold',
        'source_serving_contract_unavailable_on_ready_hot_path',
      ]),
    })
    expect(body.verify_trust_foreclosure_board).toMatchObject({
      schema_version: 'jangar.verify-trust-foreclosure-board.v1',
      mode: 'observe',
      torghut_consumer_evidence_ref: 'torghut-route-proven-profit:ready-test',
      torghut_alpha_repair_closure_board_ref: 'alpha-repair-closure-board:ready-test',
      active_no_delta_release_key: 'alpha-window:ready-test',
      debt_classes: expect.arrayContaining([
        'source_rollout_truth_split',
        'database_projection_not_current',
        'torghut_business_repair_only',
        'torghut_no_delta_active',
        'revenue_repair_settlement_custody_deny',
      ]),
      alpha_repair_reentry_admission: {
        schema_version: 'jangar.alpha-repair-reentry-admission.v1',
        mode: 'observe',
        admission_id: expect.any(String),
        generated_at: expect.any(String),
        fresh_until: expect.any(String),
        selected_value_gate: 'routeable_candidate_count',
        selected_hypothesis_id: 'H-MICRO-01',
        release_key_state: 'active',
        material_action_class: 'dispatch_repair',
        decision: 'deny',
        reason_codes: expect.arrayContaining([
          'source_rollout_truth_split',
          'torghut_no_delta_active',
          'alpha_closure_no_delta_budget_consumed',
          'alpha_closure_no_delta_debt_active',
          'revenue_repair_settlement_custody_deny',
        ]),
        required_output_receipt: 'torghut.alpha-closure-settlement-receipt.v1',
        validation_command:
          "curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.alpha_repair_closure_board'",
        rollback_target: 'stop emitting alpha_readiness_settlement_conveyor and keep Torghut max_notional=0',
      },
    })
    expect(body.verify_trust_foreclosure_board.action_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_class: 'serve_readonly', decision: 'allow' }),
        expect.objectContaining({ action_class: 'torghut_observe', decision: 'hold' }),
        expect.objectContaining({ action_class: 'dispatch_repair', decision: 'block' }),
      ]),
    )
    expect(body.material_gate_digest).toMatchObject({
      schema_version: 'jangar.material-gate-digest.v1',
      material_readiness: 'repair_only',
      alpha_closure_carry: {
        board_id: 'alpha-repair-closure-board:ready-test',
        settlement_market_id: 'alpha-closure-settlement-market:ready-test',
        decision: 'deny',
        reason_codes: expect.arrayContaining(['alpha_closure_no_delta_budget_consumed']),
      },
    })
    expect(body.material_gate_digest.action_class_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          decision: 'deny',
        }),
      ]),
    )
    expect(body.material_evidence_settlement_spine).toMatchObject({
      schema_version: 'jangar.material-evidence-settlement-spine.v1',
      mode: 'observe',
      decision: 'hold',
      transport_truth: {
        consumer_evidence_status: 'stale',
        revenue_repair_topline_status: 'stale',
      },
      business_truth: {
        business_state: 'repair_only',
        revenue_ready: false,
        selected_value_gate: 'routeable_candidate_count',
        routeable_candidate_count: 0,
        max_notional: '0',
      },
      material_truth: {
        material_gate_ref: body.material_gate_digest.digest_id,
        controller_ingestion_settlement_ref: body.controller_ingestion_settlement.settlement_id,
      },
      repair_dispatch_budget: {
        ticket_class: 'none',
        max_notional: '0',
      },
    })
    expect(body.material_evidence_settlement_spine.reason_codes).toEqual(
      expect.arrayContaining([
        'torghut_consumer_evidence_stale',
        'revenue_repair_topline_stale',
        'dispatch_repair_deny',
      ]),
    )
    expect(body.repair_slot_escrow).toMatchObject({
      schema_version: 'jangar.repair-slot-escrow.v1',
      mode: 'observe',
      status: 'block',
      selected_slot_id: null,
      governing_design_refs: expect.arrayContaining([
        'docs/agents/designs/194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md',
        'docs/torghut/design-system/v6/199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md',
      ]),
      blocked_slots: [
        expect.objectContaining({
          action_class: 'dispatch_repair',
          torghut_selected_receipt_id: 'executable-alpha-repair-receipt:ready-test',
          reason_codes: expect.arrayContaining([
            'material_reentry_clearinghouse_missing',
            'stage_credit_ledger_missing',
            'active_no_delta_debt_for_repair_slot',
          ]),
        }),
      ],
      scheduler_handoff: expect.objectContaining({
        status: 'block',
        action_class: 'dispatch_repair',
        max_notional: 0,
      }),
    })
  })

  it('keeps ready revenue topline when consumer evidence transport drops but revenue-repair is current', async () => {
    process.env.JANGAR_TORGHUT_STATUS_URL = 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildJsonResponse({ detail: 'consumer evidence temporarily unavailable' }, 503))
      .mockResolvedValueOnce(
        buildJsonResponse({
          schema_version: 'torghut.revenue-repair-digest.v1',
          business_state: 'repair_only',
          revenue_ready: false,
          repair_queue: [
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
          alpha_readiness_settlement_conveyor: {
            schema_version: 'torghut.alpha-readiness-settlement-conveyor.v1',
            conveyor_id: 'alpha-readiness-settlement-conveyor:ready-fallback',
            generated_at: '2026-05-15T01:30:00.000Z',
            fresh_until: '2026-05-15T01:45:00.000Z',
            status: 'no_delta',
            settlement_state: 'no_delta',
            reason_codes: ['active_no_delta_lease'],
            selected_lane: {
              hypothesis_id: 'H-MICRO-01',
              no_delta_release_key: 'alpha-readiness-no-delta:H-MICRO-01:window-a',
              repeat_launch_decision: 'deny',
            },
            selected_value_gate: 'routeable_candidate_count',
            routeable_candidate_count_before: 0,
            routeable_candidate_count_after: 0,
            measured_routeable_candidate_delta: 0,
            active_no_delta_leases: [{ lease_id: 'alpha-readiness-no-delta-lease:ready-fallback' }],
            required_output_receipt: 'torghut.alpha-readiness-settlement-receipt.v1',
            validation_commands: [
              'uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py',
            ],
            max_notional: '0',
            capital_rule: 'zero_notional_repair_only',
            rollback_target: 'stop emitting alpha_readiness_settlement_conveyor and keep Torghut max_notional=0',
          },
        }),
      )
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(body).toMatchObject({
      status: 'ok',
      business_state: 'repair_only',
      revenue_ready: false,
      affected_value_gate: 'routeable_candidate_count',
      top_repair_queue_item: expect.objectContaining({
        code: 'repair_alpha_readiness',
        value_gate: 'routeable_candidate_count',
        max_notional: '0',
      }),
      torghut_consumer_evidence: {
        status: 'unavailable',
        revenue_repair_business_state: 'repair_only',
        revenue_repair_ready: false,
        revenue_repair_queue: [expect.objectContaining({ code: 'repair_alpha_readiness' })],
        alpha_readiness_settlement_conveyor: expect.objectContaining({
          conveyor_id: 'alpha-readiness-settlement-conveyor:ready-fallback',
        }),
      },
      revenue_repair_settlement_custody: {
        torghut_conveyor_ref: 'alpha-readiness-settlement-conveyor:ready-fallback',
        selected_hypothesis_id: 'H-MICRO-01',
        selected_value_gate: 'routeable_candidate_count',
      },
      material_evidence_settlement_spine: {
        transport_truth: {
          consumer_evidence_status: 'unavailable',
          revenue_repair_topline_status: 'queue_head_inferred',
          revenue_repair_topline_source: 'revenue_repair_queue_head',
        },
        business_truth: {
          business_state: 'repair_only',
          revenue_ready: false,
          top_repair_queue_item: expect.objectContaining({ code: 'repair_alpha_readiness' }),
          selected_value_gate: 'routeable_candidate_count',
          max_notional: '0',
        },
      },
    })
    expect(body.material_evidence_settlement_spine.reason_codes).toEqual(
      expect.arrayContaining(['torghut_consumer_evidence_unavailable', 'topline_inferred_from_queue_head']),
    )
    expect(body.material_evidence_settlement_spine.reason_codes).not.toEqual(
      expect.arrayContaining(['business_state_missing', 'revenue_repair_top_item_missing']),
    )
    expect(body.revenue_repair_settlement_custody.reason_codes).not.toEqual(
      expect.arrayContaining(['business_state_missing', 'revenue_repair_top_item_missing']),
    )
  })

  it('returns 200 and exposes a serving passport when only collaboration runtime debt is blocked', async () => {
    agentsControlPlaneClientMocks.getAgentsControlPlaneStatusSnapshot.mockResolvedValue(
      buildAgentsControlPlaneStatusSnapshot({
        runtimeAdmission: buildRuntimeAdmissionSnapshot({
          runtimeKits: [
            buildRuntimeKit(),
            buildRuntimeKit({
              runtime_kit_id: 'runtime-kit:collaboration:2',
              kit_class: 'collaboration',
              subject_ref: 'agents:codex:nats-collaboration',
              component_digest: 'digest-collaboration-2',
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
        }),
      }),
    )

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.serving_passport_id).toBe('passport:serving:1')
    expect(body).not.toHaveProperty('runtime_kits')
    expect(body).not.toHaveProperty('admission_passports')
    expect(body).not.toHaveProperty('recovery_warrants')
    expect(body).not.toHaveProperty('runtime_proof_cells')
    expect(body).not.toHaveProperty('projection_watermarks')
  })

  it('returns 200 with degraded status when AgentRun ingestion is degraded', async () => {
    agentsControlPlaneClientMocks.getAgentsReadySnapshot.mockResolvedValue(
      buildAgentsReadySnapshot({
        status: 'degraded',
        reasonCodes: ['agentrun_ingestion_not_ready'],
      }),
    )
    agentsControlPlaneClientMocks.getAgentsControlPlaneStatusSnapshot.mockResolvedValue(
      buildAgentsControlPlaneStatusSnapshot({
        agentrun_ingestion: {
          namespace: 'agents',
          status: 'degraded',
          message: 'AgentRun ingestion not ready according to Agents service',
          last_watch_event_at: null,
          last_resync_at: '2026-03-08T21:00:00Z',
          untouched_run_count: 1,
          oldest_untouched_age_seconds: 60,
        },
      }),
    )

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.agents_dependency).toMatchObject({
      status: 'degraded',
      ready: true,
      agentrun_ingestion_ready: false,
    })
  })

  it('returns 200 with degraded status when the active controller is still adopting backlog', async () => {
    agentsControlPlaneClientMocks.getAgentsReadySnapshot.mockResolvedValue(
      buildAgentsReadySnapshot({
        status: 'degraded',
        agentsController: buildAgentsControllerHealth({
          started: false,
        }),
        agentRunIngestion: [
          {
            namespace: 'agents',
            status: 'degraded',
            message: 'active controller is adopting 12 existing AgentRuns',
            last_watch_event_at: '2026-03-08T21:01:00Z',
            last_resync_at: '2026-03-08T21:00:00Z',
            untouched_run_count: 12,
            oldest_untouched_age_seconds: 4_769_263,
          },
        ],
      }),
    )
    agentsControlPlaneClientMocks.getAgentsControlPlaneStatusSnapshot.mockResolvedValue(
      buildAgentsControlPlaneStatusSnapshot({
        agentrun_ingestion: {
          namespace: 'agents',
          status: 'degraded',
          message: 'active controller is adopting 12 existing AgentRuns',
          last_watch_event_at: '2026-03-08T21:01:00Z',
          last_resync_at: '2026-03-08T21:00:00Z',
          untouched_run_count: 12,
          oldest_untouched_age_seconds: 4_769_263,
        },
      }),
    )

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.agents_dependency).toMatchObject({
      status: 'degraded',
      agentrun_ingestion_ready: false,
    })
    expect(body).not.toHaveProperty('agentsController')
  })

  it('returns 200 when leader election is required but this instance is a healthy standby', async () => {
    agentsControlPlaneClientMocks.getAgentsReadySnapshot.mockResolvedValue(
      buildAgentsReadySnapshot({
        leaderElection: buildLeaderElection({
          isLeader: false,
          identity: 'agents-controllers-2',
        }),
      }),
    )

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
  })

  it('reports degraded Agents dependency when standby has not observed a healthy lease attempt', async () => {
    agentsControlPlaneClientMocks.getAgentsReadySnapshot.mockResolvedValue(
      buildAgentsReadySnapshot({
        status: 'degraded',
        httpReady: false,
        leaderElection: buildLeaderElection({
          isLeader: false,
          identity: 'agents-controllers-2',
          lastTransitionAt: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastError: 'lease watch failed',
        }),
      }),
    )

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.agents_dependency).toMatchObject({
      status: 'degraded',
      ready: false,
      http_ready: false,
      service_available: true,
    })
  })

  it('returns 200 when execution trust is healthy', async () => {
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'healthy',
        reason: 'execution trust is healthy.',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [],
        evidence_summary: [],
      },
      swarms: [],
      stages: [],
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.execution_trust).toMatchObject({
      status: 'healthy',
    })
  })

  it('returns 200 when execution trust is degraded', async () => {
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'degraded',
        reason: 'execution trust degraded while freeze expiry repair is in progress',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [
          {
            type: 'swarms',
            scope: 'agents',
            name: 'jangar-control-plane',
            reason: 'freeze expiry unreconciled (StageStaleness)',
            class: 'degraded',
          },
        ],
        evidence_summary: ['freeze expiry unreconciled (StageStaleness)'],
      },
      swarms: [],
      stages: [],
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.execution_trust).toMatchObject({
      status: 'degraded',
    })
  })

  it('returns 200 with degraded status when execution trust is blocked', async () => {
    agentsControlPlaneClientMocks.getAgentsControlPlaneStatusSnapshot.mockResolvedValue(
      buildAgentsControlPlaneStatusSnapshot({
        runtimeAdmission: buildRuntimeAdmissionSnapshot({
          admissionPassports: [
            buildAdmissionPassport({
              admission_passport_id: 'passport:serving:blocked',
              decision: 'block',
              reason_codes: ['execution_trust_blocked'],
            }),
          ],
          servingPassportId: 'passport:serving:blocked',
        }),
      }),
    )
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'blocked',
        reason: 'execution trust blocked by stage staleness',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [
          {
            type: 'swarms',
            scope: 'agents',
            name: 'jangar-control-plane',
            reason: 'requirements stalled',
            class: 'blocked',
          },
        ],
        evidence_summary: ['execution trust blocked'],
      },
      swarms: [],
      stages: [],
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.execution_trust).toMatchObject({
      status: 'blocked',
    })
  })

  it('returns 200 with degraded status when the serving passport is blocked', async () => {
    agentsControlPlaneClientMocks.getAgentsControlPlaneStatusSnapshot.mockResolvedValue(
      buildAgentsControlPlaneStatusSnapshot({
        runtimeAdmission: buildRuntimeAdmissionSnapshot({
          admissionPassports: [
            buildAdmissionPassport({
              admission_passport_id: 'passport:serving:2',
              decision: 'block',
              reason_codes: ['runtime_kit_component_missing:serving_runtime_binary'],
            }),
          ],
          servingPassportId: 'passport:serving:2',
        }),
      }),
    )

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.serving_passport_id).toBe('passport:serving:2')
  })

  it('returns 200 with degraded status when any watched namespace reports blocked execution trust', async () => {
    agentsControlPlaneClientMocks.getAgentsControlPlaneStatusSnapshot.mockResolvedValue(
      buildAgentsControlPlaneStatusSnapshot({
        runtimeAdmission: buildRuntimeAdmissionSnapshot({
          admissionPassports: [
            buildAdmissionPassport({
              admission_passport_id: 'passport:serving:blocked',
              decision: 'block',
              reason_codes: ['execution_trust_blocked'],
            }),
          ],
          servingPassportId: 'passport:serving:blocked',
        }),
      }),
    )
    agentsControlPlaneClientMocks.getAgentsReadySnapshot.mockResolvedValue(
      buildAgentsReadySnapshot({
        namespaces: ['agents', 'staging'],
        agentsController: buildAgentsControllerHealth({
          namespaces: ['agents', 'staging'],
        }),
      }),
    )
    controlPlaneStatusMocks.buildExecutionTrust
      .mockResolvedValueOnce({
        executionTrust: {
          status: 'healthy',
          reason: 'execution trust is healthy.',
          last_evaluated_at: '2026-03-08T21:00:00Z',
          blocking_windows: [],
          evidence_summary: [],
        },
        swarms: [],
        stages: [],
      })
      .mockResolvedValueOnce({
        executionTrust: {
          status: 'blocked',
          reason: 'execution trust blocked by stage staleness',
          last_evaluated_at: '2026-03-08T21:00:00Z',
          blocking_windows: [
            {
              type: 'swarms',
              scope: 'staging',
              name: 'torghut-quant',
              reason: 'requirements stalled',
              class: 'blocked',
            },
          ],
          evidence_summary: ['execution trust blocked'],
        },
        swarms: [],
        stages: [],
      })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenCalledTimes(2)
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        namespace: 'agents',
      }),
    )
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        namespace: 'staging',
      }),
    )
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.execution_trust).toMatchObject({
      status: 'blocked',
    })
    expect(body.execution_trust.reason).toContain('2 namespaces')
    expect(body.execution_trust.blocking_windows).toEqual([
      expect.objectContaining({
        scope: 'staging',
        class: 'blocked',
      }),
    ])
  })

  it('returns 200 with degraded status when execution trust evaluation fails', async () => {
    agentsControlPlaneClientMocks.getAgentsControlPlaneStatusSnapshot.mockResolvedValue(
      buildAgentsControlPlaneStatusSnapshot({
        runtimeAdmission: buildRuntimeAdmissionSnapshot({
          admissionPassports: [
            buildAdmissionPassport({
              admission_passport_id: 'passport:serving:unknown',
              decision: 'block',
              reason_codes: ['execution_trust_unknown'],
            }),
          ],
          servingPassportId: 'passport:serving:unknown',
        }),
      }),
    )
    controlPlaneStatusMocks.buildExecutionTrust.mockRejectedValue(new Error('trust fetch failed'))
    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.execution_trust).toMatchObject({
      status: 'unknown',
    })
    expect(body.execution_trust.reason).toContain('execution trust check failed for namespace agents')
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenCalledTimes(1)
  })

  it('returns 503 when memory provider health is blocked', async () => {
    memoryProviderHealthMocks.getMemoryProviderHealth.mockReturnValue({
      status: 'blocked',
      reason:
        'missing OPENAI_API_KEY; set it or point OPENAI_EMBEDDING_API_BASE_URL/OPENAI_API_BASE_URL at an OpenAI-compatible endpoint',
      mode: 'hosted',
      fallbackActive: false,
      config: {
        apiBaseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-3-small',
        dimension: 1536,
        timeoutMs: 15000,
        maxInputChars: 60000,
        hosted: true,
      },
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.memory_provider).toMatchObject({
      status: 'blocked',
    })
  })
})
