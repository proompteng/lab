import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildAgentsReadySnapshot, getAgentsControlPlaneStatusSnapshot, getAgentsReadySnapshot } from './agents-ready'
import { AGENTS_CONTROLLER_WITNESS_DESIGN_ARTIFACT } from './control-plane-status'

const originalFetch = globalThis.fetch

describe('agents-ready', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('keeps a degraded Agents /ready payload authoritative when HTTP status is 503', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          schemaVersion: 'agents.proompteng.ai/ready/v1',
          status: 'degraded',
          service: 'agents',
          httpReady: false,
          reason_codes: ['leader_election_not_ready'],
          namespaces: ['agents'],
          agentrun_ingestion: [
            {
              namespace: 'agents',
              status: 'degraded',
              message: 'controller is adopting backlog',
              last_watch_event_at: null,
              last_resync_at: '2026-03-08T21:00:00Z',
              untouched_run_count: 2,
              oldest_untouched_age_seconds: 60,
            },
          ],
          leaderElection: {
            required: true,
            isLeader: false,
            lastAttemptAt: null,
            lastError: 'lease watch failed',
          },
          agentsController: {
            enabled: true,
            started: false,
            namespaces: ['agents'],
            crdsReady: true,
            missingCrds: [],
            lastCheckedAt: '2026-03-08T21:00:00Z',
            agentRunIngestion: [],
          },
        }),
        {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'content-type': 'application/json' },
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const snapshot = await getAgentsReadySnapshot()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(snapshot).toMatchObject({
      available: true,
      httpStatus: 503,
      status: 'degraded',
      httpReady: false,
      reasonCodes: ['leader_election_not_ready'],
      agentRunIngestion: [
        {
          namespace: 'agents',
          status: 'degraded',
          message: 'controller is adopting backlog',
          last_resync_at: '2026-03-08T21:00:00Z',
          untouched_run_count: 2,
          oldest_untouched_age_seconds: 60,
        },
      ],
      leaderElection: {
        lastError: 'lease watch failed',
      },
    })

    expect(snapshot.raw).toMatchObject({
      status: 'degraded',
      reason_codes: ['leader_election_not_ready'],
    })
  })

  it('builds a degraded fallback snapshot when Agents /ready is unavailable', () => {
    const snapshot = buildAgentsReadySnapshot({
      payload: null,
      httpStatus: 0,
      error: 'connect ECONNREFUSED',
    })

    expect(snapshot).toMatchObject({
      available: false,
      status: 'degraded',
      httpReady: false,
      error: 'connect ECONNREFUSED',
      agentsController: {
        enabled: true,
        started: false,
        crdsReady: false,
      },
      agentRunIngestion: [
        {
          namespace: 'agents',
          status: 'unknown',
          message: 'Agents service did not report AgentRun ingestion status',
        },
      ],
    })
  })

  it('fetches Agents-owned control-plane status by namespace', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          service: 'agents',
          generated_at: '2026-03-08T21:00:00Z',
          leader_election: {
            enabled: true,
            required: true,
            is_leader: true,
            lease_name: 'agents-controller',
            lease_namespace: 'agents',
            identity: 'agents-1',
            last_transition_at: '',
            last_attempt_at: '',
            last_success_at: '',
            last_error: '',
          },
          controllers: [],
          runtime_adapters: [],
          database: {
            configured: false,
            connected: false,
            status: 'disabled',
            message: 'disabled',
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
              message: 'unknown',
            },
          },
          grpc: { enabled: false, address: '', status: 'disabled', message: 'disabled' },
          watch_reliability: {
            status: 'healthy',
            window_minutes: 15,
            observed_streams: 1,
            total_events: 2,
            total_errors: 0,
            total_restarts: 0,
            streams: [],
          },
          agentrun_ingestion: {
            namespace: 'agents',
            status: 'healthy',
            message: 'healthy',
            last_watch_event_at: '2026-03-08T21:00:00Z',
            last_resync_at: '2026-03-08T21:00:00Z',
            untouched_run_count: 0,
            oldest_untouched_age_seconds: null,
          },
          control_plane_controller_witness: {
            mode: 'shadow',
            design_artifact: AGENTS_CONTROLLER_WITNESS_DESIGN_ARTIFACT,
            quorum_id: 'controller-witness:agents:agents-control-plane-status',
            generated_at: '2026-03-08T21:00:00Z',
            expires_at: '2026-03-08T21:01:00Z',
            namespace: 'agents',
            decision: 'allow',
            reason_codes: [],
            message: 'healthy',
            witness_refs: [],
            deployment_available: true,
            watch_epoch_current: true,
            controller_self_report_current: true,
            witnesses: [],
            rollback_target: null,
          },
          runtime_kits: [],
          admission_passports: [],
          serving_passport_id: null,
          recovery_warrants: [],
          runtime_proof_cells: [],
          projection_watermarks: [],
          workflows: {
            active_job_runs: 0,
            recent_failed_jobs: 0,
            backoff_limit_exceeded_jobs: 0,
            window_minutes: 60,
            top_failure_reasons: [],
            data_confidence: 'high',
            collection_errors: 0,
            collected_namespaces: 1,
            target_namespaces: 1,
            message: 'healthy',
          },
          rollout_health: {
            status: 'healthy',
            observed_deployments: 2,
            degraded_deployments: 0,
            deployments: [],
            message: 'healthy',
          },
          namespaces: [{ namespace: 'agents', status: 'healthy', degraded_components: [] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const snapshot = await getAgentsControlPlaneStatusSnapshot('agents')

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/api/agents/control-plane/status?namespace=agents', 'http://agents.agents.svc.cluster.local/'),
      expect.any(Object),
    )
    expect(snapshot).toMatchObject({
      available: true,
      httpStatus: 200,
      status: {
        service: 'agents',
        agentrun_ingestion: { namespace: 'agents', status: 'healthy' },
        control_plane_controller_witness: {
          quorum_id: 'controller-witness:agents:agents-control-plane-status',
        },
      },
    })
  })
})
