import { describe, expect, it } from 'vitest'

import type {
  ControlPlaneControllerWitnessQuorum,
  TorghutConsumerEvidenceStatus,
} from '~/server/control-plane-status-types'
import {
  buildEvidencePressureLedger,
  EVIDENCE_PRESSURE_LEDGER_DESIGN_ARTIFACT,
} from '~/server/control-plane-evidence-pressure-ledger'
import type {
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

const now = new Date('2026-05-13T12:00:00.000Z')

const healthyWatch: ControlPlaneWatchReliability = {
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 1,
  total_events: 12,
  total_errors: 0,
  total_restarts: 0,
  streams: [
    {
      resource: 'agentruns.agents.proompteng.ai',
      namespace: 'agents',
      events: 12,
      errors: 0,
      restarts: 0,
      last_seen_at: now.toISOString(),
    },
  ],
}

const rateLimitedWatch: ControlPlaneWatchReliability = {
  status: 'degraded',
  window_minutes: 15,
  observed_streams: 1,
  total_events: 2,
  total_errors: 3,
  total_restarts: 2,
  streams: [
    {
      resource: 'agentruns.agents.proompteng.ai',
      namespace: 'agents',
      events: 2,
      errors: 3,
      restarts: 2,
      last_seen_at: now.toISOString(),
      error_reasons: {
        watch_rate_limited: 3,
      },
      restart_reasons: {
        watch_rate_limited: 2,
      },
    },
  ],
}

const database = (overrides: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
  configured: true,
  connected: true,
  status: 'healthy',
  message: 'database healthy',
  latency_ms: 3,
  migration_consistency: {
    status: 'healthy',
    migration_table: 'kysely_migration',
    registered_count: 30,
    applied_count: 30,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260513_evidence_pressure',
    latest_applied: '20260513_evidence_pressure',
    missing_migrations: [],
    unexpected_migrations: [],
    message: 'migrations consistent',
  },
  ...overrides,
})

const rolloutHealth = (overrides: Partial<ControlPlaneRolloutHealth> = {}): ControlPlaneRolloutHealth => ({
  status: 'healthy',
  observed_deployments: 2,
  degraded_deployments: 0,
  deployments: [],
  message: 'rollout healthy',
  ...overrides,
})

const controllerWitness = (
  overrides: Partial<ControlPlaneControllerWitnessQuorum> = {},
): ControlPlaneControllerWitnessQuorum => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
  quorum_id: 'controller-witness:healthy',
  generated_at: now.toISOString(),
  expires_at: '2026-05-13T12:01:00.000Z',
  namespace: 'agents',
  decision: 'allow',
  reason_codes: [],
  message: 'controller witnesses agree',
  witness_refs: ['witness:controller-process'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [],
  rollback_target: null,
  ...overrides,
})

const torghutEvidence = (overrides: Partial<TorghutConsumerEvidenceStatus> = {}): TorghutConsumerEvidenceStatus => ({
  status: 'current',
  endpoint: 'http://torghut/trading/consumer-evidence',
  receipt_id: 'torghut-consumer-evidence:current',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:05:00.000Z',
  candidate_id: null,
  dataset_snapshot_ref: null,
  max_notional: '0',
  repair_bid_settlement_ledger_id: 'repair-bid-settlement:current',
  repair_bid_settlement_dispatchable_lot_ids: ['repair-lot:watch-pressure'],
  reason_codes: [],
  message: 'current zero-notional repair evidence',
  ...overrides,
})

const buildLedger = (overrides: Partial<Parameters<typeof buildEvidencePressureLedger>[0]> = {}) =>
  buildEvidencePressureLedger({
    now,
    namespace: 'agents',
    sourceHeadSha: 'source-sha',
    gitopsRevision: 'gitops-sha',
    watchReliability: healthyWatch,
    controllerWitness: controllerWitness(),
    rolloutHealth: rolloutHealth(),
    database: database(),
    metricsSink: {
      status: 'healthy',
      endpoint: 'http://mimir/otlp/v1/metrics',
      message: 'metrics sink configured',
      reason_codes: [],
    },
    githubIngest: {
      status: 'healthy',
      active_missing_ref_suppressions: 0,
      reason_codes: [],
      message: 'github ingest healthy',
      evidence_refs: [],
    },
    torghutConsumerEvidence: torghutEvidence(),
    ...overrides,
  })

const budget = (ledger: ReturnType<typeof buildLedger>, actionClass: string) =>
  ledger.action_pressure_budget.find((entry) => entry.action_class === actionClass)

describe('control-plane evidence pressure ledger', () => {
  it('holds normal dispatch on Kubernetes watch rate limiting while preserving read-only and bounded repair', () => {
    const ledger = buildLedger({
      watchReliability: rateLimitedWatch,
    })

    expect(ledger).toMatchObject({
      schema_version: 'jangar.evidence-pressure-ledger.v1',
      evidence_mode: 'observe',
      governing_design_refs: expect.arrayContaining([EVIDENCE_PRESSURE_LEDGER_DESIGN_ARTIFACT]),
      watch_backoff_policy: {
        state: 'brownout',
        max_new_agent_runs_per_stage: 0,
        retry_after_seconds: 300,
      },
    })
    expect(ledger.pressure_sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_class: 'kubernetes_watch',
          severity: 'hold',
          reason_codes: expect.arrayContaining(['kubernetes_watch_rate_limited']),
        }),
      ]),
    )
    expect(budget(ledger, 'serve_readonly')).toMatchObject({ decision: 'allow' })
    expect(budget(ledger, 'dispatch_repair')).toMatchObject({
      decision: 'repair_only',
      max_dispatches: 1,
      required_repair_receipts: expect.arrayContaining(['repair-lot:watch-pressure']),
    })
    expect(budget(ledger, 'dispatch_normal')).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['kubernetes_watch_rate_limited']),
    })
    expect(budget(ledger, 'merge_ready')).toMatchObject({ decision: 'hold' })
  })

  it('prices controller replica split and metrics sink failure as rollout proof pressure', () => {
    const ledger = buildLedger({
      controllerWitness: controllerWitness({
        decision: 'repair_only',
        reason_codes: ['controller_witness_split'],
        message: 'controller deployment is available but self-report is missing',
      }),
      metricsSink: {
        status: 'degraded',
        endpoint: 'http://mimir/otlp/v1/metrics',
        message: 'metrics export connection refused',
        reason_codes: ['metrics_sink_connection_refused'],
      },
    })

    expect(ledger.pressure_sources.map((source) => `${source.source_class}:${source.severity}`)).toEqual(
      expect.arrayContaining(['controller_replica:hold', 'metrics_sink:hold']),
    )
    expect(budget(ledger, 'deploy_widen')).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['controller_witness_repair_only', 'metrics_sink_connection_refused']),
    })
    expect(ledger.deployer_handoff).toMatchObject({
      status: 'hold',
      held_action_classes: expect.arrayContaining(['deploy_widen', 'merge_ready']),
    })
  })

  it('classifies missing GitHub refs as terminal evidence instead of holding dispatch', () => {
    const ledger = buildLedger({
      githubIngest: {
        status: 'degraded',
        active_missing_ref_suppressions: 2,
        reason_codes: ['github_missing_ref_suppressed'],
        message: '2 worktree refresh failures are suppressed after missing refs',
        evidence_refs: ['github-worktree-refresh:pr-1', 'github-worktree-refresh:pr-2'],
      },
    })

    expect(ledger.pressure_sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_class: 'github_ingest',
          severity: 'info',
          terminal: true,
          retryable: false,
        }),
      ]),
    )
    expect(ledger.watch_backoff_policy.stop_retry_reason_codes).toEqual(
      expect.arrayContaining(['github_missing_ref_suppressed']),
    )
    expect(budget(ledger, 'dispatch_normal')).toMatchObject({ decision: 'allow' })
  })

  it('blocks material action when database proof access is unavailable', () => {
    const ledger = buildLedger({
      database: database({
        connected: false,
        status: 'degraded',
        message: 'database connection refused',
      }),
    })

    expect(ledger.pressure_sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_class: 'db_access',
          severity: 'block',
          reason_codes: expect.arrayContaining(['database_degraded']),
        }),
      ]),
    )
    expect(budget(ledger, 'serve_readonly')).toMatchObject({ decision: 'block' })
    expect(budget(ledger, 'dispatch_normal')).toMatchObject({ decision: 'block' })
  })

  it('prices Torghut freshness pressure refs even when the consumer receipt is fresh', () => {
    const ledger = buildLedger({
      torghutConsumerEvidence: torghutEvidence({
        repair_bid_settlement_dispatchable_lot_ids: [],
        freshness_carry_ledger_id: 'freshness-carry-ledger:test',
        freshness_carry_state: 'repair_only',
        freshness_carry_pressure_ref_ids: ['freshness-pressure-ref:tca'],
        freshness_carry_dispatchable_pressure_ref_ids: ['freshness-pressure-ref:tca'],
        freshness_carry_required_output_receipts: ['torghut.execution-tca-refresh-receipt.v1'],
        freshness_carry_target_value_gates: ['fill_tca_or_slippage_quality'],
        freshness_carry_reason_codes: ['tca_computed_at_stale'],
      }),
    })

    expect(ledger.pressure_sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_class: 'torghut_freshness',
          severity: 'warning',
          evidence_ref: 'freshness-pressure-ref:tca',
          value_gates: expect.arrayContaining(['fill_tca_or_slippage_quality']),
          reason_codes: expect.arrayContaining(['torghut_freshness_pressure_active', 'tca_computed_at_stale']),
        }),
      ]),
    )
    expect(budget(ledger, 'dispatch_repair')).toMatchObject({
      decision: 'repair_only',
      max_notional: 0,
      required_repair_receipts: expect.arrayContaining([
        'freshness-pressure-ref:tca',
        'torghut.execution-tca-refresh-receipt.v1',
      ]),
    })
    expect(budget(ledger, 'dispatch_normal')).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['torghut_freshness_pressure_active', 'tca_computed_at_stale']),
    })
  })
})
