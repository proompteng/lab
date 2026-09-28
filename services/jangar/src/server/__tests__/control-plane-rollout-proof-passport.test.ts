import { describe, expect, it } from 'vitest'

import type {
  ControlPlaneControllerWitnessQuorum,
  DatabaseStatus,
  ReadyTruthArbiter,
  SourceRolloutTruthExchange,
  SourceServingContractVerdictExchange,
  StageCreditLedger,
  WorkflowsReliabilityStatus,
} from '~/server/control-plane-status-types'
import {
  buildRolloutProofPassport,
  buildRunnerCapacityFutures,
  buildStageLaunchTickets,
  ROLLOUT_PROOF_PASSPORT_DESIGN_ARTIFACT,
} from '~/server/control-plane-rollout-proof-passport'
import type { FailureDomainKubernetesEvidence } from '~/server/control-plane-failure-domain-leases'
import type { ControlPlaneRolloutHealth, RuntimeAdapterStatus } from '~/server/control-plane-status-types'

const now = new Date('2026-05-13T12:00:00.000Z')

const database: DatabaseStatus = {
  configured: true,
  connected: true,
  status: 'healthy',
  message: 'database healthy',
  latency_ms: 4,
  migration_consistency: {
    status: 'healthy',
    migration_table: 'migrations',
    registered_count: 29,
    applied_count: 29,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260508_torghut_quant_pipeline_health_account_window_created_at_index',
    latest_applied: '20260508_torghut_quant_pipeline_health_account_window_created_at_index',
    missing_migrations: [],
    unexpected_migrations: [],
    message: 'migrations current',
  },
}

const rolloutHealth: ControlPlaneRolloutHealth = {
  status: 'healthy',
  observed_deployments: 1,
  degraded_deployments: 0,
  deployments: [
    {
      name: 'jangar',
      namespace: 'jangar',
      status: 'healthy',
      desired_replicas: 1,
      ready_replicas: 1,
      available_replicas: 1,
      updated_replicas: 1,
      unavailable_replicas: 0,
      message: 'deployment healthy',
    },
  ],
  message: 'rollout healthy',
}

const controllerWitness: ControlPlaneControllerWitnessQuorum = {
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
  quorum_id: 'controller-witness:test',
  generated_at: now.toISOString(),
  expires_at: '2026-05-13T12:01:00.000Z',
  namespace: 'agents',
  decision: 'allow',
  controller_self_report_current: true,
  deployment_available: true,
  watch_epoch_current: true,
  witness_refs: ['controller:serving', 'controller:effective'],
  reason_codes: [],
  message: 'controller witness allowed',
  witnesses: [
    {
      witness_id: 'controller:serving',
      generated_at: now.toISOString(),
      expires_at: '2026-05-13T12:01:00.000Z',
      namespace: 'agents',
      controller_surface: 'serving_process',
      deployment_ref: 'deployment:agents:agents-controllers',
      pod_uid: 'pod:agents:controllers-0',
      image_ref: 'registry.example/jangar@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      leader_identity: 'agents-controllers-0',
      controller_started: true,
      deployment_available: true,
      watch_epoch_id: 'watch:healthy',
      ingestion_epoch_id: 'ingestion:healthy',
      last_watch_event_at: now.toISOString(),
      last_resync_at: now.toISOString(),
      observed_run_count: 2,
      untouched_run_count: 0,
      decision: 'allow',
      reason_codes: [],
    },
  ],
  rollback_target: null,
}

const sourceRolloutTruthExchange: SourceRolloutTruthExchange = {
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md',
  exchange_id: 'source-rollout-truth:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:01:00.000Z',
  namespace: 'agents',
  source_head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
  gitops_revision: 'abcdef1234567890abcdef1234567890abcdef12',
  desired_images: [
    {
      image_id: 'desired:jangar',
      role: 'desired_runtime',
      name: 'jangar',
      namespace: 'jangar',
      image_ref: 'registry.example/jangar@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence_ref: 'deployment:jangar:jangar',
    },
  ],
  live_images: [
    {
      image_id: 'live:jangar',
      role: 'live_pod',
      name: 'jangar-abc',
      namespace: 'jangar',
      image_ref: 'registry.example/jangar@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence_ref: 'pod:jangar:jangar-abc',
    },
  ],
  controller_heartbeats: [],
  route_statuses: [],
  database_projection_ref: 'database:healthy:healthy',
  watch_cache_ref: 'watch:healthy',
  torghut_proof_floor: {
    proof_floor_ref: 'torghut-proof-floor:repair',
    state: 'repair_only',
    capital_state: 'zero_notional',
    fresh_until: '2026-05-13T12:01:00.000Z',
    blockers: ['max_notional_zero'],
    evidence_refs: ['torghut:consumer-evidence'],
  },
  receipts: [],
  deployer_summary: {
    settlement_state: 'converged',
    freshest_blocking_reason: null,
    rollback_target: null,
    held_action_classes: [],
    receipt_refs: [],
  },
  rollback_target: null,
}

const sourceServingContractVerdictExchange: SourceServingContractVerdictExchange = {
  mode: 'observe',
  design_artifact: 'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md',
  exchange_id: 'source-serving-contract:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:01:00.000Z',
  namespace: 'agents',
  status: 'allow',
  source_sha: 'abcdef1234567890abcdef1234567890abcdef12',
  serving_build_commit: 'abcdef1234567890abcdef1234567890abcdef12',
  manifest_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  serving_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  required_contracts: ['route_warrant_exchange'],
  observed_contracts: ['route_warrant_exchange'],
  missing_contracts: [],
  verdict_refs: ['source-serving-verdict:serve'],
  allowed_action_classes: ['serve_readonly', 'dispatch_normal', 'deploy_widen', 'merge_ready'],
  repair_only_action_classes: [],
  held_action_classes: [],
  blocked_action_classes: [],
  reason_codes: [],
  verdicts: [
    {
      schema_version: 'jangar.source-serving-contract-verdict.v1',
      verdict_id: 'source-serving-verdict:serve',
      generated_at: now.toISOString(),
      fresh_until: '2026-05-13T12:01:00.000Z',
      repository: 'proompteng/lab',
      source_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      source_ci_run_id: 'ci:123',
      source_ci_conclusion: 'success',
      manifest_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      manifest_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      argo_sync_revision: 'abcdef1234567890abcdef1234567890abcdef12',
      argo_health: 'healthy',
      serving_revision: 'jangar-001',
      serving_build_commit: 'abcdef1234567890abcdef1234567890abcdef12',
      serving_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      required_contracts: ['route_warrant_exchange'],
      observed_contracts: ['route_warrant_exchange'],
      missing_contracts: [],
      contract_schema_mismatches: [],
      torghut_route_warrant_ref: 'route-warrant:test',
      torghut_repair_bid_settlement_ref: 'repair-bid-settlement:test',
      action_class: 'serve_readonly',
      decision: 'allow',
      source_serving_state: 'converged',
      max_notional: 0,
      value_gate_impacts: ['ready_status_truth'],
      required_repair_receipts: [],
      blocking_reason_codes: [],
      evidence_refs: ['source-rollout-truth:test'],
      rollback_gate: 'observe',
    },
    {
      schema_version: 'jangar.source-serving-contract-verdict.v1',
      verdict_id: 'source-serving-verdict:dispatch',
      generated_at: now.toISOString(),
      fresh_until: '2026-05-13T12:01:00.000Z',
      repository: 'proompteng/lab',
      source_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      source_ci_run_id: 'ci:123',
      source_ci_conclusion: 'success',
      manifest_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      manifest_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      argo_sync_revision: 'abcdef1234567890abcdef1234567890abcdef12',
      argo_health: 'healthy',
      serving_revision: 'jangar-001',
      serving_build_commit: 'abcdef1234567890abcdef1234567890abcdef12',
      serving_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      required_contracts: ['route_warrant_exchange'],
      observed_contracts: ['route_warrant_exchange'],
      missing_contracts: [],
      contract_schema_mismatches: [],
      torghut_route_warrant_ref: 'route-warrant:test',
      torghut_repair_bid_settlement_ref: 'repair-bid-settlement:test',
      action_class: 'dispatch_normal',
      decision: 'allow',
      source_serving_state: 'converged',
      max_notional: 0,
      value_gate_impacts: ['pr_to_rollout_latency'],
      required_repair_receipts: [],
      blocking_reason_codes: [],
      evidence_refs: ['source-rollout-truth:test'],
      rollback_gate: 'observe',
    },
  ],
  rollback_target: 'JANGAR_SOURCE_SERVING_CONTRACT_VERDICT_MODE=observe',
}

const readyTruthArbiter: ReadyTruthArbiter = {
  schema_version: 'jangar.ready-truth-arbiter.v1',
  mode: 'shadow',
  verdict_id: 'ready-truth:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:01:00.000Z',
  namespace: 'agents',
  governing_design_refs: ['docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md'],
  serving_readiness: 'ok',
  material_readiness: 'allow',
  argo_revision: 'abcdef1234567890abcdef1234567890abcdef12',
  argo_health: 'healthy',
  workload_rollout_ref: 'rollout:healthy:1:0',
  controller_witness_ref: 'controller-witness:test',
  runtime_adapter_refs: ['runtime-adapter:workflow:healthy'],
  stage_credit_ledger_ref: 'stage-credit-ledger:test',
  source_serving_verdict_ref: 'source-serving-contract:test',
  torghut_repair_receipt_ref: null,
  retained_failure_debt_refs: [],
  projection_foreclosure_notary_ref: null,
  projection_authority_decision: null,
  projection_claim_totals_by_state: null,
  projection_required_repair_actions: [],
  revenue_repair_settlement_custody_ref: null,
  revenue_repair_settlement_custody_decision: null,
  revenue_repair_settlement_custody_reasons: [],
  ready_status_truth_reasons: [],
  allowed_action_classes: ['serve_readonly', 'dispatch_normal', 'deploy_widen', 'merge_ready'],
  repair_only_action_classes: [],
  held_action_classes: [],
  blocked_action_classes: [],
  merge_gate_receipt: {
    receipt_id: 'ready-truth-merge:test',
    action_class: 'merge_ready',
    decision: 'allow',
    required_evidence_refs: ['source-serving-contract:test'],
    reason_codes: [],
  },
  deployer_receipt: {
    receipt_id: 'ready-truth-deployer:test',
    action_class: 'deploy_widen',
    decision: 'allow',
    required_evidence_refs: ['source-serving-contract:test'],
    reason_codes: [],
  },
  rollback_target: 'JANGAR_READY_TRUTH_ARBITER_MODE=observe',
}

const stageCreditLedger: StageCreditLedger = {
  schema_version: 'jangar.stage-credit-ledger.v1',
  ledger_id: 'stage-credit-ledger:test',
  namespace: 'agents',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:01:00.000Z',
  governing_design_refs: ['docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md'],
  observed_revision: {
    source_head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    gitops_revision: 'abcdef1234567890abcdef1234567890abcdef12',
  },
  evidence_mode: 'observe',
  credit_epoch_id: 'stage-credit-epoch:test',
  stage_accounts: [
    {
      account_id: 'stage-credit-account:plan',
      stage: 'plan',
      action_class: 'dispatch_normal',
      opening_credit: 100,
      base_credit: 100,
      evidence_freshness_bonus: 0,
      torghut_repair_value_credit: 0,
      rollout_truth_deposit: 0,
      failure_debt_tax: 0,
      controller_witness_tax: 0,
      source_rollout_tax: 0,
      capital_safety_tax: 0,
      runner_capacity_tax: 0,
      available_credit: 100,
      minimum_spend: 1,
      max_concurrent_runs: 1,
      max_runtime_seconds: 1200,
      max_notional: 0,
      decision: 'allow',
      reason_codes: [],
      required_repair_actions: [],
      evidence_refs: ['source-rollout-truth:test'],
      selected_repair_lot_ref: null,
      rollback_target: 'JANGAR_STAGE_CREDIT_LEDGER_MODE=observe',
    },
  ],
  runner_slot_futures: [],
  retained_failure_debt_refs: [],
  settlement_policy: {
    mode: 'read_model_only',
    refund_condition: 'terminal success',
    burn_condition: 'terminal failure',
    conversion_condition: 'repair receipt accepted',
    rollback_target: 'JANGAR_STAGE_CREDIT_LEDGER_MODE=observe',
  },
  handoff_contract: {
    value_gates: ['failed_agentrun_rate'],
    status: 'allow',
    next_implementation_milestone: 'observe',
    rollback_target: 'JANGAR_STAGE_CREDIT_LEDGER_MODE=observe',
  },
}

const workflows: WorkflowsReliabilityStatus = {
  active_job_runs: 0,
  recent_failed_jobs: 0,
  backoff_limit_exceeded_jobs: 0,
  window_minutes: 15,
  top_failure_reasons: [],
  data_confidence: 'high',
  collection_errors: 0,
  collected_namespaces: 1,
  target_namespaces: 1,
  message: '',
}

const runtimeAdapters: RuntimeAdapterStatus[] = [
  {
    name: 'workflow',
    available: true,
    status: 'healthy',
    message: 'workflow runtime ready',
    endpoint: '',
    authority: {
      mode: 'heartbeat',
      namespace: 'agents',
      source_deployment: 'agents-controllers',
      source_pod: 'agents-controllers-0',
      observed_at: now.toISOString(),
      fresh: true,
      message: 'heartbeat current',
    },
  },
  {
    name: 'job',
    available: true,
    status: 'healthy',
    message: 'job runtime ready',
    endpoint: '',
    authority: {
      mode: 'heartbeat',
      namespace: 'agents',
      source_deployment: 'agents-controllers',
      source_pod: 'agents-controllers-0',
      observed_at: now.toISOString(),
      fresh: true,
      message: 'heartbeat current',
    },
  },
]

const kubernetesEvidence: FailureDomainKubernetesEvidence = {
  pods: [],
  events: [],
  collection_errors: [],
}

const buildPassport = (
  sourceServingOverrides: Partial<SourceServingContractVerdictExchange> = {},
  sourceRolloutOverrides: Partial<SourceRolloutTruthExchange> = {},
) =>
  buildRolloutProofPassport({
    now,
    namespace: 'agents',
    sourceRolloutTruthExchange: {
      ...sourceRolloutTruthExchange,
      ...sourceRolloutOverrides,
    },
    sourceServingContractVerdictExchange: {
      ...sourceServingContractVerdictExchange,
      ...sourceServingOverrides,
    },
    database,
    rolloutHealth,
    controllerWitness,
    readyTruthArbiter,
  })

describe('rollout proof passport', () => {
  it('marks a complete source-to-serving proof chain current', () => {
    const passport = buildPassport()

    expect(passport).toMatchObject({
      schema_version: 'jangar.rollout-proof-passport.v1',
      status: 'current',
      material_action_decision: 'allow',
      manifest_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      registry_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      serving_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      governing_design_refs: expect.arrayContaining([ROLLOUT_PROOF_PASSPORT_DESIGN_ARTIFACT]),
    })
  })

  it('keeps material launch held while manifest digest proof is still collecting', () => {
    const passport = buildPassport({
      manifest_image_digest: null,
      reason_codes: ['manifest_image_digest_missing'],
      held_action_classes: ['dispatch_normal', 'deploy_widen', 'merge_ready'],
    })

    expect(passport.status).toBe('collecting')
    expect(passport.serving_readiness).toBe('ok')
    expect(passport.material_action_decision).toBe('hold')
    expect(passport.reason_codes).toContain('manifest_image_digest_missing')
  })

  it('blocks material launch when manifest and serving digests contradict each other', () => {
    const passport = buildPassport({
      serving_image_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })

    expect(passport.status).toBe('contradicted')
    expect(passport.material_action_decision).toBe('block')
    expect(passport.reason_codes).toContain('manifest_serving_image_digest_mismatch')
  })

  it('marks stale source-serving evidence as stale', () => {
    const passport = buildPassport({
      fresh_until: '2026-05-13T11:59:00.000Z',
    })

    expect(passport.status).toBe('stale')
    expect(passport.material_action_decision).toBe('block')
    expect(passport.reason_codes).toContain('source_serving_contract_stale')
  })
})

describe('runner capacity futures', () => {
  it('classifies a recent same-stage FailedScheduling event as constrained capacity', () => {
    const passport = buildPassport()
    const futures = buildRunnerCapacityFutures({
      now,
      namespace: 'agents',
      rolloutProofPassport: passport,
      workflows,
      runtimeAdapters,
      stageCreditLedger,
      kubernetesEvidence: {
        ...kubernetesEvidence,
        events: [
          {
            metadata: {
              name: 'jangar-control-plane-plan-sched-failed-scheduling',
              namespace: 'agents',
              generation: null,
              labels: {},
              creationTimestamp: '2026-05-13T11:58:30.000Z',
            },
            type: 'Warning',
            reason: 'FailedScheduling',
            message: '0/2 nodes are available: 1 node(s) had untolerated taint, 1 node(s) did not match Pod affinity.',
            firstTimestamp: '2026-05-13T11:58:30.000Z',
            lastTimestamp: '2026-05-13T11:58:30.000Z',
            eventTime: null,
            involvedObject: {
              kind: 'Pod',
              name: 'jangar-control-plane-plan-sched-abc',
              namespace: 'agents',
            },
          },
        ],
      },
    })

    const planFuture = futures.find((future) => future.stage === 'plan')
    expect(planFuture).toMatchObject({
      schema_version: 'jangar.runner-capacity-future.v1',
      capacity_state: 'constrained',
      reason_codes: expect.arrayContaining([
        'runner_capacity_failed_scheduling',
        'runner_capacity_node_affinity_mismatch',
        'runner_capacity_untolerated_taint',
      ]),
      value_gates: expect.arrayContaining(['failed_agentrun_rate', 'manual_intervention_count']),
    })
  })

  it('emits stage launch tickets that hold when capacity or rollout proof is constrained', () => {
    const passport = buildPassport({ manifest_image_digest: null, reason_codes: ['manifest_image_digest_missing'] })
    const futures = buildRunnerCapacityFutures({
      now,
      namespace: 'agents',
      rolloutProofPassport: passport,
      workflows,
      runtimeAdapters,
      stageCreditLedger,
      kubernetesEvidence,
    })
    const tickets = buildStageLaunchTickets({
      now,
      namespace: 'agents',
      rolloutProofPassport: passport,
      runnerCapacityFutures: futures,
    })

    expect(tickets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema_version: 'jangar.stage-launch-ticket.v1',
          stage: 'plan',
          action_class: 'dispatch_normal',
          decision: 'hold',
          rollout_proof_passport_ref: passport.passport_id,
          reason_codes: expect.arrayContaining([
            'rollout_proof:manifest_image_digest_missing',
            'runner_capacity:runner_capacity_image_digest_missing',
          ]),
        }),
      ]),
    )
  })
})
