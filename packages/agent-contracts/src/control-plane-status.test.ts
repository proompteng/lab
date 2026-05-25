import { describe, expect, it } from 'vitest'

import {
  buildAuthorityProvenanceSettlement,
  buildControlPlaneControllerIngestionSettlement,
  isControlPlaneHeartbeatFresh,
  type AgentRunIngestionStatus,
  type ControlPlaneControllerWitnessQuorum,
  type ControlPlaneRolloutHealth,
  type ControlPlaneWatchReliability,
  type ControlPlaneSourceServingSnapshot,
  type DatabaseStatus,
  type WorkflowsReliabilityStatus,
} from './control-plane-status'
import type { ExecutionTrustStatus } from './execution-trust'

const now = new Date('2026-05-20T12:00:00.000Z')
const freshUntil = '2026-05-20T12:05:00.000Z'

const controllerWitness = (
  overrides: Partial<ControlPlaneControllerWitnessQuorum> = {},
): ControlPlaneControllerWitnessQuorum => ({
  mode: 'shadow',
  design_artifact: 'docs/agents/designs/agents-controller-witness-quorum.md',
  quorum_id: 'controller-witness:healthy',
  generated_at: now.toISOString(),
  expires_at: freshUntil,
  namespace: 'agents',
  decision: 'allow',
  reason_codes: [],
  message: 'controller witnesses current',
  witness_refs: ['witness:controller', 'witness:deployment', 'witness:watch', 'witness:ingestion'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [],
  rollback_target: null,
  ...overrides,
})

const agentRunIngestion = (overrides: Partial<AgentRunIngestionStatus> = {}): AgentRunIngestionStatus => ({
  namespace: 'agents',
  status: 'healthy',
  message: 'AgentRun ingestion healthy',
  last_watch_event_at: now.toISOString(),
  last_resync_at: now.toISOString(),
  untouched_run_count: 0,
  oldest_untouched_age_seconds: null,
  ...overrides,
})

const executionTrust = (overrides: Partial<ExecutionTrustStatus> = {}): ExecutionTrustStatus => ({
  status: 'healthy',
  reason: 'execution trust healthy',
  last_evaluated_at: now.toISOString(),
  blocking_windows: [],
  evidence_summary: [],
  ...overrides,
})

const database = (overrides: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
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
    latest_registered: '20260520_agents_controller_ingestion',
    latest_applied: '20260520_agents_controller_ingestion',
    missing_migrations: [],
    unexpected_migrations: [],
    message: 'migrations healthy',
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

const watchReliability = (overrides: Partial<ControlPlaneWatchReliability> = {}): ControlPlaneWatchReliability => ({
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 1,
  total_events: 10,
  total_errors: 0,
  total_restarts: 0,
  streams: [],
  ...overrides,
})

const workflows = (overrides: Partial<WorkflowsReliabilityStatus> = {}): WorkflowsReliabilityStatus => ({
  active_job_runs: 1,
  recent_failed_jobs: 0,
  backoff_limit_exceeded_jobs: 0,
  window_minutes: 60,
  top_failure_reasons: [],
  data_confidence: 'high',
  collection_errors: 0,
  collected_namespaces: 1,
  target_namespaces: 1,
  message: 'workflow runtime evidence is current',
  ...overrides,
})

const sourceServing = (
  overrides: Partial<ControlPlaneSourceServingSnapshot> = {},
): ControlPlaneSourceServingSnapshot => ({
  verdict_ref: 'source-serving:healthy',
  status: 'allow',
  fresh_until: freshUntil,
  source_head_sha: 'abc123',
  serving_build_commit: 'abc123',
  manifest_image_digest: 'sha256:source',
  serving_image_digest: 'sha256:source',
  allowed_action_classes: ['serve_readonly', 'dispatch_repair', 'dispatch_normal', 'deploy_widen', 'merge_ready'],
  repair_only_action_classes: [],
  held_action_classes: [],
  blocked_action_classes: [],
  reason_codes: [],
  evidence_refs: ['source-serving:healthy'],
  rollback_target: 'ignore source-serving verdicts',
  ...overrides,
})

const buildSettlement = (
  overrides: Partial<Parameters<typeof buildControlPlaneControllerIngestionSettlement>[0]> = {},
) =>
  buildControlPlaneControllerIngestionSettlement({
    now,
    namespace: 'agents',
    servingReadiness: 'ok',
    controllerWitness: controllerWitness(),
    agentRunIngestion: agentRunIngestion(),
    executionTrust: executionTrust(),
    database: database(),
    rolloutHealth: rolloutHealth(),
    sourceServing: sourceServing(),
    ...overrides,
  })

const buildAuthoritySettlement = (overrides: Partial<Parameters<typeof buildAuthorityProvenanceSettlement>[0]> = {}) =>
  buildAuthorityProvenanceSettlement({
    now,
    namespace: 'agents',
    database: database(),
    controllerWitness: controllerWitness(),
    agentRunIngestion: agentRunIngestion(),
    watchReliability: watchReliability(),
    workflows: workflows(),
    rolloutHealth: rolloutHealth(),
    runtimeKits: [
      {
        runtime_kit_id: 'runtime-kit:serving:1',
        kit_class: 'serving',
        subject_ref: 'agents:/v1/control-plane/status',
        component_digest: 'runtime-kit-digest:serving',
        image_ref: 'registry.ide-newton.ts.net/lab/agents-control-plane:test@sha256:abc',
        workspace_contract_version: 'agents.runtime-kit.v1',
        decision: 'healthy',
        observed_at: now.toISOString(),
        fresh_until: freshUntil,
        reason_codes: [],
        producer_revision: 'test',
        components: [],
      },
    ],
    admissionPassports: [
      {
        admission_passport_id: 'passport:serving:1',
        consumer_class: 'serving',
        authority_session_id: 'authority-session:test',
        recovery_case_set_digest: 'recovery-case-set:test',
        runtime_kit_set_digest: 'runtime-kit-set:serving',
        required_runtime_kits: ['runtime-kit:serving:1'],
        decision: 'allow',
        required_subjects: [],
        issued_at: now.toISOString(),
        fresh_until: freshUntil,
        reason_codes: [],
        producer_revision: 'test',
      },
    ],
    projectionWatermarks: [
      {
        projection_watermark_id: 'projection-watermark:deploy:1',
        consumer_key: 'deploy_verification',
        recovery_warrant_id: 'recovery-warrant:serving:1',
        source_ref: 'agents:/v1/control-plane/status',
        projection_digest: 'projection-digest:deploy',
        status: 'fresh',
        observed_at: now.toISOString(),
        expires_at: freshUntil,
        reason_codes: [],
      },
    ],
    ...overrides,
  })

describe('control-plane status contracts', () => {
  it('treats control-plane heartbeats as fresh only inside the observed/expiry window', () => {
    const heartbeat = {
      observed_at: '2026-03-08T12:00:00Z',
      expires_at: '2026-03-08T12:02:00Z',
    }

    expect(isControlPlaneHeartbeatFresh(heartbeat, new Date('2026-03-08T12:01:00Z'))).toBe(true)
    expect(isControlPlaneHeartbeatFresh(heartbeat, new Date('2026-03-08T12:03:00Z'))).toBe(false)
  })

  it('builds a domain-neutral controller-ingestion settlement', () => {
    const settlement = buildSettlement()

    expect(settlement).toMatchObject({
      schema_version: 'agents.controller-ingestion-settlement.v1',
      decision: 'allow',
      source_serving_material_status: 'allow',
      selected_repair_ticket: {
        ticket_class: 'none',
        max_parallelism: 0,
      },
      reason_codes: [],
    })
    expect(JSON.stringify(settlement)).not.toMatch(/torghut|jangar/i)
  })

  it('selects a controller-ingestion repair ticket when controller ingestion is the only failing surface', () => {
    const settlement = buildSettlement({
      controllerWitness: controllerWitness({
        decision: 'repair_only',
        reason_codes: ['controller_witness_split'],
        quorum_id: 'controller-witness:repair',
      }),
      agentRunIngestion: agentRunIngestion({
        status: 'unknown',
        message: 'AgentRun ingestion self-report missing',
        last_watch_event_at: null,
        last_resync_at: null,
      }),
    })

    expect(settlement.decision).toBe('repair_only')
    expect(settlement.controller_reason_codes).toEqual(
      expect.arrayContaining(['agentrun_ingestion_unknown', 'controller_witness_split']),
    )
    expect(settlement.selected_repair_ticket).toMatchObject({
      ticket_class: 'controller_ingestion',
      max_parallelism: 1,
      reason_codes: expect.arrayContaining(['agentrun_ingestion_unknown']),
    })
  })

  it('does not block material carry for unrelated source-serving action classes', () => {
    const settlement = buildSettlement({
      sourceServing: sourceServing({
        status: 'block',
        blocked_action_classes: ['live_support'],
      }),
    })

    expect(settlement.decision).toBe('allow')
    expect(settlement.source_serving_material_status).toBe('allow')
    expect(settlement.reason_codes).toEqual([])
  })

  it('builds a verifier-compatible authority provenance settlement', () => {
    const settlement = buildAuthoritySettlement()

    expect(settlement).toMatchObject({
      schema_version: 'jangar.authority-provenance-settlement.v1',
      evidence_mode: 'shadow',
      settlement_state: 'settled',
      winning_authority: 'controller_heartbeat',
      reentry_windows: [],
    })
    expect(settlement.fresh_until).toBe('2026-05-20T12:01:00.000Z')
    expect(settlement.action_class_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_class: 'deploy_widen', decision: 'allow' }),
        expect.objectContaining({ action_class: 'merge_ready', decision: 'allow' }),
      ]),
    )
  })

  it('holds deploy widening when authority provenance has split evidence', () => {
    const settlement = buildAuthoritySettlement({
      database: database({ status: 'unknown', message: 'database projection is not evaluated' }),
    })

    expect(settlement.settlement_state).toBe('settled_with_split')
    expect(settlement.action_class_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'deploy_widen',
          decision: 'hold',
          reason_codes: expect.arrayContaining(['database_unknown']),
        }),
      ]),
    )
  })
})
