import { beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }
delete originalEnv.JANGAR_TORGHUT_STATUS_URL
delete originalEnv.JANGAR_TORGHUT_STATUS_TIMEOUT_MS
const originalFetch = globalThis.fetch

const buildJsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const agentsControllerMocks = vi.hoisted(() => ({
  getAgentsControllerHealth: vi.fn(),
  assessAgentRunIngestion: vi.fn(),
}))

const leaderElectionMocks = vi.hoisted(() => ({
  getLeaderElectionStatus: vi.fn(),
}))

const orchestrationControllerMocks = vi.hoisted(() => ({
  getOrchestrationControllerHealth: vi.fn(),
}))

const supportingControllerMocks = vi.hoisted(() => ({
  getSupportingControllerHealth: vi.fn(),
}))

const controlPlaneStatusMocks = vi.hoisted(() => ({
  buildExecutionTrust: vi.fn(),
}))

const runtimeAdmissionMocks = vi.hoisted(() => ({
  buildRuntimeAdmissionSnapshot: vi.fn(),
  findAdmissionPassport: vi.fn(),
}))

const memoryProviderHealthMocks = vi.hoisted(() => ({
  getMemoryProviderHealth: vi.fn(),
}))

const watchReliabilityMocks = vi.hoisted(() => ({
  getWatchReliabilitySummary: vi.fn(),
}))

const metricsMocks = vi.hoisted(() => ({
  getMetricsSinkPressureSummary: vi.fn(),
}))

const githubReviewIngestMocks = vi.hoisted(() => ({
  getGithubReviewIngestPressureSummary: vi.fn(),
}))

vi.mock('~/server/agents-controller', () => agentsControllerMocks)
vi.mock('~/server/leader-election', () => leaderElectionMocks)
vi.mock('~/server/orchestration-controller', () => orchestrationControllerMocks)
vi.mock('~/server/supporting-primitives-controller', () => supportingControllerMocks)
vi.mock('~/server/memory-provider-health', () => memoryProviderHealthMocks)
vi.mock('~/server/control-plane-watch-reliability', () => watchReliabilityMocks)
vi.mock('~/server/metrics', () => metricsMocks)
vi.mock('~/server/github-review-ingest', () => githubReviewIngestMocks)
vi.mock('~/server/control-plane-status', async () => {
  const actual = await vi.importActual<typeof import('~/server/control-plane-status')>('~/server/control-plane-status')
  return {
    ...actual,
    buildExecutionTrust: controlPlaneStatusMocks.buildExecutionTrust,
  }
})
vi.mock('~/server/control-plane-runtime-admission', () => runtimeAdmissionMocks)

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

describe('getReadyHandler', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    globalThis.fetch = originalFetch
    vi.clearAllMocks()
    controlPlaneStatusMocks.buildExecutionTrust.mockReset()
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReset()
    runtimeAdmissionMocks.findAdmissionPassport.mockReset()
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
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(buildRuntimeAdmissionSnapshot())
    runtimeAdmissionMocks.findAdmissionPassport.mockImplementation(({ admissionPassports, consumerClass }) =>
      admissionPassports.find((passport: { consumer_class?: string }) => passport.consumer_class === consumerClass),
    )
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
    watchReliabilityMocks.getWatchReliabilitySummary.mockReturnValue({
      status: 'healthy',
      window_minutes: 15,
      observed_streams: 1,
      total_events: 8,
      total_errors: 0,
      total_restarts: 0,
      streams: [
        {
          resource: 'agentruns.agents.proompteng.ai',
          namespace: 'agents',
          events: 8,
          errors: 0,
          restarts: 0,
          last_seen_at: '2026-03-08T21:00:00Z',
        },
      ],
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

    agentsControllerMocks.getAgentsControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
      agentRunIngestion: [],
    })
    agentsControllerMocks.assessAgentRunIngestion.mockReturnValue({
      namespace: 'agents',
      status: 'healthy',
      message: 'AgentRun ingestion healthy',
      dispatchPaused: false,
      lastWatchEventAt: '2026-03-08T21:00:00Z',
      lastResyncAt: '2026-03-08T21:00:00Z',
      untouchedRunCount: 0,
      oldestUntouchedAgeSeconds: null,
    })
    leaderElectionMocks.getLeaderElectionStatus.mockReturnValue({
      enabled: true,
      required: true,
      isLeader: true,
      leaseName: 'jangar-controller-leader',
      leaseNamespace: 'agents',
      identity: 'agents-controllers-1',
      lastTransitionAt: '2026-03-08T21:00:00Z',
      lastAttemptAt: '2026-03-08T21:00:00Z',
      lastSuccessAt: '2026-03-08T21:00:00Z',
      lastError: null,
    })
    orchestrationControllerMocks.getOrchestrationControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
    })
    supportingControllerMocks.getSupportingControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
    })
  })

  it('returns 200 when leader is ready and AgentRun ingestion is healthy', async () => {
    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
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
    expect(body.serving_recovery_warrant_id).toBe('recovery-warrant:serving:1')
    expect(body.serving_runtime_proof_cells_healthy).toBe(true)
  })

  it('projects Torghut revenue-repair business evidence at the ready boundary', async () => {
    process.env.JANGAR_TORGHUT_STATUS_URL = 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence'
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
      controller_witness_ref: 'controller-witness:agents:ready-hot-path',
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
        'controller_witness_unavailable_on_hot_path',
        'database_projection_unavailable_on_hot_path',
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

  it('returns 200 and exposes a serving passport when only collaboration runtime debt is blocked', async () => {
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        runtimeKits: [
          buildRuntimeKit(),
          buildRuntimeKit({
            runtime_kit_id: 'runtime-kit:collaboration:2',
            kit_class: 'collaboration',
            subject_ref: 'jangar:codex:nats-collaboration',
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
    )

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.serving_passport_id).toBe('passport:serving:1')
    expect(body.serving_recovery_warrant_id).toBe('recovery-warrant:serving:1')
    expect(body.serving_runtime_proof_cells_healthy).toBe(true)
    expect(body.runtime_kits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kit_class: 'collaboration',
          decision: 'blocked',
        }),
      ]),
    )
  })

  it('returns 200 with degraded status when AgentRun ingestion is degraded', async () => {
    agentsControllerMocks.assessAgentRunIngestion.mockReturnValue({
      namespace: 'agents',
      status: 'degraded',
      message: 'untouched AgentRuns detected for 180s',
      dispatchPaused: true,
      lastWatchEventAt: null,
      lastResyncAt: '2026-03-08T21:00:00Z',
      untouchedRunCount: 3,
      oldestUntouchedAgeSeconds: 180,
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
  })

  it('returns 200 with degraded status when the active controller is still adopting backlog', async () => {
    agentsControllerMocks.getAgentsControllerHealth.mockReturnValue({
      enabled: true,
      started: false,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
      agentRunIngestion: [
        {
          namespace: 'agents',
          lastWatchEventAt: '2026-03-08T21:01:00Z',
          lastResyncAt: '2026-03-08T21:00:00Z',
          untouchedRunCount: 12,
          oldestUntouchedAgeSeconds: 4_769_263,
        },
      ],
    })
    agentsControllerMocks.assessAgentRunIngestion.mockReturnValue({
      namespace: 'agents',
      status: 'unknown',
      message: 'agents controller not started',
      dispatchPaused: false,
      lastWatchEventAt: '2026-03-08T21:01:00Z',
      lastResyncAt: '2026-03-08T21:00:00Z',
      untouchedRunCount: 12,
      oldestUntouchedAgeSeconds: 4_769_263,
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.agentsController).toMatchObject({
      started: false,
      crdsReady: true,
    })
  })

  it('returns 200 when leader election is required but this instance is a healthy standby', async () => {
    leaderElectionMocks.getLeaderElectionStatus.mockReturnValue({
      enabled: true,
      required: true,
      isLeader: false,
      leaseName: 'jangar-controller-leader',
      leaseNamespace: 'agents',
      identity: 'agents-controllers-2',
      lastTransitionAt: '2026-03-08T21:00:00Z',
      lastAttemptAt: '2026-03-08T21:00:00Z',
      lastSuccessAt: '2026-03-08T21:00:00Z',
      lastError: null,
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
  })

  it('returns 503 when leader election is required but standby has not observed a healthy lease attempt', async () => {
    leaderElectionMocks.getLeaderElectionStatus.mockReturnValue({
      enabled: true,
      required: true,
      isLeader: false,
      leaseName: 'jangar-controller-leader',
      leaseNamespace: 'agents',
      identity: 'agents-controllers-2',
      lastTransitionAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: 'lease watch failed',
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
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
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        admissionPassports: [
          buildAdmissionPassport({
            admission_passport_id: 'passport:serving:blocked',
            decision: 'block',
            reason_codes: ['execution_trust_blocked'],
          }),
        ],
        servingPassportId: 'passport:serving:blocked',
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
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        admissionPassports: [
          buildAdmissionPassport({
            admission_passport_id: 'passport:serving:2',
            decision: 'block',
            reason_codes: ['runtime_kit_component_missing:serving_runtime_binary'],
          }),
        ],
        servingPassportId: 'passport:serving:2',
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
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        admissionPassports: [
          buildAdmissionPassport({
            admission_passport_id: 'passport:serving:blocked',
            decision: 'block',
            reason_codes: ['execution_trust_blocked'],
          }),
        ],
        servingPassportId: 'passport:serving:blocked',
      }),
    )
    agentsControllerMocks.getAgentsControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents', 'staging'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
      agentRunIngestion: [],
    })
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
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        admissionPassports: [
          buildAdmissionPassport({
            admission_passport_id: 'passport:serving:unknown',
            decision: 'block',
            reason_codes: ['execution_trust_unknown'],
          }),
        ],
        servingPassportId: 'passport:serving:unknown',
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
