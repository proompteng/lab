// @vitest-environment jsdom
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ControlPlaneStatus } from '@/data/agents-control-plane'
import { ControlPlaneStatusPanel } from '@/components/agents-control-plane-status'

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
      crds_ready: true,
      missing_crds: [],
      last_checked_at: '2026-01-20T00:00:00Z',
      status: 'healthy',
      message: '',
    },
  ],
  runtime_adapters: [],
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
  rollout_health: {
    status: 'healthy',
    observed_deployments: 0,
    degraded_deployments: 0,
    deployments: [],
    message: 'healthy',
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
    expect(normalizedHtml).not.toContain('Top failure reasons: [object Object], [object Object]')
  })
})
