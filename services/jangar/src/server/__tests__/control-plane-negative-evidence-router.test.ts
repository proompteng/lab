import { describe, expect, it } from 'vitest'

import type { ActionSloBudget } from '~/data/agents-control-plane'
import {
  buildNegativeEvidenceRouterStatus,
  NEGATIVE_EVIDENCE_ROUTER_DESIGN_ARTIFACT,
  type NegativeEvidenceRouterInput,
} from '~/server/control-plane-negative-evidence-router'

const now = new Date('2026-05-06T10:30:00.000Z')

type RouterInput = NegativeEvidenceRouterInput
type Holdback = RouterInput['failureDomainLeases']['holdbacks'][number]

const workflows = (overrides: Partial<RouterInput['workflows']> = {}): RouterInput['workflows'] =>
  ({
    window_minutes: 15,
    recent_failed_jobs: 0,
    backoff_limit_exceeded_jobs: 0,
    top_failure_reasons: [],
    data_confidence: 'high',
    ...overrides,
  }) as RouterInput['workflows']

const watchReliability = (
  overrides: Partial<RouterInput['watchReliability']> = {},
): RouterInput['watchReliability'] => ({
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 2,
  total_events: 10,
  total_errors: 0,
  total_restarts: 0,
  streams: [],
  ...overrides,
})

const holdback = (actionClass: Holdback['action_class'], decision: Holdback['decision'], reasonCodes: string[]) =>
  ({
    action_class: actionClass,
    decision,
    lease_ids: [`fdl:${actionClass}:test`],
    reason_codes: reasonCodes,
    message: `${actionClass} ${decision}`,
  }) as Holdback

const failureDomainLeases = (holdbacks: Holdback[] = []): RouterInput['failureDomainLeases'] =>
  ({
    mode: 'shadow',
    design_artifact:
      'docs/agents/designs/75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md',
    lease_set_digest: 'fdl-set:test',
    generated_at: now.toISOString(),
    leases: [
      {
        lease_id: 'fdl:route:test',
        domain: 'route',
        scope: 'jangar',
        status: 'valid',
        action_classes: ['serve_readonly', 'dispatch_normal'],
        observed_at: now.toISOString(),
        expires_at: '2026-05-06T10:31:00.000Z',
        evidence_refs: ['route:status_handler_reached'],
        reason_codes: [],
        rollback_target: null,
        issuer: 'status_projector',
      },
    ],
    holdbacks,
  }) as RouterInput['failureDomainLeases']

const baseInput = (overrides: Partial<RouterInput> = {}): RouterInput =>
  ({
    now,
    namespace: 'agents',
    service: 'jangar',
    workflows: workflows(),
    watchReliability: watchReliability(),
    agentRunIngestion: { namespace: 'agents', status: 'healthy' },
    database: {
      configured: true,
      connected: true,
      status: 'healthy',
      migration_consistency: {
        status: 'healthy',
        latest_registered: '20260505_torghut_quant_pipeline_health_window_index',
      },
    },
    rolloutHealth: { status: 'healthy' },
    dependencyQuorum: {
      decision: 'allow',
      reasons: [],
      message: 'Control-plane admission dependencies are healthy.',
    },
    failureDomainLeases: failureDomainLeases(),
    empiricalServices: {
      jobs: {
        status: 'healthy',
        endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
        stale_jobs: [],
      },
    },
    executionTrust: {
      status: 'healthy',
      evidence_summary: [],
      blocking_windows: [],
    },
    runtimeKits: [
      {
        runtime_kit_id: 'runtime-kit:serving:test',
        decision: 'healthy',
      },
      {
        runtime_kit_id: 'runtime-kit:collaboration:test',
        decision: 'healthy',
      },
    ],
    ...overrides,
  }) as RouterInput

const findBudget = (budgets: ActionSloBudget[], actionClass: ActionSloBudget['action_class']) => {
  const budget = budgets.find((entry) => entry.action_class === actionClass)
  expect(budget).toBeTruthy()
  return budget as ActionSloBudget
}

describe('negative evidence router', () => {
  it('keeps retained audit failures out of serving and repair admission', () => {
    const result = buildNegativeEvidenceRouterStatus(
      baseInput({
        retainedAuditFailureRefs: ['agentrun:agents:verify-old-failed'],
      }),
    )

    expect(result.router.design_artifact).toBe(NEGATIVE_EVIDENCE_ROUTER_DESIGN_ARTIFACT)
    expect(result.router.negative_evidence_refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'retained_audit_negative',
          reason: 'retained_historical_failures',
        }),
      ]),
    )
    expect(findBudget(result.budgets, 'serve_readonly').decision).toBe('allow')
    expect(findBudget(result.budgets, 'dispatch_repair').decision).toBe('allow')
  })

  it('reduces normal dispatch during current controller probe and workflow failure windows', () => {
    const result = buildNegativeEvidenceRouterStatus(
      baseInput({
        watchReliability: watchReliability({
          status: 'degraded',
          total_errors: 2,
          total_restarts: 1,
          streams: [
            {
              resource: 'agentruns',
              namespace: 'agents',
              events: 3,
              errors: 2,
              restarts: 1,
              last_seen_at: now.toISOString(),
            },
          ],
        }),
        workflows: workflows({
          recent_failed_jobs: 2,
          backoff_limit_exceeded_jobs: 1,
          top_failure_reasons: [{ reason: 'BackoffLimitExceeded', count: 1 }],
        }),
      }),
    )

    const normalDispatch = findBudget(result.budgets, 'dispatch_normal')
    expect(normalDispatch.decision).toBe('repair_only')
    expect(normalDispatch.downgrade_reasons).toEqual(
      expect.arrayContaining(['watch_reliability_degraded', 'workflow_recent_failures']),
    )
    expect(findBudget(result.budgets, 'dispatch_repair').decision).toBe('allow')
    expect(findBudget(result.budgets, 'serve_readonly').decision).toBe('allow')
  })

  it('blocks live capital on stale market context, open quant alerts, and Torghut readiness debt', () => {
    const result = buildNegativeEvidenceRouterStatus(
      baseInput({
        torghut: {
          readiness_status: 'degraded',
          readyz_status_code: 503,
          market_context_status: 'stale',
          market_context_stale_domains: ['technicals', 'news'],
          open_quant_alerts: 2,
          critical_quant_alerts: 1,
          paper_settlement_clean: true,
        },
      }),
    )

    const liveMicro = findBudget(result.budgets, 'live_micro_canary')
    expect(liveMicro.decision).toBe('block')
    expect(liveMicro.blocked_reasons).toEqual(
      expect.arrayContaining(['market_context_stale', 'quant_alerts_open', 'torghut_readiness_degraded']),
    )
    expect(findBudget(result.budgets, 'torghut_observe').decision).toBe('allow')
    expect(result.torghutBudgets.map((budget) => budget.action_class)).toEqual(
      expect.arrayContaining(['torghut_observe', 'paper_canary', 'live_micro_canary', 'live_scale']),
    )
  })

  it('uses current Torghut consumer evidence to replace the generic missing-evidence blocker', () => {
    const result = buildNegativeEvidenceRouterStatus(
      baseInput({
        torghut: {
          readiness_status: 'degraded',
          readyz_status_code: 503,
          market_context_status: 'healthy',
          open_quant_alerts: 0,
          critical_quant_alerts: 0,
          paper_settlement_clean: false,
          consumer_evidence_receipt_id: 'torghut-consumer-evidence:test',
          consumer_evidence_status: 'current',
          consumer_evidence_fresh_until: '2026-05-06T10:31:00.000Z',
          consumer_evidence_reason_codes: ['forecast_registry_degraded', 'execution_tca_route_universe_incomplete'],
          capital_reentry_cohort_ledger_id: 'capital-reentry-ledger:test',
          capital_reentry_aggregate_state: 'repair',
          capital_reentry_cohort_ids: ['capital-reentry-cohort:aapl'],
          capital_reentry_blocking_reason_codes: ['forecast_registry_degraded'],
          profit_repair_settlement_ledger_id: 'profit-repair-settlement-ledger:test',
          profit_repair_aggregate_state: 'repair',
          profit_repair_lot_ids: ['profit-repair-lot:quant'],
          profit_repair_blocking_reason_codes: ['quant_pipeline_degraded'],
          routeability_repair_acceptance_ledger_id: 'routeability-acceptance-ledger:test',
          routeability_aggregate_state: 'blocked',
          routeability_lot_ids: ['routeability-repair-lot:submit'],
          routeability_blocking_reason_codes: ['proof_floor_repair_only', 'simple_submit_disabled'],
          accepted_routeable_candidate_count: 0,
          profit_freshness_frontier_id: 'profit-freshness-frontier:test',
          profit_freshness_state: 'repair_only',
          profit_freshness_repair_lot_ids: ['profit-freshness-repair-lot:market'],
          profit_freshness_selected_repair_ids: ['profit-freshness-repair-lot:market'],
          profit_freshness_blocking_reason_codes: ['market_context_news_stale'],
        },
      }),
    )

    const paperCanary = findBudget(result.budgets, 'paper_canary')
    const liveMicro = findBudget(result.budgets, 'live_micro_canary')
    expect(result.router.positive_evidence_refs).toContain('torghut-consumer-evidence:test')
    expect(paperCanary.decision).toBe('hold')
    expect(paperCanary.blocked_reasons).toEqual(
      expect.arrayContaining([
        'forecast_registry_degraded',
        'execution_tca_route_universe_incomplete',
        'capital_reentry_repair',
        'profit_repair_repair',
        'routeability_acceptance_blocked',
        'profit_freshness_repair_only',
        'quant_pipeline_degraded',
        'market_context_news_stale',
        'proof_floor_repair_only',
        'simple_submit_disabled',
      ]),
    )
    expect(paperCanary.evidence_refs).toEqual(
      expect.arrayContaining([
        'torghut-consumer-evidence:test',
        'capital-reentry-ledger:test',
        'capital-reentry-cohort:aapl',
        'profit-repair-settlement-ledger:test',
        'profit-repair-lot:quant',
        'routeability-acceptance-ledger:test',
        'routeability-repair-lot:submit',
        'profit-freshness-frontier:test',
        'profit-freshness-repair-lot:market',
      ]),
    )
    expect(paperCanary.blocked_reasons).not.toContain('torghut_consumer_evidence_missing')
    expect(liveMicro.decision).toBe('block')
    expect(liveMicro.blocked_reasons).toEqual(
      expect.arrayContaining([
        'forecast_registry_degraded',
        'execution_tca_route_universe_incomplete',
        'capital_reentry_repair',
        'profit_repair_repair',
        'routeability_acceptance_blocked',
        'profit_freshness_repair_only',
        'quant_pipeline_degraded',
        'market_context_news_stale',
        'proof_floor_repair_only',
        'simple_submit_disabled',
      ]),
    )
  })

  it('holds deploy widening on rollout ambiguity without blocking read-only service', () => {
    const result = buildNegativeEvidenceRouterStatus(
      baseInput({
        failureDomainLeases: failureDomainLeases([
          holdback('deploy_widen', 'hold', ['rollout_ambiguity.duplicate_pdb_matches']),
        ]),
        torghut: {
          readiness_status: 'healthy',
          market_context_status: 'healthy',
          open_quant_alerts: 0,
          critical_quant_alerts: 0,
          rollout_ambiguity_refs: ['event:torghut:duplicate-clickhouse-pdb'],
          paper_settlement_clean: true,
        },
      }),
    )

    const deployWiden = findBudget(result.budgets, 'deploy_widen')
    expect(deployWiden.decision).toBe('hold')
    expect(deployWiden.blocked_reasons).toEqual(
      expect.arrayContaining(['failure_domain_deploy_widen_holdback', 'rollout_ambiguity']),
    )
    expect(findBudget(result.budgets, 'serve_readonly').decision).toBe('allow')
  })

  it('uses Torghut evidence-clock custody to hold normal dispatch and deploy widening', () => {
    const result = buildNegativeEvidenceRouterStatus(
      baseInput({
        torghut: {
          readiness_status: 'healthy',
          market_context_status: 'healthy',
          open_quant_alerts: 0,
          critical_quant_alerts: 0,
          paper_settlement_clean: false,
          consumer_evidence_receipt_id: 'torghut-route-proven-profit:test',
          consumer_evidence_status: 'current',
          evidence_clock_arbiter_id: 'evidence-clock-arbiter:test',
          evidence_clock_status: 'split',
          evidence_clock_split_clock_names: ['rollout', 'postgres_tca'],
          evidence_clock_blocking_reason_codes: ['route_adjacent_workloads_degraded', 'execution_tca_stale'],
          evidence_clock_custody_status: 'missing',
          evidence_clock_custody_ref: null,
          evidence_clock_custody_reason_codes: ['evidence_clock_custody_receipt_missing'],
          routeable_profit_candidate_exchange_id: 'routeable-profit-candidate-exchange:test',
          routeable_exchange_zero_notional_repair_lot_ids: ['evidence-clock-repair-lot:rollout'],
          routeable_exchange_routeable_candidate_count: 0,
          routeable_exchange_rejected_candidate_count: 1,
        },
      }),
    )

    const normalDispatch = findBudget(result.budgets, 'dispatch_normal')
    expect(normalDispatch.decision).toBe('repair_only')
    expect(normalDispatch.downgrade_reasons).toEqual(['evidence_clock_custody_missing'])
    expect(normalDispatch.evidence_refs).toEqual(
      expect.arrayContaining([
        'evidence-clock-arbiter:test',
        'routeable-profit-candidate-exchange:test',
        'evidence-clock-repair-lot:rollout',
      ]),
    )

    const deployWiden = findBudget(result.budgets, 'deploy_widen')
    expect(deployWiden.decision).toBe('hold')
    expect(deployWiden.blocked_reasons).toEqual(
      expect.arrayContaining([
        'evidence_clock_custody_missing',
        'evidence_clock_custody_receipt_missing',
        'evidence_clock_rollout_split',
      ]),
    )

    const paperCanary = findBudget(result.budgets, 'paper_canary')
    expect(paperCanary.decision).toBe('hold')
    expect(paperCanary.blocked_reasons).toEqual(
      expect.arrayContaining([
        'evidence_clock_split',
        'route_adjacent_workloads_degraded',
        'execution_tca_stale',
        'evidence_clock_custody_missing',
      ]),
    )
    expect(findBudget(result.budgets, 'dispatch_repair').decision).toBe('allow')
    expect(findBudget(result.budgets, 'serve_readonly').decision).toBe('allow')
  })
})
