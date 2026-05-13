import { describe, expect, it } from 'vitest'

import type {
  ActionSloBudgetActionClass,
  AdmissionPassportStatus,
  ControlPlaneControllerWitnessQuorum,
  ExecutionTrustStatus,
  ProjectionForeclosureNotary,
  ProjectionForeclosureAuthorityState,
  RepairBidAdmissionReceipt,
  RepairBidAdmissionState,
  SourceServingContractActionClass,
  SourceServingContractVerdict,
  SourceServingContractVerdictExchange,
  StageCreditAccount,
  StageCreditLedger,
  TorghutConsumerEvidenceStatus,
} from '~/data/agents-control-plane'
import { buildReadyTruthArbiter, READY_TRUTH_ARBITER_DESIGN_ARTIFACT } from '~/server/control-plane-ready-truth-arbiter'
import type {
  ControlPlaneRolloutHealth,
  DatabaseStatus,
  RuntimeAdapterStatus,
} from '~/server/control-plane-status-types'

const now = new Date('2026-05-13T12:00:00.000Z')

const actionClasses: ActionSloBudgetActionClass[] = [
  'serve_readonly',
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
  'torghut_observe',
  'paper_canary',
  'live_micro_canary',
  'live_scale',
]

const database = (overrides: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
  configured: true,
  connected: true,
  status: 'healthy',
  message: 'database healthy',
  latency_ms: 4,
  migration_consistency: {
    status: 'healthy',
    migration_table: 'kysely_migration',
    registered_count: 29,
    applied_count: 29,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260513_ready_truth',
    latest_applied: '20260513_ready_truth',
    missing_migrations: [],
    unexpected_migrations: [],
    message: 'migrations consistent',
  },
  ...overrides,
})

const rolloutHealth = (status: ControlPlaneRolloutHealth['status'] = 'healthy'): ControlPlaneRolloutHealth => ({
  status,
  observed_deployments: 2,
  degraded_deployments: status === 'healthy' ? 0 : 1,
  deployments: [],
  message: `rollout ${status}`,
})

const runtimeAdapter = (name: string, overrides: Partial<RuntimeAdapterStatus> = {}): RuntimeAdapterStatus => ({
  name,
  available: true,
  status: 'configured',
  message: `${name} configured`,
  endpoint: '',
  authority: {
    mode: 'heartbeat',
    namespace: 'agents',
    source_deployment: 'agents-controllers',
    source_pod: 'agents-controllers-0',
    observed_at: now.toISOString(),
    fresh: true,
    message: `${name} heartbeat fresh`,
  },
  ...overrides,
})

const controllerWitness = (
  overrides: Partial<ControlPlaneControllerWitnessQuorum> = {},
): ControlPlaneControllerWitnessQuorum => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
  quorum_id: 'controller-witness-quorum:healthy',
  generated_at: now.toISOString(),
  expires_at: '2026-05-13T12:01:00.000Z',
  namespace: 'agents',
  decision: 'allow',
  reason_codes: [],
  message: 'controller witness healthy',
  witness_refs: ['controller-witness:agents-controller'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [],
  rollback_target: null,
  ...overrides,
})

const executionTrust = (status: ExecutionTrustStatus['status'] = 'healthy'): ExecutionTrustStatus => ({
  status,
  reason: status === 'healthy' ? 'execution trust healthy' : `execution trust ${status}`,
  last_evaluated_at: now.toISOString(),
  blocking_windows:
    status === 'healthy'
      ? []
      : [
          {
            type: 'swarms',
            scope: 'agents',
            name: 'jangar-control-plane',
            reason: 'StageStaleness',
            class: status === 'blocked' ? 'blocked' : 'degraded',
          },
        ],
  evidence_summary: status === 'healthy' ? [] : ['jangar-control-plane frozen for StageStaleness'],
})

const servingPassport = (overrides: Partial<AdmissionPassportStatus> = {}): AdmissionPassportStatus => ({
  admission_passport_id: 'passport:serving:ready',
  consumer_class: 'serving',
  authority_session_id: 'authority:ready',
  recovery_case_set_digest: 'recovery-case:ready',
  runtime_kit_set_digest: 'runtime-kit-set:ready',
  decision: 'allow',
  reason_codes: [],
  required_subjects: [],
  required_runtime_kits: ['runtime-kit:serving'],
  issued_at: now.toISOString(),
  fresh_until: '2026-05-13T12:01:00.000Z',
  producer_revision: 'ready-truth-test',
  ...overrides,
})

const stageAccount = (
  actionClass: ActionSloBudgetActionClass,
  decision: StageCreditAccount['decision'] = 'allow',
  overrides: Partial<StageCreditAccount> = {},
): StageCreditAccount => ({
  account_id: `stage-credit-account:${actionClass}`,
  stage: actionClass === 'deploy_widen' || actionClass === 'merge_ready' ? 'deployer' : 'implement',
  action_class: actionClass,
  opening_credit: 100,
  base_credit: 100,
  evidence_freshness_bonus: 0,
  torghut_repair_value_credit: 0,
  rollout_truth_deposit: 0,
  failure_debt_tax: decision === 'allow' ? 0 : 50,
  controller_witness_tax: 0,
  source_rollout_tax: 0,
  capital_safety_tax: 0,
  available_credit: decision === 'allow' || decision === 'repair_only' ? 100 : 0,
  minimum_spend: 50,
  max_concurrent_runs: decision === 'allow' || decision === 'repair_only' ? 1 : 0,
  max_runtime_seconds: 1800,
  max_notional: 0,
  decision,
  reason_codes: decision === 'allow' ? [] : ['stage_credit_insufficient'],
  required_repair_actions: decision === 'repair_only' ? ['close repair lot'] : [],
  evidence_refs: [`stage-credit-evidence:${actionClass}`],
  selected_repair_lot_ref: decision === 'repair_only' ? 'repair-lot:stage-credit' : null,
  rollback_target: 'JANGAR_STAGE_CREDIT_LEDGER_MODE=observe',
  ...overrides,
})

const stageCreditLedger = (
  decisions: Partial<Record<ActionSloBudgetActionClass, StageCreditAccount['decision']>> = {},
): StageCreditLedger => ({
  schema_version: 'jangar.stage-credit-ledger.v1',
  ledger_id: 'stage-credit-ledger:ready-truth',
  namespace: 'agents',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:01:00.000Z',
  governing_design_refs: ['docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md'],
  observed_revision: {
    source_head_sha: 'source-sha',
    gitops_revision: 'gitops-sha',
  },
  evidence_mode: 'observe',
  credit_epoch_id: 'stage-credit-epoch:ready-truth',
  stage_accounts: actionClasses.map((actionClass) => stageAccount(actionClass, decisions[actionClass] ?? 'allow')),
  runner_slot_futures: [],
  retained_failure_debt_refs: decisions.dispatch_normal === 'hold' ? ['clearance-failure-debt:15m:active'] : [],
  settlement_policy: {
    mode: 'read_model_only',
    refund_condition: 'success refunds credit',
    burn_condition: 'failure burns credit',
    conversion_condition: 'repair closes selected lot',
    rollback_target: 'JANGAR_STAGE_CREDIT_LEDGER_MODE=observe',
  },
  handoff_contract: {
    value_gates: ['failed_agentrun_rate', 'ready_status_truth'],
    status: decisions.dispatch_normal ?? 'allow',
    next_implementation_milestone: 'ready truth arbiter shadow read model',
    rollback_target: 'JANGAR_STAGE_CREDIT_LEDGER_MODE=observe',
  },
})

const sourceActionFor = (actionClass: ActionSloBudgetActionClass): SourceServingContractActionClass | null => {
  if (actionClass === 'paper_canary') return 'paper_support'
  if (actionClass === 'live_micro_canary' || actionClass === 'live_scale') return 'live_support'
  return actionClass === 'torghut_observe' ? null : actionClass
}

const sourceVerdict = (
  actionClass: SourceServingContractActionClass,
  decision: SourceServingContractVerdict['decision'] = 'allow',
) =>
  ({
    schema_version: 'jangar.source-serving-contract-verdict.v1',
    verdict_id: `source-serving-verdict:${actionClass}`,
    generated_at: now.toISOString(),
    fresh_until: '2026-05-13T12:01:00.000Z',
    repository: 'proompteng/lab',
    source_sha: 'source-sha',
    source_ci_run_id: 'source-ci:1',
    source_ci_conclusion: 'success',
    manifest_sha: 'gitops-sha',
    manifest_image_digest: 'sha256:manifest',
    argo_sync_revision: 'gitops-sha',
    argo_health: 'healthy',
    serving_revision: 'runtime',
    serving_build_commit: 'source-sha',
    serving_image_digest: 'sha256:manifest',
    required_contracts: [],
    observed_contracts: [],
    missing_contracts: [],
    contract_schema_mismatches: [],
    torghut_route_warrant_ref: 'route-warrant:current',
    torghut_repair_bid_settlement_ref: 'repair-bid-settlement:current',
    action_class: actionClass,
    decision,
    source_serving_state: 'converged',
    max_notional: 0,
    value_gate_impacts: [],
    required_repair_receipts: [],
    blocking_reason_codes: decision === 'allow' ? [] : ['source_contract_hold'],
    evidence_refs: [`source-serving-evidence:${actionClass}`],
    rollback_gate: 'hold rollout widening until source and serving converge',
  }) as SourceServingContractVerdict

const sourceServingExchange = (
  decisions: Partial<Record<SourceServingContractActionClass, SourceServingContractVerdict['decision']>> = {},
): SourceServingContractVerdictExchange => {
  const verdicts = actionClasses
    .map(sourceActionFor)
    .filter((actionClass): actionClass is SourceServingContractActionClass => actionClass !== null)
    .map((actionClass) => sourceVerdict(actionClass, decisions[actionClass] ?? 'allow'))

  return {
    mode: 'observe',
    design_artifact:
      'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md',
    exchange_id: 'source-serving-contract-verdict-exchange:ready-truth',
    generated_at: now.toISOString(),
    fresh_until: '2026-05-13T12:01:00.000Z',
    namespace: 'agents',
    status: 'allow',
    source_sha: 'source-sha',
    serving_build_commit: 'source-sha',
    manifest_image_digest: 'sha256:manifest',
    serving_image_digest: 'sha256:manifest',
    required_contracts: [],
    observed_contracts: [],
    missing_contracts: [],
    verdict_refs: verdicts.map((verdict) => verdict.verdict_id),
    allowed_action_classes: verdicts
      .filter((verdict) => verdict.decision === 'allow')
      .map((verdict) => verdict.action_class),
    repair_only_action_classes: [],
    held_action_classes: verdicts
      .filter((verdict) => verdict.decision === 'hold')
      .map((verdict) => verdict.action_class),
    blocked_action_classes: verdicts
      .filter((verdict) => verdict.decision === 'block')
      .map((verdict) => verdict.action_class),
    reason_codes: [],
    verdicts,
    rollback_target: 'ignore source-serving contract verdict exchange',
  }
}

const repairReceipt = (
  actionClass: ActionSloBudgetActionClass,
  decision: RepairBidAdmissionReceipt['decision'] = 'allow',
): RepairBidAdmissionReceipt => ({
  schema_version: 'jangar.repair-bid-admission-receipt.v1',
  receipt_id: `repair-bid-admission:${actionClass}`,
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:01:00.000Z',
  repository: 'proompteng/lab',
  branch: 'main',
  swarm_name: 'torghut-quant',
  stage: 'implement',
  action_class: actionClass,
  decision,
  torghut_settlement_ledger_ref: 'repair-bid-settlement:current',
  torghut_compacted_lot_refs: decision === 'allow' ? ['compacted-lot:quant'] : [],
  active_dedupe_keys: [],
  admitted_lot_ids: decision === 'allow' ? ['compacted-lot:quant'] : [],
  held_lot_ids: decision === 'allow' ? [] : ['compacted-lot:quant'],
  denied_reason_codes: decision === 'allow' ? [] : ['repair_bid_settlement_hold'],
  max_parallelism: decision === 'allow' ? 1 : 0,
  max_runtime_seconds: decision === 'allow' ? 1200 : 0,
  max_notional: 0,
  validation_commands: [],
  rollback_gate: 'disable repair-bid admission enforcement and keep Torghut max_notional=0',
})

const repairBidAdmission = (
  decisions: Partial<Record<ActionSloBudgetActionClass, RepairBidAdmissionReceipt['decision']>> = {},
): RepairBidAdmissionState => ({
  schema_version: 'jangar.repair-bid-admission-state.v1',
  mode: 'observe',
  design_artifact: 'docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:01:00.000Z',
  status: 'allow',
  torghut_settlement_ledger_ref: 'repair-bid-settlement:current',
  receipts: actionClasses.map((actionClass) => repairReceipt(actionClass, decisions[actionClass] ?? 'allow')),
  dispatch_tickets: [],
  admitted_lot_ids: ['compacted-lot:quant'],
  held_lot_ids: [],
  active_dedupe_keys: [],
  reason_codes: [],
  rollback_target: 'disable repair-bid admission enforcement and keep Torghut max_notional=0',
})

const torghutConsumerEvidence = (
  status: TorghutConsumerEvidenceStatus['status'] = 'current',
): TorghutConsumerEvidenceStatus => ({
  status,
  endpoint: 'http://torghut/trading/consumer-evidence',
  receipt_id: status === 'current' ? 'torghut-consumer-evidence:current' : null,
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:01:00.000Z',
  candidate_id: null,
  dataset_snapshot_ref: null,
  max_notional: '0',
  reason_codes: [],
  message: `torghut evidence ${status}`,
})

const buildInput = (
  overrides: Partial<Parameters<typeof buildReadyTruthArbiter>[0]> = {},
): Parameters<typeof buildReadyTruthArbiter>[0] => ({
  now,
  namespace: 'agents',
  database: database(),
  rolloutHealth: rolloutHealth(),
  runtimeAdapters: [runtimeAdapter('workflow'), runtimeAdapter('job'), runtimeAdapter('temporal')],
  admissionPassports: [servingPassport()],
  controllerWitness: controllerWitness(),
  executionTrust: executionTrust(),
  stageCreditLedger: stageCreditLedger(),
  sourceServingContractVerdictExchange: sourceServingExchange(),
  repairBidAdmission: repairBidAdmission(),
  torghutConsumerEvidence: torghutConsumerEvidence(),
  ...overrides,
})

const projectionTotals = (
  overrides: Partial<Record<ProjectionForeclosureAuthorityState, number>> = {},
): Record<ProjectionForeclosureAuthorityState, number> => ({
  authoritative: 0,
  grace: 0,
  stale_foreclosed: 0,
  contradictory: 0,
  missing_receipt: 0,
  terminal_audit: 0,
  unknown: 0,
  ...overrides,
})

const projectionNotary = (overrides: Partial<ProjectionForeclosureNotary> = {}): ProjectionForeclosureNotary => {
  const totals = projectionTotals({ missing_receipt: 1 })
  return {
    schema_version: 'jangar.projection-foreclosure-notary.v1',
    generated_at: now.toISOString(),
    fresh_until: '2026-05-13T12:02:00.000Z',
    namespace: 'agents',
    source_revision: {
      source_head_sha: 'source-sha',
      gitops_revision: 'gitops-sha',
    },
    decision: 'repair_only',
    notary_id: 'projection-foreclosure-notary:agents:missing-receipt',
    governing_design_refs: [
      'docs/agents/designs/190-jangar-projection-foreclosure-notary-and-stage-custody-repair-2026-05-13.md',
    ],
    active_authority_summary: totals,
    stale_projection_summary: projectionTotals(),
    claim_totals_by_state: totals,
    stage_custody_verdict: {
      decision: 'repair_only',
      evidence_clock_custody_status: 'missing',
      evidence_clock_custody_ref: null,
      max_notional: '0',
      reason_codes: ['evidence_clock_custody_missing'],
      evidence_refs: ['torghut-route-proven-profit:missing'],
    },
    claims: [],
    foreclosure_receipts: [],
    missing_receipts: [],
    required_repair_actions: ['attach current Torghut market-context freshness receipt'],
    rollback_target: 'JANGAR_PROJECTION_FORECLOSURE_NOTARY_ENABLED=false',
    ...overrides,
  }
}

describe('buildReadyTruthArbiter', () => {
  it('allows material readiness when launch, deploy, and merge evidence agree', () => {
    const arbiter = buildReadyTruthArbiter(buildInput(), 'shadow')

    expect(arbiter).toMatchObject({
      schema_version: 'jangar.ready-truth-arbiter.v1',
      mode: 'shadow',
      serving_readiness: 'ok',
      material_readiness: 'allow',
      argo_revision: 'gitops-sha',
      argo_health: 'healthy',
      stage_credit_ledger_ref: 'stage-credit-ledger:ready-truth',
      source_serving_verdict_ref: 'source-serving-contract-verdict-exchange:ready-truth',
      torghut_repair_receipt_ref: 'repair-bid-settlement:current',
      governing_design_refs: expect.arrayContaining([READY_TRUTH_ARBITER_DESIGN_ARTIFACT]),
    })
    expect(arbiter.allowed_action_classes).toEqual(
      expect.arrayContaining(['serve_readonly', 'dispatch_normal', 'deploy_widen', 'merge_ready']),
    )
    expect(arbiter.merge_gate_receipt).toMatchObject({
      action_class: 'merge_ready',
      decision: 'allow',
      reason_codes: [],
    })
  })

  it('keeps serving ok but holds material readiness when controller/runtime and execution trust degrade', () => {
    const arbiter = buildReadyTruthArbiter(
      buildInput({
        controllerWitness: controllerWitness({
          decision: 'hold_material',
          reason_codes: ['controller_ingestion_stalled'],
          message: 'controller ingestion is stalled',
        }),
        runtimeAdapters: [
          runtimeAdapter('workflow', { available: false, status: 'degraded', message: 'workflow runtime not started' }),
          runtimeAdapter('job', { available: false, status: 'degraded', message: 'job runtime not started' }),
          runtimeAdapter('temporal'),
        ],
        executionTrust: executionTrust('degraded'),
        stageCreditLedger: stageCreditLedger({
          dispatch_normal: 'hold',
          deploy_widen: 'hold',
          merge_ready: 'hold',
        }),
      }),
      'shadow',
    )

    expect(arbiter.serving_readiness).toBe('ok')
    expect(arbiter.material_readiness).toBe('hold')
    expect(arbiter.allowed_action_classes).toEqual(expect.arrayContaining(['serve_readonly', 'torghut_observe']))
    expect(arbiter.held_action_classes).toEqual(
      expect.arrayContaining(['dispatch_normal', 'deploy_widen', 'merge_ready']),
    )
    expect(arbiter.ready_status_truth_reasons).toEqual(
      expect.arrayContaining([
        'controller_witness_hold_material',
        'runtime_adapter_workflow_degraded',
        'runtime_adapter_job_degraded',
        'execution_trust_degraded',
        'stage_credit_hold',
      ]),
    )
    expect(arbiter.merge_gate_receipt.decision).toBe('hold')
  })

  it('reports repair_only when bounded dispatch repair remains available while normal launch is held', () => {
    const arbiter = buildReadyTruthArbiter(
      buildInput({
        stageCreditLedger: stageCreditLedger({
          dispatch_repair: 'repair_only',
          dispatch_normal: 'hold',
          deploy_widen: 'hold',
          merge_ready: 'hold',
        }),
      }),
      'shadow',
    )

    expect(arbiter.serving_readiness).toBe('ok')
    expect(arbiter.material_readiness).toBe('repair_only')
    expect(arbiter.repair_only_action_classes).toContain('dispatch_repair')
    expect(arbiter.held_action_classes).toEqual(
      expect.arrayContaining(['dispatch_normal', 'deploy_widen', 'merge_ready']),
    )
    expect(arbiter.deployer_receipt.decision).toBe('hold')
  })

  it('surfaces projection authority and holds material gates when notary consumption is enabled', () => {
    const previous = process.env.JANGAR_PROJECTION_FORECLOSURE_CONSUME
    process.env.JANGAR_PROJECTION_FORECLOSURE_CONSUME = 'true'
    try {
      const arbiter = buildReadyTruthArbiter(
        buildInput({
          projectionForeclosureNotary: projectionNotary(),
        }),
        'shadow',
      )

      expect(arbiter.projection_foreclosure_notary_ref).toBe('projection-foreclosure-notary:agents:missing-receipt')
      expect(arbiter.projection_authority_decision).toBe('repair_only')
      expect(arbiter.projection_claim_totals_by_state?.missing_receipt).toBe(1)
      expect(arbiter.projection_required_repair_actions).toEqual([
        'attach current Torghut market-context freshness receipt',
      ])
      expect(arbiter.material_readiness).toBe('repair_only')
      expect(arbiter.ready_status_truth_reasons).toContain('projection_foreclosure_missing_receipt')
      expect(arbiter.held_action_classes).toEqual(
        expect.arrayContaining(['dispatch_normal', 'deploy_widen', 'merge_ready']),
      )
    } finally {
      if (previous === undefined) {
        delete process.env.JANGAR_PROJECTION_FORECLOSURE_CONSUME
      } else {
        process.env.JANGAR_PROJECTION_FORECLOSURE_CONSUME = previous
      }
    }
  })
})
