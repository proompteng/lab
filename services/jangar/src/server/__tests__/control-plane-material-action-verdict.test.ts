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
  })

const findVerdict = (epoch: ReturnType<typeof build>, actionClass: ActionSloBudgetActionClass) => {
  const verdict = epoch.final_verdicts.find((entry) => entry.action_class === actionClass)
  expect(verdict).toBeTruthy()
  return verdict!
}

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
})
