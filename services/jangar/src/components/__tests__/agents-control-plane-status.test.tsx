// @vitest-environment jsdom
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ControlPlaneStatus } from '@/data/agents-control-plane'
import { ControlPlaneStatusPanel } from '@/components/agents-control-plane-status'

const localAuthority = {
  mode: 'local' as const,
  namespace: 'agents',
  source_deployment: 'agents-web',
  source_pod: 'agents-web-0',
  observed_at: '2026-01-20T00:00:00Z',
  fresh: true,
  message: 'using local controller state',
}

const dispatchNormalVerdict = {
  verdict_id: 'material-action-verdict:dispatch_normal:test',
  epoch_id: 'material-action-verdict:test',
  action_class: 'dispatch_normal' as const,
  decision: 'hold' as const,
  decision_rank: 3,
  confidence: 'high' as const,
  allowed_until: '2026-01-20T00:01:00Z',
  max_dispatches: 0,
  max_runtime_seconds: 0,
  max_notional: 0,
  blocking_reason_codes: ['workflow_artifact.configmap_missing'],
  downgrade_reason_codes: [],
  required_repair_actions: ['recreate missing workflow input ConfigMap or rerun affected stage'],
  rollback_target: 'recreate missing workflow input ConfigMap or rerun affected stage',
  evidence_refs: [],
  contradiction_refs: [],
}

const baseStatus = {
  service: 'jangar',
  generated_at: '2026-01-20T00:00:00Z',
  leader_election: {
    enabled: true,
    required: true,
    is_leader: true,
    lease_name: 'jangar-controller-leader',
    lease_namespace: 'agents',
    identity: 'agent-runner',
    last_transition_at: '2026-01-20T00:00:00Z',
    last_attempt_at: '2026-01-20T00:00:00Z',
    last_success_at: '2026-01-20T00:00:00Z',
    last_error: '',
  },
  controllers: [
    {
      name: 'agents-controller',
      enabled: true,
      started: true,
      scope_namespaces: ['agents'],
      crds_ready: true,
      missing_crds: [],
      last_checked_at: '2026-01-20T00:00:00Z',
      status: 'healthy',
      message: '',
      authority: localAuthority,
    },
  ],
  runtime_adapters: [
    {
      name: 'workflow',
      available: true,
      status: 'configured',
      message: 'native workflow runtime via Kubernetes Jobs',
      endpoint: '',
      authority: localAuthority,
    },
  ],
  workflows: {
    window_minutes: 15,
    active_job_runs: 1,
    recent_failed_jobs: 2,
    backoff_limit_exceeded_jobs: 1,
    data_confidence: 'high',
    collection_errors: 0,
    collected_namespaces: 1,
    target_namespaces: 1,
    message: '',
    top_failure_reasons: [
      { reason: 'BackoffLimitExceeded', count: 2 },
      { reason: 'ImagePullBackOff', count: 1 },
    ],
  },
  dependency_quorum: {
    decision: 'delay',
    reasons: ['workflow_backoff_warning'],
    message: 'Control-plane dependency quorum is degraded; delay capital promotion.',
  },
  failure_domain_leases: {
    mode: 'shadow',
    design_artifact:
      'docs/agents/designs/75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md',
    lease_set_digest: 'fdl-set:test',
    generated_at: '2026-01-20T00:00:00Z',
    leases: [
      {
        lease_id: 'fdl:database:test',
        domain: 'database',
        scope: 'jangar',
        status: 'valid',
        action_classes: ['dispatch_normal', 'deploy_widen'],
        observed_at: '2026-01-20T00:00:00Z',
        expires_at: '2026-01-20T00:01:00Z',
        evidence_refs: ['database:probe:select_1'],
        reason_codes: [],
        rollback_target: null,
        issuer: 'status_projector',
      },
      {
        lease_id: 'fdl:workflow_artifact:test',
        domain: 'workflow_artifact',
        scope: 'agents',
        status: 'expired',
        action_classes: ['dispatch_normal'],
        observed_at: '2026-01-20T00:00:00Z',
        expires_at: '2026-01-20T00:00:00Z',
        evidence_refs: ['event:agents:missing-configmap'],
        reason_codes: ['workflow_artifact.configmap_missing'],
        rollback_target: 'recreate missing workflow input ConfigMap or rerun affected stage',
        issuer: 'status_projector',
      },
    ],
    holdbacks: [
      {
        action_class: 'dispatch_normal',
        decision: 'hold',
        lease_ids: ['fdl:workflow_artifact:test'],
        reason_codes: ['workflow_artifact.configmap_missing'],
        message: 'dispatch_normal is held by workflow_artifact.configmap_missing.',
      },
      {
        action_class: 'dispatch_repair',
        decision: 'allow',
        lease_ids: [],
        reason_codes: [],
        message: 'dispatch_repair is allowed by shadow failure-domain leases.',
      },
    ],
  },
  negative_evidence_router: {
    mode: 'observe',
    design_artifact: 'docs/agents/designs/111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md',
    router_epoch_id: 'ner:test',
    generated_at: '2026-01-20T00:00:00Z',
    evidence_window_minutes: 15,
    positive_evidence_refs: [],
    negative_evidence_refs: [],
    contradiction_refs: [],
    source_schema_ref: null,
    database_projection_ref: null,
    gitops_convergence_ref: null,
    failure_domain_lease_refs: [],
    consumer_refs: [],
  },
  action_slo_budgets: [],
  torghut_action_slo_budgets: [],
  material_action_verdict_epoch: {
    mode: 'shadow',
    design_artifact:
      'docs/agents/designs/120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md',
    epoch_id: 'material-action-verdict:test',
    generated_at: '2026-01-20T00:00:00Z',
    expires_at: '2026-01-20T00:01:00Z',
    namespace: 'agents',
    producer_revision: '2026-05-06-material-action-verdict-shadow-v1',
    dependency_quorum_ref: 'dependency_quorum:delay:workflow_backoff_warning',
    negative_evidence_router_epoch_ref: 'ner:test',
    action_slo_budget_refs: [],
    action_clock_refs: [],
    rollout_health_ref: 'rollout:healthy:0:0',
    controller_witness_ref: 'controller-witness:test',
    watch_reliability_ref: 'watch:healthy:0:0:0',
    database_projection_ref: 'database:healthy:healthy',
    empirical_services_ref: 'empirical:forecast=healthy:lean=healthy:jobs=healthy',
    torghut_capital_ref: null,
    contradiction_refs: [],
    final_verdicts: [dispatchNormalVerdict],
  },
  material_action_verdicts: [dispatchNormalVerdict],
  database: {
    configured: true,
    connected: true,
    status: 'healthy',
    message: 'ok',
    latency_ms: 3,
    migration_consistency: {
      status: 'healthy',
      migration_table: 'kysely_migration',
      registered_count: 0,
      applied_count: 0,
      unapplied_count: 0,
      unexpected_count: 0,
      latest_registered: null,
      latest_applied: null,
      missing_migrations: [],
      unexpected_migrations: [],
      message: '',
    },
  },
  grpc: {
    enabled: false,
    address: '',
    status: 'disabled',
    message: 'disabled',
  },
  watch_reliability: {
    status: 'healthy',
    window_minutes: 15,
    observed_streams: 0,
    total_events: 0,
    total_errors: 0,
    total_restarts: 0,
    streams: [],
  },
  agentrun_ingestion: {
    namespace: 'agents',
    status: 'healthy',
    message: 'AgentRun ingestion healthy',
    last_watch_event_at: '2026-01-20T00:00:00Z',
    last_resync_at: '2026-01-20T00:00:00Z',
    untouched_run_count: 0,
    oldest_untouched_age_seconds: null,
  },
  runtime_kits: [],
  admission_passports: [],
  serving_passport_id: null,
  rollout_health: {
    status: 'healthy',
    observed_deployments: 0,
    degraded_deployments: 0,
    deployments: [],
    message: 'healthy',
  },
  execution_trust: {
    status: 'healthy',
    reason: 'execution trust is healthy.',
    last_evaluated_at: '2026-01-20T00:00:00Z',
    blocking_windows: [],
    evidence_summary: [],
  },
  swarms: [],
  stages: [],
  empirical_services: {
    forecast: {
      status: 'healthy',
      endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
      message: 'forecast service ready',
      authoritative: true,
      calibration_status: 'ready',
      eligible_models: ['chronos', 'moment'],
    },
    lean: {
      status: 'healthy',
      endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
      message: 'LEAN runner ready',
      authoritative: true,
      authoritative_modes: ['research_backtest', 'shadow_replay'],
    },
    jobs: {
      status: 'healthy',
      endpoint: 'http://torghut.torghut.svc.cluster.local/trading/empirical-jobs',
      message: 'empirical jobs fresh',
      authoritative: true,
      eligible_jobs: ['benchmark_parity', 'foundation_router_parity'],
      stale_jobs: [],
    },
  },
  namespaces: [
    {
      namespace: 'agents',
      status: 'healthy',
      degraded_components: [],
    },
  ],
} as unknown as ControlPlaneStatus

describe('ControlPlaneStatusPanel', () => {
  it('renders workflow failure reasons as reason/count pairs', () => {
    const html = renderToString(<ControlPlaneStatusPanel status={baseStatus} error={null} isLoading={false} />)
    const normalizedHtml = html.replace(/<!-- -->/g, '')

    expect(normalizedHtml).toContain('Top failure reasons: BackoffLimitExceeded (2), ImagePullBackOff (1)')
    expect(normalizedHtml).toContain('Data confidence: high')
    expect(normalizedHtml).toContain('Eligible models: chronos, moment')
    expect(normalizedHtml).toContain('Eligible jobs: benchmark_parity, foundation_router_parity')
    expect(normalizedHtml).toContain('Modes: research_backtest, shadow_replay')
    expect(normalizedHtml).toContain('Authority: local')
    expect(normalizedHtml).toContain('Scope: agents')
    expect(normalizedHtml).toContain('Failure-domain leases')
    expect(normalizedHtml).toContain('Held actions: dispatch_normal')
    expect(normalizedHtml).toContain('workflow_artifact.configmap_missing')
    expect(normalizedHtml).toContain('Material action verdicts')
    expect(normalizedHtml).toContain('Blocking verdicts: dispatch_normal=hold')
    expect(normalizedHtml).not.toContain('Top failure reasons: [object Object], [object Object]')
    expect(normalizedHtml).toContain('No segment detail available.')
  })

  it('renders scoped dependency quorum segments when present', () => {
    const status: ControlPlaneStatus = {
      ...baseStatus,
      dependency_quorum: {
        ...baseStatus.dependency_quorum,
        decision: 'delay',
        reasons: ['watch_reliability_degraded'],
        message: 'Control-plane dependency quorum is degraded; delay capital promotion.',
        degradation_scope: 'single_capability',
        segments: [
          {
            segment: 'watch_stream',
            status: 'degraded',
            scope: 'single_capability',
            confidence: 'medium',
            reasons: ['watch_reliability_degraded'],
            as_of: '2026-01-20T00:20:00.000Z',
          },
        ],
      },
    }

    const html = renderToString(<ControlPlaneStatusPanel status={status} error={null} isLoading={false} />)
    const normalizedHtml = html.replace(/<!-- -->/g, '')

    expect(normalizedHtml).toContain('Degradation scope: Single Capability')
    expect(normalizedHtml).toContain('watch_stream')
    expect(normalizedHtml).toContain('degraded')
    expect(normalizedHtml).toContain('scope Single Capability')
    expect(normalizedHtml).toContain('confidence medium')
  })
})
