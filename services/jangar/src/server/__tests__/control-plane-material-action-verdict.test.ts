import { describe, expect, it } from 'vitest'

import type {
  ActionSloBudget,
  ActionSloBudgetActionClass,
  ControlPlaneControllerWitnessQuorum,
  DependencyQuorumStatus,
  EmpiricalServicesStatus,
  FailureDomainActionClass,
  NegativeEvidenceRouterStatus,
  ReconciledActionClock,
  RepairWarrantExchange,
  SourceRolloutTruthExchange,
} from '~/data/agents-control-plane'
import { buildMaterialActionVerdictEpoch } from '~/server/control-plane-material-action-verdict'
import type {
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

const now = new Date('2026-05-06T14:00:00.000Z')

const budget = (
  actionClass: ActionSloBudgetActionClass,
  decision: ActionSloBudget['decision'],
  overrides: Partial<ActionSloBudget> = {},
): ActionSloBudget => ({
  budget_id: `slo:${actionClass}:${decision}`,
  router_epoch_id: 'ner:test',
  action_class: actionClass,
  consumer: actionClass === 'paper_canary' ? 'torghut-sim' : 'deployer',
  scope: 'agents/jangar',
  decision,
  max_dispatches: decision === 'hold' || decision === 'block' ? 0 : 1,
  max_runtime_seconds: decision === 'hold' || decision === 'block' ? 0 : 600,
  max_notional: 0,
  max_error_budget_spend: decision === 'hold' || decision === 'block' ? 0 : 0.01,
  fresh_until: '2026-05-06T14:15:00.000Z',
  downgrade_reasons: decision === 'repair_only' ? ['controller_witness_split'] : [],
  blocked_reasons: decision === 'hold' || decision === 'block' ? [`${actionClass}_blocked_by_test_evidence`] : [],
  required_repairs: decision === 'hold' || decision === 'block' ? [`repair ${actionClass} test evidence`] : [],
  rollback_target: decision === 'allow' ? null : `rollback ${actionClass}`,
  evidence_refs: [`evidence:${actionClass}:${decision}`],
  ...overrides,
})

const clock = (
  actionClass: FailureDomainActionClass,
  decision: ReconciledActionClock['decision'],
  overrides: Partial<ReconciledActionClock> = {},
): ReconciledActionClock => ({
  clock_id: `clock:${actionClass}:${decision}`,
  namespace: 'agents',
  action_class: actionClass,
  decision,
  conflict_class: 'none',
  confidence: 'high',
  observed_at: now.toISOString(),
  fresh_until: '2026-05-06T14:01:00.000Z',
  positive_lease_ids: [`fdl:${actionClass}:positive`],
  negative_lease_ids: [],
  blocking_reason_codes: decision === 'allow' ? [] : [`${actionClass}_clock_negative`],
  required_repair_actions: decision === 'allow' ? [] : [`repair ${actionClass} clock`],
  rollback_target: decision === 'allow' ? null : `rollback ${actionClass} clock`,
  producer_revision: '2026-05-06-action-clock-shadow-v1',
  evidence_refs: [`clock-evidence:${actionClass}:${decision}`],
  ...overrides,
})

const dependencyQuorum = (overrides: Partial<DependencyQuorumStatus> = {}): DependencyQuorumStatus => ({
  decision: 'allow',
  reasons: [],
  message: 'Control-plane admission dependencies are healthy.',
  ...overrides,
})

const router = (overrides: Partial<NegativeEvidenceRouterStatus> = {}): NegativeEvidenceRouterStatus => ({
  mode: 'observe',
  design_artifact: 'docs/agents/designs/111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md',
  router_epoch_id: 'ner:test',
  generated_at: now.toISOString(),
  evidence_window_minutes: 15,
  positive_evidence_refs: ['database:projection:healthy'],
  negative_evidence_refs: [],
  contradiction_refs: [],
  source_schema_ref: 'source_schema:latest_registered:test',
  database_projection_ref: 'database:projection:status',
  gitops_convergence_ref: 'rollout:healthy',
  failure_domain_lease_refs: ['fdl:test'],
  consumer_refs: ['deployer'],
  ...overrides,
})

const controllerWitness = (): ControlPlaneControllerWitnessQuorum => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
  quorum_id: 'controller-witness:test',
  generated_at: now.toISOString(),
  expires_at: '2026-05-06T14:05:00.000Z',
  namespace: 'agents',
  decision: 'allow',
  reason_codes: [],
  message: 'controller self-report and AgentRun ingestion are current',
  witness_refs: ['witness:serving_process:test'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [],
  rollback_target: null,
})

const database = (): DatabaseStatus => ({
  configured: true,
  connected: true,
  status: 'healthy',
  message: 'database healthy',
  latency_ms: 3,
  migration_consistency: {
    status: 'healthy',
    migration_table: 'kysely_migration',
    registered_count: 1,
    applied_count: 1,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260505_torghut_quant_pipeline_health_window_index',
    latest_applied: '20260505_torghut_quant_pipeline_health_window_index',
    missing_migrations: [],
    unexpected_migrations: [],
    message: '',
  },
})

const rollout = (): ControlPlaneRolloutHealth => ({
  status: 'healthy',
  observed_deployments: 2,
  degraded_deployments: 0,
  deployments: [],
  message: 'rollout healthy',
})

const watch = (): ControlPlaneWatchReliability => ({
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 2,
  total_events: 10,
  total_errors: 0,
  total_restarts: 0,
  streams: [],
})

const empiricalServices = (): EmpiricalServicesStatus => ({
  forecast: {
    status: 'healthy',
    endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
    message: 'forecast ready',
    authoritative: true,
  },
  lean: {
    status: 'healthy',
    endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
    message: 'lean ready',
    authoritative: true,
  },
  jobs: {
    status: 'healthy',
    endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
    message: 'jobs fresh',
    authoritative: true,
    stale_jobs: [],
  },
})

const build = (input: {
  budgets: ActionSloBudget[]
  clocks: ReconciledActionClock[]
  dependency?: Partial<DependencyQuorumStatus>
  repairWarrantExchange?: RepairWarrantExchange
  sourceRolloutTruthExchange?: SourceRolloutTruthExchange
}) =>
  buildMaterialActionVerdictEpoch({
    now,
    namespace: 'agents',
    dependencyQuorum: dependencyQuorum(input.dependency),
    negativeEvidenceRouter: router(),
    actionSloBudgets: input.budgets,
    reconciledActionClocks: input.clocks,
    rolloutHealth: rollout(),
    controllerWitness: controllerWitness(),
    database: database(),
    watchReliability: watch(),
    empiricalServices: empiricalServices(),
    sourceRolloutTruthExchange: input.sourceRolloutTruthExchange,
    repairWarrantExchange: input.repairWarrantExchange,
  })

const findVerdict = (epoch: ReturnType<typeof build>, actionClass: ActionSloBudgetActionClass) => {
  const verdict = epoch.final_verdicts.find((entry) => entry.action_class === actionClass)
  expect(verdict).toBeTruthy()
  return verdict!
}

const repairWarrantExchange = (overrides: Partial<RepairWarrantExchange> = {}): RepairWarrantExchange => ({
  mode: 'observe',
  design_artifact: 'docs/agents/designs/146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md',
  exchange_id: 'repair-warrant-exchange:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-06T14:01:00.000Z',
  namespace: 'agents',
  status: 'healthy',
  source_epoch_id: 'source-rollout-truth:test',
  schedule_debt_window: {
    started_at: '2026-05-06T10:00:00.000Z',
    expires_at: '2026-05-06T14:01:00.000Z',
    window_minutes: 240,
    open_error_count: 0,
    superseded_error_count: 0,
    success_count: 1,
    running_count: 0,
    firebreak_state: 'clear',
    lanes: [],
    collection_errors: [],
  },
  active_warrants: [
    {
      warrant_id: 'repair-warrant:torghut.execution_tca:test',
      source_epoch_id: 'source-rollout-truth:test',
      source_budget_id: 'slo:dispatch_repair:test',
      repair_code: 'torghut.execution_tca',
      repair_dimension: 'execution_tca',
      account_label: 'torghut-live',
      torghut_revision: 'torghut-00257',
      action_class: 'dispatch_repair',
      admission_state: 'admitted',
      max_dispatches: 1,
      max_runtime_seconds: 1200,
      max_notional: 0,
      expected_unblock_value: 0.9,
      risk_tier: 'high',
      fresh_until: '2026-05-06T14:01:00.000Z',
      owner_lane: 'jangar-control-plane:repair',
      validation_refs: ['GET /trading/status execution_tca'],
      closure_requirements: ['fresh execution TCA receipt inside the active observation epoch'],
      rollback_target: 'disable warrant enforcement and fall back to dependency quorum plus action SLO budgets',
      reason_codes: ['execution_tca_stale'],
      evidence_refs: ['torghut-proof-floor:repair_only:test'],
    },
  ],
  closed_warrants: [],
  expired_warrants: [],
  suppressed_candidates: [],
  rollback_target: 'set repair warrant enforcement to observe and keep dependency quorum/action SLO budgets',
  ...overrides,
})

const sourceRolloutTruthExchange = (
  actionClass: ActionSloBudgetActionClass,
  overrides: Partial<SourceRolloutTruthExchange> = {},
): SourceRolloutTruthExchange => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md',
  exchange_id: 'source-rollout-truth:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-06T14:01:00.000Z',
  namespace: 'agents',
  source_head_sha: 'source-head:test',
  gitops_revision: 'gitops:test',
  desired_images: [],
  live_images: [],
  controller_heartbeats: [],
  route_statuses: [],
  database_projection_ref: 'database:projection:status',
  watch_cache_ref: 'watch:cache:test',
  torghut_proof_floor: {
    proof_floor_ref: 'torghut-proof-floor:test',
    state: 'closed',
    capital_state: 'paper',
    fresh_until: '2026-05-06T14:01:00.000Z',
    blockers: [],
    evidence_refs: ['torghut-proof-floor:test'],
  },
  receipts: [
    {
      receipt_id: `source-rollout-truth-receipt:${actionClass}:test`,
      action_class: actionClass,
      settlement_state: 'converged',
      source_head_sha: 'source-head:test',
      gitops_revision: 'gitops:test',
      desired_image_ref: 'registry.example/jangar:test',
      desired_image_digest: 'sha256:'.padEnd(71, '1'),
      live_image_ref: 'registry.example/jangar:test',
      live_image_digest: 'sha256:'.padEnd(71, '1'),
      controller_heartbeat_ref: 'controller-witness:test',
      database_projection_ref: 'database:projection:status',
      watch_cache_ref: 'watch:cache:test',
      route_status_ref: 'route:healthy:test',
      torghut_proof_floor_ref: 'torghut-proof-floor:test',
      fresh_until: '2026-05-06T14:01:00.000Z',
      action_decision: 'allow',
      blocking_reasons: [],
      rollback_target: null,
    },
  ],
  deployer_summary: {
    settlement_state: 'converged',
    freshest_blocking_reason: null,
    rollback_target: null,
    held_action_classes: [],
    receipt_refs: [`source-rollout-truth-receipt:${actionClass}:test`],
  },
  rollback_target: null,
  ...overrides,
})

describe('material action verdict arbiter', () => {
  it('keeps merge-ready held when the SLO budget is stricter than the action clock', () => {
    const epoch = build({
      dependency: {
        decision: 'block',
        reasons: ['empirical_jobs_degraded'],
        message: 'Control-plane dependency quorum is blocked.',
      },
      budgets: [
        budget('merge_ready', 'hold', {
          blocked_reasons: ['empirical_jobs_degraded'],
          required_repairs: ['refresh Torghut empirical proof'],
        }),
      ],
      clocks: [clock('merge_ready', 'allow')],
    })

    const verdict = findVerdict(epoch, 'merge_ready')
    expect(verdict).toMatchObject({
      decision: 'hold',
      blocking_reason_codes: expect.arrayContaining(['empirical_jobs_degraded']),
      max_dispatches: 0,
      max_runtime_seconds: 0,
    })
    expect(verdict.contradiction_refs[0]).toContain('budget_hold:clock_allow')
    expect(epoch.contradiction_refs).toEqual(verdict.contradiction_refs)
  })

  it('keeps paper canary held when the SLO budget is stricter than the Torghut capital clock', () => {
    const epoch = build({
      budgets: [
        budget('paper_canary', 'hold', {
          blocked_reasons: ['empirical_jobs_degraded'],
          required_repairs: ['refresh Torghut empirical proof'],
        }),
      ],
      clocks: [clock('torghut_capital', 'allow')],
    })

    const verdict = findVerdict(epoch, 'paper_canary')
    expect(verdict.decision).toBe('hold')
    expect(verdict.blocking_reason_codes).toContain('empirical_jobs_degraded')
    expect(verdict.contradiction_refs[0]).toContain('paper_canary:budget_hold:clock_allow')
  })

  it('fails live capital closed when stale empirical evidence blocks the SLO budget', () => {
    const epoch = build({
      budgets: [
        budget('live_micro_canary', 'block', {
          blocked_reasons: ['empirical_jobs_stale', 'quant_alerts_critical'],
          required_repairs: ['refresh Torghut empirical proof', 'resolve or supersede quant evidence debt'],
        }),
      ],
      clocks: [
        clock('torghut_capital', 'hold', {
          blocking_reason_codes: ['empirical_jobs_degraded'],
        }),
      ],
    })

    const verdict = findVerdict(epoch, 'live_micro_canary')
    expect(verdict).toMatchObject({
      decision: 'block',
      decision_rank: 5,
      max_notional: 0,
    })
    expect(verdict.blocking_reason_codes).toEqual(
      expect.arrayContaining(['empirical_jobs_stale', 'quant_alerts_critical']),
    )
  })

  it('keeps Torghut observe allowed while open repair warrants hold paper and block live capital', () => {
    const exchange = repairWarrantExchange()
    const epoch = build({
      budgets: [
        budget('torghut_observe', 'allow'),
        budget('paper_canary', 'allow'),
        budget('live_micro_canary', 'allow'),
      ],
      clocks: [clock('torghut_observe', 'allow'), clock('torghut_capital', 'allow')],
      repairWarrantExchange: exchange,
    })

    const observe = findVerdict(epoch, 'torghut_observe')
    expect(observe).toMatchObject({
      decision: 'allow',
      max_notional: 0,
    })
    expect(observe.evidence_refs).toEqual(expect.arrayContaining([exchange.exchange_id]))

    const paper = findVerdict(epoch, 'paper_canary')
    expect(paper).toMatchObject({
      decision: 'hold',
      max_dispatches: 0,
      max_runtime_seconds: 0,
      max_notional: 0,
    })
    expect(paper.blocking_reason_codes).toContain('repair_warrant_open')
    expect(paper.required_repair_actions).toContain('fresh execution TCA receipt inside the active observation epoch')

    const live = findVerdict(epoch, 'live_micro_canary')
    expect(live).toMatchObject({
      decision: 'block',
      decision_rank: 5,
      max_notional: 0,
    })
    expect(live.blocking_reason_codes).toContain('repair_warrant_open')
  })

  it('keeps dispatch repair in repair-only mode when the schedule debt firebreak is active', () => {
    const exchange = repairWarrantExchange({
      status: 'observe_only',
      schedule_debt_window: {
        ...repairWarrantExchange().schedule_debt_window,
        open_error_count: 4,
        success_count: 1,
        firebreak_state: 'observe_only',
      },
      active_warrants: [
        {
          ...repairWarrantExchange().active_warrants[0]!,
          admission_state: 'observe_only',
          max_dispatches: 0,
          max_runtime_seconds: 0,
          reason_codes: ['schedule_debt_firebreak_observe_only', 'execution_tca_stale'],
        },
      ],
    })
    const epoch = build({
      budgets: [budget('dispatch_repair', 'allow')],
      clocks: [clock('dispatch_repair', 'allow')],
      repairWarrantExchange: exchange,
    })

    const verdict = findVerdict(epoch, 'dispatch_repair')
    expect(verdict).toMatchObject({
      decision: 'repair_only',
      max_dispatches: 0,
      max_runtime_seconds: 0,
      max_notional: 0,
    })
    expect(verdict.downgrade_reason_codes).toEqual(
      expect.arrayContaining(['schedule_debt_firebreak_observe_only', 'execution_tca_stale']),
    )
  })

  it('applies admitted repair warrant caps when the repair budget is broader', () => {
    const exchange = repairWarrantExchange({
      active_warrants: [
        {
          ...repairWarrantExchange().active_warrants[0]!,
          max_dispatches: 1,
          max_runtime_seconds: 1200,
        },
      ],
    })
    const epoch = build({
      budgets: [
        budget('dispatch_repair', 'allow', {
          max_dispatches: 5,
          max_runtime_seconds: 3600,
        }),
      ],
      clocks: [clock('dispatch_repair', 'allow')],
      repairWarrantExchange: exchange,
    })

    const verdict = findVerdict(epoch, 'dispatch_repair')
    expect(verdict).toMatchObject({
      decision: 'allow',
      max_dispatches: 1,
      max_runtime_seconds: 1200,
      max_notional: 0,
    })
    expect(verdict.evidence_refs).toEqual(expect.arrayContaining([exchange.exchange_id]))
  })

  it('preserves allowed notional when source rollout truth is converged', () => {
    const epoch = build({
      budgets: [
        budget('paper_canary', 'allow', {
          max_notional: 25,
        }),
      ],
      clocks: [clock('torghut_capital', 'allow')],
      sourceRolloutTruthExchange: sourceRolloutTruthExchange('paper_canary'),
    })

    const verdict = findVerdict(epoch, 'paper_canary')
    expect(verdict).toMatchObject({
      decision: 'allow',
      max_notional: 25,
    })
    expect(verdict.evidence_refs).toEqual(
      expect.arrayContaining(['source-rollout-truth:test', 'source-rollout-truth-receipt:paper_canary:test']),
    )
  })
})
