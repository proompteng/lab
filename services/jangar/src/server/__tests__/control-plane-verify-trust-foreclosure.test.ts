import { describe, expect, it } from 'vitest'

import type {
  ControlPlaneControllerWitnessQuorum,
  ExecutionTrustStatus,
  RevenueRepairSettlementCustody,
  SourceServingContractVerdict,
  SourceServingContractVerdictExchange,
  TorghutAlphaRepairClosureBoardRef,
  TorghutAlphaReadinessSettlementConveyorRef,
  TorghutAlphaRepairDividendLedgerRef,
  TorghutConsumerEvidenceStatus,
  TorghutNoDeltaRepairReentryAuctionRef,
} from '~/server/control-plane-status-types'
import {
  buildVerifyTrustForeclosureBoard,
  VERIFY_TRUST_FORECLOSURE_DESIGN_ARTIFACT,
} from '~/server/control-plane-verify-trust-foreclosure'
import type { ControlPlaneRolloutHealth, DatabaseStatus } from '~/server/control-plane-status-types'

const now = new Date('2026-05-14T12:15:00.000Z')

const rolloutHealth = (status: ControlPlaneRolloutHealth['status'] = 'healthy'): ControlPlaneRolloutHealth => ({
  status,
  observed_deployments: 2,
  degraded_deployments: status === 'healthy' ? 0 : 1,
  deployments: [],
  message: `rollout ${status}`,
})

const database = (overrides: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
  configured: true,
  connected: true,
  status: 'healthy',
  message: 'database healthy',
  latency_ms: 3,
  migration_consistency: {
    status: 'healthy',
    migration_table: 'kysely_migration',
    registered_count: 29,
    applied_count: 29,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260514_verify_trust_foreclosure',
    latest_applied: '20260514_verify_trust_foreclosure',
    missing_migrations: [],
    unexpected_migrations: [],
    message: 'migrations consistent',
  },
  ...overrides,
})

const controllerWitness = (
  overrides: Partial<ControlPlaneControllerWitnessQuorum> = {},
): ControlPlaneControllerWitnessQuorum => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
  quorum_id: 'controller-witness-quorum:current',
  generated_at: now.toISOString(),
  expires_at: '2026-05-14T12:16:00.000Z',
  namespace: 'agents',
  decision: 'allow',
  reason_codes: [],
  message: 'controller witness current',
  witness_refs: ['controller-witness:controller-process'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [],
  rollback_target: null,
  ...overrides,
})

const executionTrust = (overrides: Partial<ExecutionTrustStatus> = {}): ExecutionTrustStatus => ({
  status: 'healthy',
  reason: 'execution trust healthy',
  last_evaluated_at: now.toISOString(),
  blocking_windows: [],
  evidence_summary: [],
  ...overrides,
})

const sourceVerdict = (decision: SourceServingContractVerdict['decision'] = 'allow'): SourceServingContractVerdict => ({
  schema_version: 'jangar.source-serving-contract-verdict.v1',
  verdict_id: 'source-serving-contract-verdict:merge-ready',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T12:16:00.000Z',
  repository: 'proompteng/lab',
  source_sha: 'source-sha',
  source_ci_run_id: 'ci:source',
  source_ci_conclusion: 'success',
  manifest_sha: 'manifest-sha',
  manifest_image_digest: 'sha256:manifest',
  argo_sync_revision: 'gitops-sha',
  argo_health: 'healthy',
  serving_revision: 'jangar-00389',
  serving_build_commit: 'source-sha',
  serving_image_digest: 'sha256:manifest',
  required_contracts: [],
  observed_contracts: [],
  missing_contracts: [],
  contract_schema_mismatches: [],
  torghut_route_warrant_ref: 'route-warrant:current',
  torghut_repair_bid_settlement_ref: 'repair-bid-settlement:current',
  action_class: 'merge_ready',
  decision,
  source_serving_state: decision === 'allow' ? 'converged' : 'source_ahead',
  max_notional: 0,
  value_gate_impacts: ['routeable_candidate_count'],
  required_repair_receipts: ['torghut.executable-alpha-receipts.v1'],
  blocking_reason_codes: decision === 'allow' ? [] : ['source_rollout_truth_hold'],
  evidence_refs: ['source-serving-evidence:merge-ready'],
  rollback_gate: 'hold merge until source and serving converge',
})

const sourceExchange = (
  decision: SourceServingContractVerdict['decision'] = 'allow',
): SourceServingContractVerdictExchange => {
  const verdict = sourceVerdict(decision)
  return {
    mode: 'observe',
    design_artifact:
      'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md',
    exchange_id: 'source-serving-contract-verdict-exchange:verify-trust',
    generated_at: now.toISOString(),
    fresh_until: '2026-05-14T12:16:00.000Z',
    namespace: 'agents',
    status: decision,
    source_sha: 'source-sha',
    serving_build_commit: 'source-sha',
    manifest_image_digest: 'sha256:manifest',
    serving_image_digest: 'sha256:manifest',
    required_contracts: [],
    observed_contracts: [],
    missing_contracts: [],
    verdict_refs: [verdict.verdict_id],
    allowed_action_classes: decision === 'allow' ? ['merge_ready'] : [],
    repair_only_action_classes: decision === 'repair_only' ? ['merge_ready'] : [],
    held_action_classes: decision === 'hold' ? ['merge_ready'] : [],
    blocked_action_classes: decision === 'block' ? ['merge_ready'] : [],
    reason_codes: decision === 'allow' ? [] : ['source_rollout_truth_hold'],
    verdicts: [verdict],
    rollback_target: 'hold merge until source and serving converge',
  }
}

const conveyor = (
  overrides: Partial<TorghutAlphaReadinessSettlementConveyorRef> = {},
): TorghutAlphaReadinessSettlementConveyorRef => ({
  schema_version: 'torghut.alpha-readiness-settlement-conveyor-ref.v1',
  conveyor_schema_version: 'torghut.alpha-readiness-settlement-conveyor.v1',
  conveyor_id: 'alpha-readiness-settlement-conveyor:current',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T12:30:00.000Z',
  status: 'settling',
  settlement_state: 'pending',
  reason_codes: [],
  selected_hypothesis_id: 'H-MICRO-01',
  selected_value_gate: 'routeable_candidate_count',
  routeable_candidate_count_before: 0,
  routeable_candidate_count_after: 0,
  measured_routeable_candidate_delta: 0,
  active_no_delta_lease_count: 0,
  required_receipt: 'torghut.executable-alpha-receipts.v1',
  validation_command: 'uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py',
  no_delta_release_key: 'alpha-readiness-no-delta:H-MICRO-01:window-a',
  repeat_launch_decision: 'allow',
  max_notional: '0',
  capital_rule: 'zero_notional_repair_only',
  rollback_target: 'stop emitting alpha_readiness_settlement_conveyor and keep Torghut max_notional=0',
  ...overrides,
})

const dividend = (
  overrides: Partial<TorghutAlphaRepairDividendLedgerRef> = {},
): TorghutAlphaRepairDividendLedgerRef => ({
  schema_version: 'torghut.alpha-repair-dividend-ledger-ref.v1',
  ledger_schema_version: 'torghut.alpha-repair-dividend-ledger.v1',
  ledger_id: 'alpha-repair-dividend-ledger:current',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T12:30:00.000Z',
  status: 'current',
  dividend_state: 'settling',
  reason_codes: [],
  selected_hypothesis_id: 'H-MICRO-01',
  selected_value_gate: 'routeable_candidate_count',
  routeable_candidate_count_before: 0,
  routeable_candidate_count_after: 0,
  measured_delta: 0,
  no_delta_release_key: 'alpha-readiness-no-delta:H-MICRO-01:window-a',
  launch_decision: 'allow',
  required_recorder_schema: 'jangar.material-action-custody-flight-recorder.v1',
  validation_command: 'uv run --frozen pytest services/torghut/tests/test_alpha_repair_dividend_ledger.py',
  enforcement_mode: 'observe',
  max_notional: '0',
  capital_rule: 'zero_notional_repair_only',
  rollback_target: 'stop emitting alpha_repair_dividend_ledger and keep Torghut max_notional=0',
  ...overrides,
})

const closureBoard = (
  overrides: Partial<TorghutAlphaRepairClosureBoardRef> = {},
): TorghutAlphaRepairClosureBoardRef => ({
  schema_version: 'torghut.alpha-repair-closure-board-ref.v1',
  board_id: 'alpha-repair-closure-board:current',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T12:30:00.000Z',
  status: 'selected',
  reason_codes: [],
  top_closure_id: 'alpha-repair-closure:current',
  selected_value_gate: 'routeable_candidate_count',
  required_output_receipt: 'torghut.executable-alpha-receipts.v1',
  settlement_market_id: 'alpha-closure-settlement-market:current',
  settlement_market_status: 'pending_no_delta',
  selected_hypothesis_id: 'H-CONT-01',
  selected_repair_class: 'capital_replay_board_refresh',
  required_settlement_receipt: 'torghut.alpha-closure-settlement-receipt.v1',
  active_dedupe_key: 'alpha-closure-dedupe:H-CONT-01:window-a',
  no_delta_budget_state: 'consumed',
  no_delta_debt_count: 1,
  next_allowed_attempt_after: null,
  max_notional: '0',
  capital_rule: 'zero_notional_repair_only',
  release_conditions: ['evidence_window_changes', 'blocker_set_changes'],
  validation_commands: ['uv run --frozen pytest services/torghut/tests/test_alpha_repair_closure_board.py'],
  rollback_target: 'disable alpha_repair_closure_board emission and keep Torghut max_notional=0',
  ...overrides,
})

const noDeltaAuction = (
  overrides: Partial<TorghutNoDeltaRepairReentryAuctionRef> = {},
): TorghutNoDeltaRepairReentryAuctionRef => ({
  schema_version: 'torghut.no-delta-repair-reentry-auction-ref.v1',
  auction_schema_version: 'torghut.no-delta-repair-reentry-auction.v1',
  auction_id: 'no-delta-repair-reentry-auction:current',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T12:30:00.000Z',
  reentry_decision: 'deny',
  reason_codes: [
    'active_no_delta_release_key',
    'no_release_condition_changed',
    'zero_notional_reentry_ticket_not_selected',
    'duplicate_no_delta_reentry_denied',
  ],
  active_no_delta_release_key: 'alpha-auction-no-delta:H-MICRO-01:window-b',
  selected_hypothesis_id: 'H-MICRO-01',
  selected_value_gate: 'routeable_candidate_count',
  routeable_candidate_count_before: 0,
  routeable_candidate_count_after: 0,
  selected_ticket_id: null,
  selected_ticket_class: null,
  selected_release_condition: null,
  required_output_receipt: null,
  validation_command: null,
  enforcement_mode: 'observe',
  max_notional: '0',
  capital_rule: 'zero_notional_repair_only',
  rollback_target:
    'stop emitting no_delta_repair_reentry_auction, keep alpha settlement and dividend evidence, and keep Torghut max_notional=0',
  ...overrides,
})

const torghutEvidence = (overrides: Partial<TorghutConsumerEvidenceStatus> = {}): TorghutConsumerEvidenceStatus => ({
  status: 'current',
  endpoint: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
  receipt_id: 'torghut-route-proven-profit:current',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T12:16:00.000Z',
  candidate_id: 'chip-paper-microbar-composite@execution-proof',
  dataset_snapshot_ref: 'torghut-chip-full-day',
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
      required_receipts: ['alpha_readiness_receipt', 'hypothesis_promotion_receipt'],
      max_notional: '0',
      capital_rule: 'zero_notional_repair_only',
      observed_count: 1,
    },
  ],
  alpha_repair_closure_board: null,
  alpha_readiness_settlement_conveyor: conveyor(),
  alpha_repair_dividend_ledger: dividend(),
  reason_codes: [],
  message: 'torghut consumer evidence receipt current',
  ...overrides,
})

const custody = (
  decision: RevenueRepairSettlementCustody['decision'] = 'allow',
  overrides: Partial<RevenueRepairSettlementCustody> = {},
): RevenueRepairSettlementCustody => ({
  schema_version: 'jangar.revenue-repair-settlement-custody.v1',
  mode: 'shadow',
  custody_id: `revenue-repair-settlement-custody:${decision}`,
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T12:16:00.000Z',
  namespace: 'agents',
  governing_design_refs: [
    'docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md',
  ],
  torghut_consumer_evidence_ref: 'torghut-route-proven-profit:current',
  torghut_conveyor_ref: 'alpha-readiness-settlement-conveyor:current',
  selected_hypothesis_id: 'H-MICRO-01',
  selected_value_gate: 'routeable_candidate_count',
  action_class: 'dispatch_repair',
  decision,
  reason_codes: decision === 'allow' ? [] : ['active_no_delta_lease'],
  evidence_refs: ['torghut-route-proven-profit:current', 'alpha-readiness-settlement-conveyor:current'],
  stage_health: {
    stage_credit_ledger_ref: 'stage-credit-ledger:current',
    dispatch_repair_decision: 'allow',
    retained_failure_debt_refs: [],
    reason_codes: [],
  },
  no_delta_release_key: 'alpha-readiness-no-delta:H-MICRO-01:window-a',
  no_delta_release_state: decision === 'deny' ? 'active' : 'clear',
  rollout_proof: {
    source_serving_verdict_ref: 'source-serving-contract-verdict:merge-ready',
    source_serving_decision: 'allow',
    rollout_health: 'healthy',
    reason_codes: [],
  },
  validation_command: 'uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py',
  rollback_target: 'stop emitting alpha_readiness_settlement_conveyor and keep Torghut max_notional=0',
  ...overrides,
})

describe('buildVerifyTrustForeclosureBoard', () => {
  it('denies duplicate no-delta alpha repair reentry while preserving read-only actions', () => {
    const board = buildVerifyTrustForeclosureBoard(
      {
        now,
        namespace: 'agents',
        executionTrust: executionTrust({
          status: 'degraded',
          reason: 'execution trust degraded: plan consecutive failures',
          blocking_windows: [
            {
              type: 'stages',
              scope: 'agents',
              name: 'jangar-control-plane:plan',
              reason: 'plan consecutive failures',
              class: 'degraded',
            },
          ],
          evidence_summary: ['stages:agents:jangar-control-plane:plan:plan consecutive failures'],
        }),
        sourceServingContractVerdictExchange: sourceExchange(),
        torghutConsumerEvidence: torghutEvidence({
          alpha_readiness_settlement_conveyor: conveyor({
            active_no_delta_lease_count: 1,
            repeat_launch_decision: 'deny',
          }),
          alpha_repair_dividend_ledger: dividend({
            dividend_state: 'no_delta',
            reason_codes: ['active_no_delta_release_key'],
            launch_decision: 'deny',
          }),
        }),
        revenueRepairSettlementCustody: custody('deny'),
        rolloutHealth: rolloutHealth(),
        controllerWitness: controllerWitness(),
        database: database(),
        serviceHealth: 'ok',
      },
      'observe',
    )

    expect(board.schema_version).toBe('jangar.verify-trust-foreclosure-board.v1')
    expect(board.mode).toBe('observe')
    expect(board.governing_design_refs).toEqual(expect.arrayContaining([VERIFY_TRUST_FORECLOSURE_DESIGN_ARTIFACT]))
    expect(board.debt_classes).toEqual(
      expect.arrayContaining([
        'execution_trust_degraded',
        'plan_trust_degraded',
        'torghut_business_repair_only',
        'torghut_no_delta_active',
        'revenue_repair_settlement_custody_deny',
      ]),
    )
    expect(board.active_no_delta_release_key).toBe('alpha-readiness-no-delta:H-MICRO-01:window-a')
    expect(board.alpha_repair_reentry_admission).toMatchObject({
      release_key_state: 'active',
      decision: 'deny',
      selected_hypothesis_id: 'H-MICRO-01',
      selected_value_gate: 'routeable_candidate_count',
      required_output_receipt: 'torghut.executable-alpha-receipts.v1',
      reason_codes: expect.arrayContaining([
        'torghut_no_delta_active',
        'alpha_repair_dividend_launch_denied',
        'revenue_repair_settlement_custody_deny',
      ]),
    })
    expect(board.foreclosure_tickets).toContainEqual(
      expect.objectContaining({
        debt_class: 'torghut_no_delta_active',
        state: 'denied',
        required_output_receipt: 'torghut.executable-alpha-receipts.v1',
      }),
    )
    expect(board.action_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_class: 'serve_readonly', decision: 'allow' }),
        expect.objectContaining({ action_class: 'torghut_observe', decision: 'allow' }),
        expect.objectContaining({ action_class: 'dispatch_repair', decision: 'block' }),
        expect.objectContaining({ action_class: 'merge_ready', decision: 'hold' }),
      ]),
    )
    expect(board.deployer_packet).toMatchObject({
      source_head_sha: 'source-sha',
      manifest_image_digest: 'sha256:manifest',
      argo_health: 'healthy',
      workload_ready: true,
      torghut_business_state: 'repair_only',
      revenue_ready: false,
      top_repair_queue_item_code: 'repair_alpha_readiness',
    })
  })

  it('uses the no-delta reentry auction as the primary alpha reentry authority', () => {
    const board = buildVerifyTrustForeclosureBoard(
      {
        now,
        namespace: 'agents',
        executionTrust: executionTrust(),
        sourceServingContractVerdictExchange: sourceExchange(),
        torghutConsumerEvidence: torghutEvidence({
          no_delta_repair_reentry_auction: noDeltaAuction(),
          alpha_repair_closure_board: closureBoard({
            selected_hypothesis_id: 'H-CONT-01',
            active_dedupe_key: 'alpha-closure-dedupe:H-CONT-01:window-a',
          }),
          alpha_readiness_settlement_conveyor: conveyor({
            active_no_delta_lease_count: 0,
            repeat_launch_decision: 'allow',
            no_delta_release_key: 'alpha-readiness-no-delta:H-MICRO-01:window-a',
          }),
          alpha_repair_dividend_ledger: null,
        }),
        revenueRepairSettlementCustody: custody('allow'),
        rolloutHealth: rolloutHealth(),
        controllerWitness: controllerWitness(),
        database: database(),
        serviceHealth: 'ok',
      },
      'observe',
    )

    expect(board.torghut_no_delta_repair_reentry_auction_ref).toBe('no-delta-repair-reentry-auction:current')
    expect(board.active_no_delta_release_key).toBe('alpha-auction-no-delta:H-MICRO-01:window-b')
    expect(board.alpha_repair_reentry_admission).toMatchObject({
      release_key_state: 'active',
      decision: 'deny',
      selected_hypothesis_id: 'H-MICRO-01',
      selected_value_gate: 'routeable_candidate_count',
      validation_command:
        "curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.no_delta_repair_reentry_auction'",
      reason_codes: expect.arrayContaining([
        'no_delta_reentry_auction_denied',
        'duplicate_no_delta_reentry_denied',
        'active_no_delta_release_key',
        'zero_notional_reentry_ticket_not_selected',
      ]),
    })
    expect(board.foreclosure_tickets).toContainEqual(
      expect.objectContaining({
        debt_class: 'torghut_no_delta_active',
        source_ref: 'no-delta-repair-reentry-auction:current',
        state: 'denied',
      }),
    )
    expect(board.action_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          decision: 'block',
          evidence_refs: expect.arrayContaining(['no-delta-repair-reentry-auction:current']),
        }),
      ]),
    )
  })

  it('admits a changed zero-notional reentry auction ticket', () => {
    const board = buildVerifyTrustForeclosureBoard(
      {
        now,
        namespace: 'agents',
        executionTrust: executionTrust(),
        sourceServingContractVerdictExchange: sourceExchange(),
        torghutConsumerEvidence: torghutEvidence({
          no_delta_repair_reentry_auction: noDeltaAuction({
            reentry_decision: 'allow',
            reason_codes: [],
            selected_ticket_id: 'no-delta-reentry-ticket:changed',
            selected_ticket_class: 'empirical_receipt',
            selected_release_condition: 'empirical_receipt_current',
            required_output_receipt: 'torghut.empirical-job-receipt.v1',
            validation_command:
              'uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k revenue_repair',
          }),
          alpha_repair_closure_board: null,
          alpha_readiness_settlement_conveyor: conveyor({
            active_no_delta_lease_count: 0,
            repeat_launch_decision: 'allow',
          }),
          alpha_repair_dividend_ledger: null,
        }),
        revenueRepairSettlementCustody: custody('allow'),
        rolloutHealth: rolloutHealth(),
        controllerWitness: controllerWitness(),
        database: database(),
        serviceHealth: 'ok',
      },
      'observe',
    )

    expect(board.active_no_delta_release_key).toBeNull()
    expect(board.alpha_repair_reentry_admission).toMatchObject({
      release_key_state: 'changed',
      decision: 'allow',
      required_output_receipt: 'torghut.empirical-job-receipt.v1',
      validation_command:
        'uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k revenue_repair',
      reason_codes: [],
    })
  })

  it('uses compact alpha closure board no-delta debt as the reentry source of truth', () => {
    const board = buildVerifyTrustForeclosureBoard(
      {
        now,
        namespace: 'agents',
        executionTrust: executionTrust(),
        sourceServingContractVerdictExchange: sourceExchange(),
        torghutConsumerEvidence: torghutEvidence({
          alpha_repair_closure_board: closureBoard(),
          alpha_readiness_settlement_conveyor: conveyor({
            active_no_delta_lease_count: 0,
            repeat_launch_decision: 'allow',
            selected_hypothesis_id: 'H-MICRO-01',
            no_delta_release_key: 'alpha-readiness-no-delta:H-MICRO-01:window-a',
          }),
          alpha_repair_dividend_ledger: null,
        }),
        revenueRepairSettlementCustody: custody('allow'),
        rolloutHealth: rolloutHealth(),
        controllerWitness: controllerWitness(),
        database: database(),
        serviceHealth: 'ok',
      },
      'observe',
    )

    expect(board.torghut_alpha_repair_closure_board_ref).toBe('alpha-repair-closure-board:current')
    expect(board.active_no_delta_release_key).toBe('alpha-closure-dedupe:H-CONT-01:window-a')
    expect(board.debt_classes).toEqual(expect.arrayContaining(['torghut_no_delta_active']))
    expect(board.alpha_repair_reentry_admission).toMatchObject({
      release_key_state: 'active',
      decision: 'deny',
      selected_hypothesis_id: 'H-CONT-01',
      selected_value_gate: 'routeable_candidate_count',
      required_output_receipt: 'torghut.alpha-closure-settlement-receipt.v1',
      validation_command: 'uv run --frozen pytest services/torghut/tests/test_alpha_repair_closure_board.py',
      rollback_target: 'disable alpha_repair_closure_board emission and keep Torghut max_notional=0',
      reason_codes: expect.arrayContaining([
        'torghut_no_delta_active',
        'alpha_closure_no_delta_budget_consumed',
        'alpha_closure_no_delta_debt_active',
      ]),
    })
    expect(board.foreclosure_tickets).toContainEqual(
      expect.objectContaining({
        debt_class: 'torghut_no_delta_active',
        source_ref: 'alpha-repair-closure-board:current',
        state: 'denied',
      }),
    )
    expect(board.action_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          decision: 'block',
          evidence_refs: expect.arrayContaining([
            'alpha-repair-closure-board:current',
            'revenue-repair-settlement-custody:allow',
          ]),
        }),
      ]),
    )
  })

  it('holds material dispatch for stage-trust debt when the release key is clear', () => {
    const board = buildVerifyTrustForeclosureBoard(
      {
        now,
        namespace: 'agents',
        executionTrust: executionTrust({
          status: 'degraded',
          reason: 'execution trust degraded: verify consecutive failures',
          blocking_windows: [
            {
              type: 'stages',
              scope: 'agents',
              name: 'jangar-control-plane:verify',
              reason: 'verify consecutive failures',
              class: 'degraded',
            },
          ],
          evidence_summary: ['stages:agents:jangar-control-plane:verify:verify consecutive failures'],
        }),
        sourceServingContractVerdictExchange: sourceExchange(),
        torghutConsumerEvidence: torghutEvidence(),
        revenueRepairSettlementCustody: custody('allow'),
        rolloutHealth: rolloutHealth(),
        controllerWitness: controllerWitness(),
        database: database(),
        serviceHealth: 'ok',
      },
      'observe',
    )

    expect(board.debt_classes).toEqual(expect.arrayContaining(['execution_trust_degraded', 'verify_trust_degraded']))
    expect(board.alpha_repair_reentry_admission).toMatchObject({
      release_key_state: 'clear',
      decision: 'hold',
      reason_codes: expect.arrayContaining(['execution_trust_degraded', 'verify_trust_degraded']),
    })
    expect(board.foreclosure_tickets).toContainEqual(
      expect.objectContaining({
        debt_class: 'verify_trust_degraded',
        state: 'open',
      }),
    )
    expect(board.action_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_class: 'dispatch_repair', decision: 'hold' }),
        expect.objectContaining({ action_class: 'deploy_widen', decision: 'hold' }),
      ]),
    )
  })

  it('admits one bounded zero-notional repair when trust, source, and release key are clear', () => {
    const board = buildVerifyTrustForeclosureBoard(
      {
        now,
        namespace: 'agents',
        executionTrust: executionTrust(),
        sourceServingContractVerdictExchange: sourceExchange(),
        torghutConsumerEvidence: torghutEvidence(),
        revenueRepairSettlementCustody: custody('allow'),
        rolloutHealth: rolloutHealth(),
        controllerWitness: controllerWitness(),
        database: database(),
        serviceHealth: 'ok',
      },
      'observe',
    )

    expect(board.alpha_repair_reentry_admission).toMatchObject({
      release_key_state: 'clear',
      decision: 'allow',
      reason_codes: [],
      validation_command: 'uv run --frozen pytest services/torghut/tests/test_alpha_repair_dividend_ledger.py',
    })
    expect(board.action_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_class: 'dispatch_repair', decision: 'repair_only' }),
        expect.objectContaining({ action_class: 'merge_ready', decision: 'allow' }),
      ]),
    )
  })
})
