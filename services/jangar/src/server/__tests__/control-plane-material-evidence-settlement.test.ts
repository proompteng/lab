import { describe, expect, it } from 'vitest'

import type {
  ControllerIngestionSettlement,
  DatabaseStatus,
  MaterialGateDigest,
  RepairBidAdmissionState,
  SourceServingContractVerdictExchange,
  TorghutConsumerEvidenceStatus,
  WorkflowsReliabilityStatus,
} from '~/server/control-plane-status-types'
import {
  MATERIAL_EVIDENCE_SETTLEMENT_DESIGN_ARTIFACT,
  MATERIAL_EVIDENCE_SETTLEMENT_TORGHUT_DESIGN_ARTIFACT,
  buildMaterialEvidenceSettlementSpine,
} from '~/server/control-plane-material-evidence-settlement'
import type { ControlPlaneRolloutHealth } from '~/server/control-plane-status-types'

const now = new Date('2026-05-14T21:00:00.000Z')
const freshUntil = '2026-05-14T21:05:00.000Z'

const database = (overrides: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
  configured: true,
  connected: true,
  status: 'healthy',
  message: '',
  latency_ms: 3,
  migration_consistency: {
    status: 'healthy',
    migration_table: 'kysely_migration',
    registered_count: 29,
    applied_count: 29,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260514_material_evidence_settlement',
    latest_applied: '20260514_material_evidence_settlement',
    missing_migrations: [],
    unexpected_migrations: [],
    message: '',
  },
  ...overrides,
})

const rolloutHealth = (overrides: Partial<ControlPlaneRolloutHealth> = {}): ControlPlaneRolloutHealth => ({
  status: 'healthy',
  observed_deployments: 2,
  degraded_deployments: 0,
  deployments: [],
  message: 'rollout healthy',
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

const sourceServing = (
  overrides: Partial<SourceServingContractVerdictExchange> = {},
): SourceServingContractVerdictExchange => ({
  mode: 'observe',
  design_artifact: 'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md',
  exchange_id: 'source-serving:current',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  namespace: 'agents',
  status: 'allow',
  source_sha: '57095de61842f69a8dce99b09afec438c46a5945',
  serving_build_commit: '57095de61842f69a8dce99b09afec438c46a5945',
  manifest_image_digest: 'sha256:manifest',
  serving_image_digest: 'sha256:serving',
  required_contracts: [],
  observed_contracts: [],
  missing_contracts: [],
  verdict_refs: [],
  allowed_action_classes: ['serve_readonly', 'dispatch_repair'],
  repair_only_action_classes: [],
  held_action_classes: [],
  blocked_action_classes: [],
  reason_codes: [],
  verdicts: [],
  rollback_target: 'ignore source serving verdict',
  ...overrides,
})

const controllerIngestionSettlement = (
  overrides: Partial<ControllerIngestionSettlement> = {},
): ControllerIngestionSettlement =>
  ({
    schema_version: 'jangar.controller-ingestion-settlement.v1',
    mode: 'observe',
    settlement_id: 'controller-ingestion-settlement:current',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    namespace: 'agents',
    governing_design_refs: [],
    decision: 'allow',
    serving_readiness: 'ok',
    controller_witness_ref: 'controller-witness:current',
    controller_witness_decision: 'allow',
    deployment_available: true,
    watch_epoch_current: true,
    controller_self_report_current: true,
    agentrun_ingestion_current: true,
    execution_trust_status: 'healthy',
    database_status: 'healthy',
    source_serving_verdict_ref: 'source-serving:current',
    source_serving_status: 'allow',
    source_head_sha: '57095de61842f69a8dce99b09afec438c46a5945',
    serving_build_commit: '57095de61842f69a8dce99b09afec438c46a5945',
    manifest_image_digest: 'sha256:manifest',
    serving_image_digest: 'sha256:serving',
    verify_trust_foreclosure_board_ref: 'verify-trust:current',
    repair_slot_escrow_ref: 'repair-slot:current',
    torghut_verification_carry_status: 'current',
    selected_repair_ticket: {
      ticket_class: 'none',
      max_parallelism: 0,
      max_notional: '0',
      validation_commands: [],
      reason_codes: [],
    },
    reason_codes: [],
    evidence_refs: [],
    rollback_target: 'ignore controller ingestion settlement',
    ...overrides,
  }) as ControllerIngestionSettlement

const materialGateDigest = (overrides: Partial<MaterialGateDigest> = {}): MaterialGateDigest =>
  ({
    schema_version: 'jangar.material-gate-digest.v1',
    digest_id: 'material-gate-digest:current',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    mode: 'observe',
    design_artifact: 'docs/agents/designs/198-jangar-material-gate-digest-and-alpha-closure-carry-2026-05-14.md',
    producer_revision: 'shadow-v1',
    namespace: 'agents',
    serving_readiness: 'ok',
    material_readiness: 'allow',
    action_class_decisions: [
      {
        action_class: 'dispatch_repair',
        decision: 'allow',
        reason_codes: [],
        source_refs: ['torghut-route-proven-profit:current'],
        validation_refs: ['curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair'],
        rollback_target: 'keep Torghut max_notional=0',
      },
    ],
    alpha_closure_carry: {
      schema_version: 'jangar.alpha-closure-carry.v1',
      source: 'torghut.consumer-evidence',
      board_id: 'alpha-repair-closure-board:current',
      settlement_market_id: 'alpha-closure-market:current',
      selected_hypothesis_id: 'H-MICRO-01',
      selected_value_gate: 'routeable_candidate_count',
      required_settlement_receipt: 'torghut.alpha-closure-settlement-receipt.v1',
      active_dedupe_key: 'alpha-window:current',
      no_delta_budget_state: 'available',
      no_delta_debt_count: 0,
      next_allowed_attempt_after: null,
      max_notional: '0',
      capital_rule: 'zero_notional_repair_only',
      decision: 'allow',
      reason_codes: [],
      release_conditions: [],
      validation_refs: [],
      rollback_target: 'keep Torghut max_notional=0',
    },
    alpha_evidence_foundry_ref: null,
    rollout_truth_ref: 'source-rollout:current',
    database_witness_ref: '20260514_material_evidence_settlement',
    runner_debt_summary: {
      recent_failed_jobs: 0,
      backoff_limit_exceeded_jobs: 0,
      source: 'control_plane_workflows',
    },
    reason_codes: [],
    rollback_target: 'ignore material gate digest',
    ...overrides,
  }) as MaterialGateDigest

const repairBidAdmission = (overrides: Partial<RepairBidAdmissionState> = {}): RepairBidAdmissionState =>
  ({
    schema_version: 'jangar.repair-bid-admission.v1',
    admission_id: 'repair-bid-admission:current',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    namespace: 'agents',
    mode: 'observe',
    decision: 'repair_only',
    dispatch_tickets: [
      {
        ticket_id: 'repair-ticket:alpha-readiness',
        action_class: 'dispatch_repair',
        repair_class: 'alpha_readiness',
        target_value_gate: 'routeable_candidate_count',
        expected_gate_delta: 'retire_hypothesis_not_promotion_eligible',
        launch_allowed: true,
        max_parallelism: 1,
        max_runtime_seconds: 1200,
        max_notional: 0,
        reason_codes: [],
        validation_commands: [],
        source_refs: [],
        rollback_target: 'keep Torghut max_notional=0',
      },
    ],
    receipts: [],
    active_dedupe_keys: [],
    reason_codes: [],
    rollback_target: 'ignore repair bid admission',
    ...overrides,
  }) as RepairBidAdmissionState

const torghutEvidence = (overrides: Partial<TorghutConsumerEvidenceStatus> = {}): TorghutConsumerEvidenceStatus => ({
  status: 'current',
  endpoint: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
  receipt_id: 'torghut-route-proven-profit:current',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  candidate_id: 'chip-paper-microbar-composite@execution-proof',
  dataset_snapshot_ref: 'torghut-chip-full-day-20260505-4c330ce9-r1',
  max_notional: '0',
  revenue_repair_business_state: 'repair_only',
  revenue_repair_ready: false,
  revenue_repair_queue: [
    {
      code: 'repair_alpha_readiness',
      reason: 'hypothesis_not_promotion_eligible',
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
  ...overrides,
})

const buildSpine = (overrides: Partial<Parameters<typeof buildMaterialEvidenceSettlementSpine>[0]> = {}) =>
  buildMaterialEvidenceSettlementSpine({
    now,
    namespace: 'agents',
    mode: 'observe',
    servingReadiness: 'ok',
    executionTrust: {
      status: 'healthy',
      reason: 'execution trust healthy',
      last_evaluated_at: now.toISOString(),
      blocking_windows: [],
      evidence_summary: [],
    },
    projectionWatermarks: [
      {
        projection_watermark_id: 'projection-watermark:ready',
        consumer_key: 'service_ready',
        recovery_warrant_id: 'recovery-warrant:serving',
        projection_digest: 'digest',
        source_ref: 'admission-passport:serving',
        observed_at: now.toISOString(),
        expires_at: freshUntil,
        status: 'fresh',
        reason_codes: [],
      },
    ],
    readyTruthArbiter: {
      verdict_id: 'ready-truth:current',
      material_readiness: 'allow',
      serving_readiness: 'ok',
    } as Parameters<typeof buildMaterialEvidenceSettlementSpine>[0]['readyTruthArbiter'],
    stageCreditLedger: null,
    controllerIngestionSettlement: controllerIngestionSettlement(),
    sourceServingContractVerdictExchange: sourceServing(),
    rolloutProofPassport: {
      passport_id: 'rollout-proof-passport:current',
    } as Parameters<typeof buildMaterialEvidenceSettlementSpine>[0]['rolloutProofPassport'],
    materialGateDigest: materialGateDigest(),
    database: database(),
    rolloutHealth: rolloutHealth(),
    workflows: workflows(),
    terminalDebtCompactionLedger: null,
    torghutConsumerEvidence: torghutEvidence(),
    repairBidAdmission: repairBidAdmission(),
    ...overrides,
  })

describe('control-plane material evidence settlement spine', () => {
  it('selects one zero-notional alpha repair ticket when material and transport evidence are current', () => {
    const spine = buildSpine()

    expect(spine).toMatchObject({
      schema_version: 'jangar.material-evidence-settlement-spine.v1',
      mode: 'observe',
      decision: 'repair_only',
      transport_truth: {
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
        action_class: 'dispatch_repair',
        ticket_class: 'alpha_readiness',
        selected_ticket_ref: 'repair-ticket:alpha-readiness',
        decision: 'repair_only',
        max_parallelism: 1,
        max_notional: '0',
      },
    })
    expect(spine.governing_design_refs).toEqual(
      expect.arrayContaining([
        MATERIAL_EVIDENCE_SETTLEMENT_DESIGN_ARTIFACT,
        MATERIAL_EVIDENCE_SETTLEMENT_TORGHUT_DESIGN_ARTIFACT,
      ]),
    )
    expect(spine.reason_codes).toContain('topline_inferred_from_queue_head')
  })

  it('holds repair dispatch when the material gate denies duplicate no-delta work', () => {
    const spine = buildSpine({
      materialGateDigest: materialGateDigest({
        material_readiness: 'repair_only',
        action_class_decisions: [
          {
            action_class: 'dispatch_repair',
            decision: 'deny',
            reason_codes: ['alpha_closure_no_delta_budget_consumed'],
            source_refs: ['alpha-repair-closure-board:current'],
            validation_refs: ['curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair'],
            rollback_target: 'keep Torghut max_notional=0',
          },
        ],
        reason_codes: ['alpha_closure_no_delta_budget_consumed'],
      }),
    })

    expect(spine.decision).toBe('hold')
    expect(spine.material_truth.dispatch_repair_decision).toBe('deny')
    expect(spine.repair_dispatch_budget).toMatchObject({
      ticket_class: 'none',
      decision: 'hold',
      max_parallelism: 0,
    })
    expect(spine.reason_codes).toEqual(
      expect.arrayContaining(['dispatch_repair_deny', 'alpha_closure_no_delta_budget_consumed']),
    )
  })

  it('budgets controller-ingestion repair when that is the selected bounded witness fix', () => {
    const spine = buildSpine({
      controllerIngestionSettlement: controllerIngestionSettlement({
        decision: 'repair_only',
        selected_repair_ticket: {
          ticket_class: 'controller_ingestion',
          max_parallelism: 1,
          max_notional: '0',
          validation_commands: ["jq '.controller_ingestion_settlement'"],
          reason_codes: ['agentrun_ingestion_unknown'],
        },
        reason_codes: ['agentrun_ingestion_unknown'],
      }),
      materialGateDigest: materialGateDigest({ material_readiness: 'repair_only' }),
    })

    expect(spine.decision).toBe('repair_only')
    expect(spine.repair_dispatch_budget).toMatchObject({
      ticket_class: 'controller_ingestion',
      selected_ticket_ref: 'controller-ingestion-settlement:current',
      max_parallelism: 1,
      max_notional: '0',
    })
  })

  it('blocks material authority on nonzero notional evidence', () => {
    const spine = buildSpine({
      torghutConsumerEvidence: torghutEvidence({
        max_notional: '25000',
        revenue_repair_queue: [
          {
            ...torghutEvidence().revenue_repair_queue![0],
            max_notional: '25000',
          },
        ],
      }),
    })

    expect(spine.decision).toBe('block')
    expect(spine.reason_codes).toContain('capital_notional_nonzero')
    expect(spine.repair_dispatch_budget.decision).toBe('block')
  })

  it('lets a global block dominate a selected controller repair ticket', () => {
    const spine = buildSpine({
      controllerIngestionSettlement: controllerIngestionSettlement({
        decision: 'repair_only',
        selected_repair_ticket: {
          ticket_class: 'controller_ingestion',
          max_parallelism: 1,
          max_notional: '0',
          validation_commands: ["jq '.controller_ingestion_settlement'"],
          reason_codes: ['agentrun_ingestion_unknown'],
        },
      }),
      torghutConsumerEvidence: torghutEvidence({
        max_notional: '25000',
        revenue_repair_queue: [
          {
            ...torghutEvidence().revenue_repair_queue![0],
            max_notional: '25000',
          },
        ],
      }),
    })

    expect(spine.decision).toBe('block')
    expect(spine.repair_dispatch_budget).toMatchObject({
      action_class: null,
      ticket_class: 'controller_ingestion',
      decision: 'block',
      max_parallelism: 0,
      max_runtime_seconds: null,
    })
  })
})
