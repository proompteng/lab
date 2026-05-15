import { describe, expect, it } from 'vitest'

import type {
  ControlPlaneControllerWitnessQuorum,
  RepairSlotEscrow,
  SourceServingContractVerdictExchange,
  TorghutConsumerEvidenceStatus,
  VerifyTrustForeclosureBoard,
} from '~/data/agents-control-plane'
import {
  CONTROLLER_INGESTION_SETTLEMENT_DESIGN_ARTIFACT,
  buildControllerIngestionSettlement,
} from '~/server/control-plane-controller-ingestion-settlement'
import type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

const now = new Date('2026-05-14T17:00:00Z')
const freshUntil = '2026-05-14T17:05:00.000Z'

const controllerWitness = (
  overrides: Partial<ControlPlaneControllerWitnessQuorum> = {},
): ControlPlaneControllerWitnessQuorum => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
  quorum_id: 'controller-witness:healthy',
  generated_at: now.toISOString(),
  expires_at: freshUntil,
  namespace: 'agents',
  decision: 'allow',
  reason_codes: [],
  message: 'controller witnesses current',
  witness_refs: ['witness:controller', 'witness:deployment', 'witness:watch', 'witness:ingestion'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [],
  rollback_target: null,
  ...overrides,
})

const agentRunIngestion = (overrides: Partial<AgentRunIngestionStatus> = {}): AgentRunIngestionStatus => ({
  namespace: 'agents',
  status: 'healthy',
  message: 'AgentRun ingestion healthy',
  last_watch_event_at: now.toISOString(),
  last_resync_at: now.toISOString(),
  untouched_run_count: 0,
  oldest_untouched_age_seconds: null,
  ...overrides,
})

const database = (overrides: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
  configured: true,
  connected: true,
  status: 'healthy',
  message: '',
  latency_ms: 3,
  migration_consistency: {
    status: 'healthy',
    migration_table: 'kysely_migration',
    registered_count: 1,
    applied_count: 1,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260514_controller_ingestion_settlement',
    latest_applied: '20260514_controller_ingestion_settlement',
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

const sourceServing = (
  overrides: Partial<SourceServingContractVerdictExchange> = {},
): SourceServingContractVerdictExchange => ({
  mode: 'observe',
  design_artifact: 'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md',
  exchange_id: 'source-serving-verdict-exchange:healthy',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  namespace: 'agents',
  status: 'allow',
  source_sha: 'abc123',
  serving_build_commit: 'abc123',
  manifest_image_digest: 'sha256:source',
  serving_image_digest: 'sha256:source',
  required_contracts: [],
  observed_contracts: [],
  missing_contracts: [],
  verdict_refs: [],
  allowed_action_classes: ['serve_readonly', 'dispatch_repair', 'dispatch_normal', 'deploy_widen', 'merge_ready'],
  repair_only_action_classes: [],
  held_action_classes: [],
  blocked_action_classes: [],
  reason_codes: [],
  verdicts: [],
  rollback_target: 'ignore source-serving verdicts',
  ...overrides,
})

const verifyBoard = (overrides: Partial<VerifyTrustForeclosureBoard> = {}): VerifyTrustForeclosureBoard =>
  ({
    schema_version: 'jangar.verify-trust-foreclosure-board.v1',
    mode: 'observe',
    board_id: 'verify-trust-foreclosure-board:healthy',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    namespace: 'agents',
    governing_design_refs: [],
    execution_trust_ref: 'execution-trust:healthy',
    execution_trust_status: 'healthy',
    source_rollout_truth_ref: 'source-rollout:healthy',
    source_rollout_truth_state: 'converged',
    controller_witness_ref: 'controller-witness:healthy',
    database_projection_ref: 'database:healthy',
    route_stability_ref: 'route-stability:healthy',
    torghut_consumer_evidence_ref: 'torghut-consumer-evidence:healthy',
    torghut_alpha_repair_closure_board_ref: null,
    torghut_alpha_repair_dividend_ref: null,
    torghut_no_delta_repair_reentry_auction_ref: null,
    active_no_delta_release_key: null,
    debt_classes: [],
    foreclosure_tickets: [],
    action_decisions: [],
    alpha_repair_reentry_admission: {} as VerifyTrustForeclosureBoard['alpha_repair_reentry_admission'],
    deployer_packet: {} as VerifyTrustForeclosureBoard['deployer_packet'],
    rollback_target: 'observe verify trust foreclosure board',
    ...overrides,
  }) as VerifyTrustForeclosureBoard

const repairSlot = (overrides: Partial<RepairSlotEscrow> = {}): RepairSlotEscrow =>
  ({
    schema_version: 'jangar.repair-slot-escrow.v1',
    mode: 'observe',
    escrow_id: 'repair-slot-escrow:healthy',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    namespace: 'agents',
    status: 'observe_only',
    governing_design_refs: [],
    selected_slot_id: null,
    slots: [],
    blocked_slots: [],
    no_delta_debt: [],
    scheduler_handoff: {} as RepairSlotEscrow['scheduler_handoff'],
    deployer_handoff: {} as RepairSlotEscrow['deployer_handoff'],
    rollback_target: 'ignore repair slot escrow',
    ...overrides,
  }) as RepairSlotEscrow

const torghutConsumerEvidence = (
  overrides: Partial<TorghutConsumerEvidenceStatus> = {},
): TorghutConsumerEvidenceStatus => ({
  status: 'current',
  endpoint: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
  receipt_id: 'torghut-consumer-evidence:healthy',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  candidate_id: 'candidate-1',
  dataset_snapshot_ref: 'snapshot-1',
  max_notional: '0',
  revenue_repair_business_state: 'repair_only',
  revenue_repair_ready: false,
  revenue_repair_queue: [],
  reason_codes: [],
  message: 'torghut consumer evidence current',
  ...overrides,
})

const buildSettlement = (overrides: Partial<Parameters<typeof buildControllerIngestionSettlement>[0]> = {}) =>
  buildControllerIngestionSettlement({
    now,
    namespace: 'agents',
    servingReadiness: 'ok',
    controllerWitness: controllerWitness(),
    agentRunIngestion: agentRunIngestion(),
    executionTrust: {
      status: 'healthy',
      reason: 'execution trust is healthy',
      last_evaluated_at: now.toISOString(),
      blocking_windows: [],
      evidence_summary: [],
    },
    database: database(),
    rolloutHealth: rolloutHealth(),
    sourceServingContractVerdictExchange: sourceServing(),
    verifyTrustForeclosureBoard: verifyBoard(),
    repairSlotEscrow: repairSlot(),
    torghutConsumerEvidence: torghutConsumerEvidence(),
    ...overrides,
  })

describe('control-plane controller ingestion settlement', () => {
  it('allows material carry when controller ingestion and source-serving evidence agree', () => {
    const settlement = buildSettlement()

    expect(settlement).toMatchObject({
      schema_version: 'jangar.controller-ingestion-settlement.v1',
      mode: 'observe',
      decision: 'allow',
      torghut_verification_carry_status: 'unknown',
      selected_repair_ticket: {
        ticket_class: 'none',
        max_parallelism: 0,
        max_notional: '0',
      },
      reason_codes: [],
    })
    expect(settlement.governing_design_refs).toContain(CONTROLLER_INGESTION_SETTLEMENT_DESIGN_ARTIFACT)
    expect(settlement.evidence_refs).toEqual(
      expect.arrayContaining([
        'controller-witness:healthy',
        'source-serving-verdict-exchange:healthy',
        'verify-trust-foreclosure-board:healthy',
      ]),
    )
  })

  it('does not treat zero-notional live support as a controller-ingestion source carry blocker', () => {
    const settlement = buildSettlement({
      sourceServingContractVerdictExchange: sourceServing({
        status: 'block',
        allowed_action_classes: [
          'serve_readonly',
          'dispatch_repair',
          'dispatch_normal',
          'deploy_widen',
          'merge_ready',
          'paper_support',
        ],
        repair_only_action_classes: [],
        held_action_classes: [],
        blocked_action_classes: ['live_support'],
        reason_codes: [],
      }),
    })

    expect(settlement).toMatchObject({
      decision: 'allow',
      source_serving_status: 'block',
      reason_codes: [],
    })
  })

  it('selects one controller-ingestion repair ticket when ingestion is the only missing witness', () => {
    const settlement = buildSettlement({
      controllerWitness: controllerWitness({
        decision: 'repair_only',
        reason_codes: ['controller_witness_split'],
        quorum_id: 'controller-witness:repair-only',
      }),
      agentRunIngestion: agentRunIngestion({
        status: 'unknown',
        message: 'AgentRun ingestion self-report missing',
        last_watch_event_at: null,
        last_resync_at: null,
      }),
    })

    expect(settlement.decision).toBe('repair_only')
    expect(settlement.selected_repair_ticket).toMatchObject({
      ticket_class: 'controller_ingestion',
      max_parallelism: 1,
      max_notional: '0',
    })
    expect(settlement.reason_codes).toEqual(
      expect.arrayContaining(['agentrun_ingestion_unknown', 'controller_witness_split']),
    )
    expect(settlement.selected_repair_ticket.validation_commands).toEqual(
      expect.arrayContaining([expect.stringContaining('.controller_ingestion_settlement')]),
    )
  })

  it('holds broad work when source-to-live carry evidence is missing', () => {
    const settlement = buildSettlement({
      sourceServingContractVerdictExchange: sourceServing({
        status: 'hold',
        reason_codes: ['source_serving_build_mismatch'],
        held_action_classes: ['dispatch_repair', 'dispatch_normal', 'deploy_widen', 'merge_ready'],
      }),
      verifyTrustForeclosureBoard: null,
    })

    expect(settlement.decision).toBe('hold')
    expect(settlement.selected_repair_ticket.ticket_class).toBe('none')
    expect(settlement.reason_codes).toEqual(
      expect.arrayContaining([
        'source_serving_hold',
        'source_serving_build_mismatch',
        'verify_trust_foreclosure_board_missing',
      ]),
    )
  })

  it('holds broad work when source-to-live carry evidence is stale', () => {
    const settlement = buildSettlement({
      sourceServingContractVerdictExchange: sourceServing({
        fresh_until: '2026-05-14T16:59:59.000Z',
      }),
    })

    expect(settlement.decision).toBe('hold')
    expect(settlement.reason_codes).toContain('source_serving_verdict_stale')
    expect(settlement.selected_repair_ticket.ticket_class).toBe('none')
  })

  it('holds when Torghut reports Jangar verification carry unavailable', () => {
    const settlement = buildSettlement({
      torghutConsumerEvidence: torghutConsumerEvidence({
        no_delta_repair_reentry_auction: {
          schema_version: 'torghut.no-delta-repair-reentry-auction-ref.v1',
          auction_schema_version: 'torghut.no-delta-repair-reentry-auction.v1',
          auction_id: 'no-delta-auction:carry-unavailable',
          generated_at: now.toISOString(),
          fresh_until: freshUntil,
          reentry_decision: 'deny',
          reason_codes: ['jangar_verification_carry_unavailable'],
          active_no_delta_release_key: 'H-MICRO-01:no-delta',
          selected_hypothesis_id: 'H-MICRO-01',
          selected_value_gate: 'routeable_candidate_count',
          routeable_candidate_count_before: 0,
          routeable_candidate_count_after: 0,
          selected_ticket_id: null,
          selected_ticket_class: null,
          selected_release_condition: null,
          required_output_receipt: 'jangar.verify-trust-foreclosure-ticket.v1',
          validation_command: "curl -fsS http://torghut/trading/revenue-repair | jq '.no_delta_repair_reentry_auction'",
          enforcement_mode: 'observe',
          max_notional: '0',
          capital_rule: 'zero_notional_repair_only',
          rollback_target: 'keep no-delta denial active',
        },
      }),
    })

    expect(settlement.decision).toBe('hold')
    expect(settlement.torghut_verification_carry_status).toBe('unavailable')
    expect(settlement.reason_codes).toContain('torghut_verification_carry_unavailable')
  })

  it('blocks contradictory Torghut carry evidence', () => {
    const settlement = buildSettlement({
      torghutConsumerEvidence: torghutConsumerEvidence({
        no_delta_repair_reentry_auction: {
          schema_version: 'torghut.no-delta-repair-reentry-auction-ref.v1',
          auction_schema_version: 'torghut.no-delta-repair-reentry-auction.v1',
          auction_id: 'no-delta-auction:contradicted',
          generated_at: now.toISOString(),
          fresh_until: freshUntil,
          reentry_decision: 'deny',
          reason_codes: ['jangar_verification_carry_contradicted'],
          active_no_delta_release_key: 'H-MICRO-01:no-delta',
          selected_hypothesis_id: 'H-MICRO-01',
          selected_value_gate: 'routeable_candidate_count',
          routeable_candidate_count_before: 0,
          routeable_candidate_count_after: 0,
          selected_ticket_id: null,
          selected_ticket_class: null,
          selected_release_condition: null,
          required_output_receipt: 'jangar.verify-trust-foreclosure-ticket.v1',
          validation_command: "curl -fsS http://torghut/trading/revenue-repair | jq '.no_delta_repair_reentry_auction'",
          enforcement_mode: 'observe',
          max_notional: '0',
          capital_rule: 'zero_notional_repair_only',
          rollback_target: 'keep no-delta denial active',
        },
      }),
    })

    expect(settlement.decision).toBe('block')
    expect(settlement.torghut_verification_carry_status).toBe('contradicted')
    expect(settlement.selected_repair_ticket.ticket_class).toBe('none')
  })
})
