import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchPrimitiveList, normalizeControlPlaneStatusPayload } from './agents-control-plane'

const originalFetch = globalThis.fetch

const genericAgentsStatusPayload = {
  service: 'agents',
  generated_at: '2026-05-19T12:00:00.000Z',
  controllers: [],
  runtime_adapters: [],
  database: {
    configured: false,
    connected: false,
    status: 'disabled',
    message: '',
    latency_ms: 0,
    migration_consistency: {
      status: 'unknown',
      migration_table: null,
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
    message: '',
  },
  watch_reliability: {
    status: 'unknown',
    window_minutes: 0,
    observed_streams: 0,
    total_events: 0,
    total_errors: 0,
    total_restarts: 0,
    streams: [],
  },
  agentrun_ingestion: {
    namespace: 'agents',
    status: 'healthy',
    message: '',
    last_watch_event_at: null,
    last_resync_at: null,
    untouched_run_count: 0,
    oldest_untouched_age_seconds: null,
  },
  workflows: {
    active_job_runs: 0,
    recent_failed_jobs: 0,
    backoff_limit_exceeded_jobs: 0,
    window_minutes: 0,
    top_failure_reasons: [],
    data_confidence: 'unknown',
    collection_errors: 0,
    collected_namespaces: 0,
    target_namespaces: 1,
    message: '',
  },
  rollout_health: {
    status: 'unknown',
    observed_deployments: 0,
    degraded_deployments: 0,
    deployments: [],
    message: '',
  },
  namespaces: [{ namespace: 'agents', status: 'healthy', degraded_components: [] }],
} satisfies Record<string, unknown>

describe('normalizeControlPlaneStatusPayload', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('backfills Jangar-owned domain status defaults for generic Agents status payloads', () => {
    const status = normalizeControlPlaneStatusPayload(genericAgentsStatusPayload, 'agents')

    expect(status.dependency_quorum.decision).toBe('unknown')
    expect(status.dependency_quorum.message).toBe('not emitted by generic Agents control-plane status')
    expect(status.failure_domain_leases.leases).toEqual([])
    expect(status.material_action_verdict_epoch.namespace).toBe('agents')
    expect(status.material_action_verdicts).toEqual([])
    expect(status.authority_provenance_settlement.winning_authority).toBe('none')
    expect(status.evidence_pressure_ledger).toBeNull()
    expect(status.terminal_debt_compaction_ledger).toBeNull()
    expect(status.empirical_services.forecast.authoritative).toBe(false)
    expect(status.rollout_health.message).toBe('')
  })

  it('uses canonical Agents control-plane paths for browser resource list reads', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, items: [], total: 0, namespace: 'agents' }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await fetchPrimitiveList({ kind: 'AgentRun', namespace: 'agents', limit: 50 })

    expect(result).toEqual({ ok: true, items: [], total: 0, kind: 'AgentRun', namespace: 'agents' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://agents.k8s.proompteng.ai/api/agents/control-plane/resources?kind=AgentRun&namespace=agents&limit=50',
      {
        signal: undefined,
      },
    )
  })

  it('preserves legacy status fields while filling missing members', () => {
    const status = normalizeControlPlaneStatusPayload(
      {
        ...genericAgentsStatusPayload,
        dependency_quorum: { message: 'legacy projector value' },
        authority_provenance_settlement: { winning_authority: 'operator' },
      },
      'agents',
    )

    expect(status.dependency_quorum.decision).toBe('unknown')
    expect(status.dependency_quorum.message).toBe('legacy projector value')
    expect(status.authority_provenance_settlement.settlement_id).toBe('generic-agents-status')
    expect(status.authority_provenance_settlement.winning_authority).toBe('operator')
  })
})
