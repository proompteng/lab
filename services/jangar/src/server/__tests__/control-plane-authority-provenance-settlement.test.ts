import { describe, expect, it } from 'vitest'

import {
  AUTHORITY_PROVENANCE_SETTLEMENT_DESIGN_ARTIFACT,
  buildAuthorityProvenanceSettlement,
  type AuthorityProvenanceSettlementInput,
} from '~/server/control-plane-authority-provenance-settlement'

const now = new Date('2026-05-13T12:00:00.000Z')
const freshUntil = '2026-05-13T12:05:00.000Z'

const baseControllerWitness = {
  mode: 'shadow' as const,
  design_artifact:
    'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
  quorum_id: 'controller-witness:allow',
  generated_at: now.toISOString(),
  expires_at: freshUntil,
  namespace: 'agents',
  decision: 'allow' as const,
  reason_codes: [],
  message: 'controller heartbeat is current',
  witness_refs: ['witness:controller-process'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [],
  rollback_target: null,
}

const buildReceipt = (
  actionClass: AuthorityProvenanceSettlementInput['sourceRolloutTruthExchange']['receipts'][number]['action_class'],
  overrides: Partial<AuthorityProvenanceSettlementInput['sourceRolloutTruthExchange']['receipts'][number]> = {},
) => ({
  receipt_id: `source-rollout:${actionClass}:converged`,
  action_class: actionClass,
  settlement_state: 'converged' as const,
  source_head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  gitops_revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  desired_image_ref: 'registry/jangar:aaaaaaaa',
  desired_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  live_image_ref: 'registry/jangar:aaaaaaaa',
  live_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  controller_heartbeat_ref: 'controller-witness:allow',
  database_projection_ref: 'database:healthy:healthy',
  watch_cache_ref: 'watch:healthy',
  route_status_ref: 'route:healthy',
  torghut_proof_floor_ref: 'torghut-proof-floor:repair_only',
  fresh_until: freshUntil,
  action_decision: 'allow' as const,
  blocking_reasons: [],
  rollback_target: null,
  ...overrides,
})

const buildInput = (
  overrides: Partial<AuthorityProvenanceSettlementInput> = {},
): AuthorityProvenanceSettlementInput => ({
  now,
  namespace: 'agents',
  database: {
    configured: true,
    connected: true,
    status: 'healthy',
    message: '',
    latency_ms: 12,
    migration_consistency: {
      status: 'healthy',
      migration_table: 'kysely_migration',
      registered_count: 29,
      applied_count: 29,
      unapplied_count: 0,
      unexpected_count: 0,
      latest_registered: '20260508_torghut_quant_pipeline_health_account_window_created_at_index',
      latest_applied: '20260508_torghut_quant_pipeline_health_account_window_created_at_index',
      missing_migrations: [],
      unexpected_migrations: [],
      message: '',
    },
  },
  rolloutHealth: {
    status: 'healthy',
    observed_deployments: 2,
    degraded_deployments: 0,
    deployments: [],
    message: 'rollout healthy',
  },
  runtimeAdapters: [
    {
      name: 'workflow',
      available: true,
      status: 'configured',
      message: 'workflow runtime ready',
      endpoint: '',
      authority: {
        mode: 'heartbeat',
        namespace: 'agents',
        source_deployment: 'agents-controllers',
        source_pod: 'agents-controllers-0',
        observed_at: now.toISOString(),
        fresh: true,
        message: 'fresh heartbeat',
      },
    },
    {
      name: 'job',
      available: true,
      status: 'configured',
      message: 'job runtime ready',
      endpoint: '',
      authority: {
        mode: 'heartbeat',
        namespace: 'agents',
        source_deployment: 'agents-controllers',
        source_pod: 'agents-controllers-0',
        observed_at: now.toISOString(),
        fresh: true,
        message: 'fresh heartbeat',
      },
    },
  ],
  workflows: {
    active_job_runs: 0,
    recent_failed_jobs: 0,
    backoff_limit_exceeded_jobs: 0,
    data_confidence: 'high',
    collection_errors: 0,
  },
  watchReliability: {
    status: 'healthy',
    window_minutes: 15,
    observed_streams: 2,
    total_events: 40,
    total_errors: 0,
    total_restarts: 0,
    streams: [],
  },
  agentRunIngestion: {
    namespace: 'agents',
    status: 'healthy',
    message: 'AgentRun ingestion healthy',
    last_watch_event_at: now.toISOString(),
    last_resync_at: now.toISOString(),
    untouched_run_count: 0,
    oldest_untouched_age_seconds: null,
  },
  controllerWitness: baseControllerWitness,
  sourceRolloutTruthExchange: {
    mode: 'shadow',
    design_artifact:
      'docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md',
    exchange_id: 'source-rollout-truth:converged',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    namespace: 'agents',
    source_head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    gitops_revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    desired_images: [],
    live_images: [],
    controller_heartbeats: [],
    route_statuses: [],
    database_projection_ref: 'database:healthy:healthy',
    watch_cache_ref: 'watch:healthy',
    torghut_proof_floor: {
      proof_floor_ref: 'torghut-proof-floor:repair_only',
      state: 'repair_only',
      capital_state: 'zero_notional',
      fresh_until: freshUntil,
      blockers: [],
      evidence_refs: ['torghut-consumer-evidence:zero-notional'],
    },
    receipts: [
      buildReceipt('dispatch_normal'),
      buildReceipt('deploy_widen'),
      buildReceipt('merge_ready'),
      buildReceipt('paper_canary', {
        settlement_state: 'proof_floor_repair_only',
        action_decision: 'hold',
        blocking_reasons: ['torghut_zero_notional_repair_only'],
      }),
      buildReceipt('live_micro_canary', {
        settlement_state: 'proof_floor_repair_only',
        action_decision: 'block',
        blocking_reasons: ['torghut_zero_notional_repair_only'],
      }),
      buildReceipt('live_scale', {
        settlement_state: 'proof_floor_repair_only',
        action_decision: 'block',
        blocking_reasons: ['torghut_zero_notional_repair_only'],
      }),
    ],
    deployer_summary: {
      settlement_state: 'converged',
      freshest_blocking_reason: null,
      rollback_target: null,
      held_action_classes: [],
      receipt_refs: ['source-rollout:deploy_widen:converged', 'source-rollout:merge_ready:converged'],
    },
    rollback_target: null,
  },
  sourceServingContractVerdictExchange: {
    mode: 'observe',
    design_artifact:
      'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md',
    exchange_id: 'source-serving-contract:allow',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    namespace: 'agents',
    status: 'allow',
    source_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    serving_build_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    manifest_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    serving_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
    rollback_target: 'hold source-serving dependent actions',
  },
  stageClearancePackets: [],
  actionSloBudgets: [],
  projectionWatermarks: [],
  stageCreditLedger: {
    schema_version: 'jangar.stage-credit-ledger.v1',
    ledger_id: 'stage-credit-ledger:allow',
    namespace: 'agents',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    governing_design_refs: [],
    observed_revision: {
      source_head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      gitops_revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    evidence_mode: 'shadow',
    credit_epoch_id: 'stage-credit-epoch:allow',
    stage_accounts: [],
    runner_slot_futures: [
      {
        future_id: 'runner-slot-future:implement:test',
        account_id: 'stage-credit-account:implement:test',
        stage: 'implement',
        action_class: 'dispatch_normal',
        reserved_credit: 1,
        expires_at: freshUntil,
        max_dispatches: 1,
        max_runtime_seconds: 900,
        max_notional: 0,
        spend_reason: 'authority settled',
        required_receipts: ['stage-credit-ledger:allow'],
        settlement_state: 'open',
        settlement_ref: null,
      },
    ],
    retained_failure_debt_refs: [],
    settlement_policy: {
      mode: 'read_model_only',
      refund_condition: 'terminal success',
      burn_condition: 'terminal failure',
      conversion_condition: 'repair receipt',
      rollback_target: 'observe',
    },
    handoff_contract: {
      value_gates: ['failed_agentrun_rate'],
      status: 'allow',
      next_implementation_milestone: 'authority settlement',
      rollback_target: 'observe',
    },
  },
  readyTruthArbiter: {
    schema_version: 'jangar.ready-truth-arbiter.v1',
    mode: 'shadow',
    verdict_id: 'ready-truth:allow',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    namespace: 'agents',
    governing_design_refs: [],
    serving_readiness: 'ok',
    material_readiness: 'allow',
    argo_revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    argo_health: 'healthy',
    workload_rollout_ref: 'rollout:healthy',
    controller_witness_ref: 'controller-witness:allow',
    runtime_adapter_refs: [],
    stage_credit_ledger_ref: 'stage-credit-ledger:allow',
    source_serving_verdict_ref: 'source-serving-contract:allow',
    torghut_repair_receipt_ref: 'torghut-consumer-evidence:zero-notional',
    retained_failure_debt_refs: [],
    projection_foreclosure_notary_ref: null,
    projection_authority_decision: null,
    projection_claim_totals_by_state: null,
    projection_required_repair_actions: [],
    ready_status_truth_reasons: [],
    allowed_action_classes: [
      'serve_readonly',
      'dispatch_repair',
      'dispatch_normal',
      'deploy_widen',
      'merge_ready',
      'torghut_observe',
    ],
    repair_only_action_classes: [],
    held_action_classes: ['paper_canary'],
    blocked_action_classes: ['live_micro_canary', 'live_scale'],
    merge_gate_receipt: {
      receipt_id: 'ready-truth-gate:merge_ready',
      action_class: 'merge_ready',
      decision: 'allow',
      required_evidence_refs: [],
      reason_codes: [],
    },
    deployer_receipt: {
      receipt_id: 'ready-truth-gate:deploy_widen',
      action_class: 'deploy_widen',
      decision: 'allow',
      required_evidence_refs: [],
      reason_codes: [],
    },
    rollback_target: 'observe',
  },
  torghutConsumerEvidence: {
    status: 'current',
    endpoint: 'http://torghut/trading/consumer-evidence',
    receipt_id: 'torghut-consumer-evidence:zero-notional',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    candidate_id: null,
    dataset_snapshot_ref: null,
    max_notional: '0',
    reason_codes: [],
    message: 'zero-notional repair current',
  },
  ...overrides,
})

describe('control-plane authority provenance settlement', () => {
  it('settles heartbeat-authoritative split topology without allowing normal dispatch', () => {
    const settlement = buildAuthorityProvenanceSettlement(
      buildInput({
        agentRunIngestion: {
          namespace: 'agents',
          status: 'unknown',
          message: 'serving process has not started local ingestion',
          last_watch_event_at: null,
          last_resync_at: null,
          untouched_run_count: 0,
          oldest_untouched_age_seconds: null,
        },
        controllerWitness: {
          ...baseControllerWitness,
          quorum_id: 'controller-witness:split',
          decision: 'allow_with_split',
          reason_codes: ['controller_process_heartbeat_authoritative'],
          controller_self_report_current: true,
          message: 'controller heartbeat is authoritative while serving process is not the controller',
        },
      }),
    )

    expect(settlement.governing_design_refs).toContain(AUTHORITY_PROVENANCE_SETTLEMENT_DESIGN_ARTIFACT)
    expect(settlement.settlement_state).toBe('settled_with_split')
    expect(settlement.winning_authority).toBe('controller_heartbeat')
    expect(settlement.action_class_decisions).toContainEqual(
      expect.objectContaining({
        action_class: 'dispatch_normal',
        decision: 'repair_only',
        reason_codes: expect.arrayContaining(['settled_with_split', 'agentrun_ingestion_unknown']),
      }),
    )
  })

  it('holds when controller heartbeat authority is missing', () => {
    const settlement = buildAuthorityProvenanceSettlement(
      buildInput({
        controllerWitness: {
          ...baseControllerWitness,
          quorum_id: 'controller-witness:missing',
          decision: 'repair_only',
          reason_codes: ['controller_witness_split'],
          controller_self_report_current: false,
          message: 'controller deployment and watch are current, but heartbeat is missing',
        },
      }),
    )

    expect(settlement.settlement_state).toBe('hold')
    expect(settlement.surfaces).toContainEqual(
      expect.objectContaining({
        surface: 'controller_process',
        status: 'missing',
        reason_codes: expect.arrayContaining(['controller_heartbeat_missing']),
      }),
    )
  })

  it('holds deploy widening and merge readiness on source, GitOps, and image mismatch', () => {
    const mismatchReceipt = {
      settlement_state: 'rollout_lagging_source' as const,
      action_decision: 'hold' as const,
      desired_image_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      live_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      blocking_reasons: ['desired_live_image_mismatch'],
    }
    const input = buildInput()
    const settlement = buildAuthorityProvenanceSettlement(
      buildInput({
        sourceRolloutTruthExchange: {
          ...input.sourceRolloutTruthExchange,
          receipts: input.sourceRolloutTruthExchange.receipts.map((receipt) => {
            if (receipt.action_class === 'deploy_widen' || receipt.action_class === 'merge_ready') {
              return { ...receipt, ...mismatchReceipt }
            }
            return receipt
          }),
          deployer_summary: {
            ...input.sourceRolloutTruthExchange.deployer_summary,
            settlement_state: 'rollout_lagging_source',
            freshest_blocking_reason: 'desired_live_image_mismatch',
            held_action_classes: ['deploy_widen', 'merge_ready'],
          },
        },
      }),
    )

    expect(settlement.settlement_state).toBe('repairable_split')
    expect(settlement.action_class_decisions).toContainEqual(
      expect.objectContaining({
        action_class: 'deploy_widen',
        decision: 'hold',
        reason_codes: expect.arrayContaining(['desired_live_image_mismatch']),
      }),
    )
    expect(settlement.action_class_decisions).toContainEqual(
      expect.objectContaining({
        action_class: 'merge_ready',
        decision: 'hold',
        reason_codes: expect.arrayContaining(['desired_live_image_mismatch']),
      }),
    )
  })

  it('opens a bounded normal-dispatch reentry window when source, rollout, and ingestion are current', () => {
    const settlement = buildAuthorityProvenanceSettlement(buildInput())

    expect(settlement.settlement_state).toBe('settled')
    expect(settlement.action_class_decisions).toContainEqual(
      expect.objectContaining({
        action_class: 'dispatch_normal',
        decision: 'allow',
      }),
    )
    expect(settlement.reentry_windows).toEqual([
      expect.objectContaining({
        stage: 'implement',
        action_class: 'dispatch_normal',
        max_dispatches: 1,
        max_runtime_seconds: 900,
        required_receipts: expect.arrayContaining(['runner-slot-future:implement:test']),
      }),
    ])
  })

  it('allows zero-notional repair and observation without paper or live capital authority', () => {
    const settlement = buildAuthorityProvenanceSettlement(buildInput())

    expect(settlement.action_class_decisions).toContainEqual(
      expect.objectContaining({
        action_class: 'torghut_observe',
        decision: 'allow',
      }),
    )
    expect(settlement.action_class_decisions).toContainEqual(
      expect.objectContaining({
        action_class: 'dispatch_repair',
        decision: 'allow',
        max_notional: 0,
      }),
    )
    expect(settlement.action_class_decisions).toContainEqual(
      expect.objectContaining({
        action_class: 'paper_canary',
        decision: 'hold',
        reason_codes: expect.arrayContaining(['torghut_zero_notional_repair_only']),
      }),
    )
    expect(settlement.action_class_decisions).toContainEqual(
      expect.objectContaining({
        action_class: 'live_micro_canary',
        decision: 'block',
        reason_codes: expect.arrayContaining(['torghut_zero_notional_repair_only']),
      }),
    )
  })
})
