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

const baseStatus: ControlPlaneStatus = {
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
      endpoint: 'http://torghut-forecast.torghut.svc.cluster.local:8089/readyz',
      message: 'forecast service ready',
      authoritative: true,
      calibration_status: 'ready',
      eligible_models: ['chronos', 'moment'],
    },
    lean: {
      status: 'healthy',
      endpoint: 'http://torghut-lean-runner.torghut.svc.cluster.local:8088/readyz',
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
}

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
