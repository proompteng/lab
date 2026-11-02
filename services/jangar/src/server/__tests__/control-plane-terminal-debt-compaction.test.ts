import { describe, expect, it } from 'vitest'

import type {
  ControlPlaneControllerWitnessQuorum,
  ReadyTruthArbiter,
  RepairBidAdmissionState,
  TorghutConsumerEvidenceStatus,
  WorkflowsReliabilityStatus,
} from '~/server/control-plane-status-types'
import {
  buildTerminalDebtCompactionLedger,
  TERMINAL_DEBT_COMPACTION_DESIGN_ARTIFACT,
  type TerminalDebtAgentRun,
  type TerminalDebtJob,
  type TerminalDebtPod,
} from '~/server/control-plane-terminal-debt-compaction'
import type { ControlPlaneWatchReliability } from '~/server/control-plane-status-types'

const now = new Date('2026-05-13T12:00:00.000Z')

const workflowStatus = (overrides: Partial<WorkflowsReliabilityStatus> = {}): WorkflowsReliabilityStatus => ({
  active_job_runs: 0,
  recent_failed_jobs: 0,
  backoff_limit_exceeded_jobs: 0,
  window_minutes: 15,
  top_failure_reasons: [],
  data_confidence: 'high',
  collection_errors: 0,
  collected_namespaces: 1,
  target_namespaces: 1,
  message: 'workflow window clean',
  ...overrides,
})

const watchReliability: ControlPlaneWatchReliability = {
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 1,
  total_events: 12,
  total_errors: 0,
  total_restarts: 0,
  streams: [],
}

const controllerWitness: ControlPlaneControllerWitnessQuorum = {
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
  quorum_id: 'controller-witness:allow',
  generated_at: now.toISOString(),
  expires_at: '2026-05-13T12:01:00.000Z',
  namespace: 'agents',
  decision: 'allow',
  reason_codes: [],
  message: 'controller witness current',
  witness_refs: [],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [],
  rollback_target: null,
}

const readyTruthArbiter = {
  verdict_id: 'ready-truth:allow',
} as ReadyTruthArbiter

const repairBidAdmission: RepairBidAdmissionState = {
  schema_version: 'jangar.repair-bid-admission-state.v1',
  mode: 'observe',
  design_artifact: 'docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:01:00.000Z',
  status: 'allow',
  torghut_settlement_ledger_ref: 'repair-bid-settlement:current',
  receipts: [],
  dispatch_tickets: [],
  admitted_lot_ids: [],
  held_lot_ids: [],
  active_dedupe_keys: [],
  reason_codes: [],
  rollback_target: 'JANGAR_REPAIR_BID_ADMISSION_MODE=observe',
}

const torghutConsumerEvidence = {
  receipt_id: 'torghut-consumer-evidence:current',
} as TorghutConsumerEvidenceStatus

const baseAgentRun = (overrides: Partial<TerminalDebtAgentRun> = {}): TerminalDebtAgentRun => ({
  metadata: {
    name: 'jangar-control-plane-plan-failed',
    namespace: 'agents',
    generation: 1,
    labels: {
      'swarm.proompteng.ai/name': 'jangar-control-plane',
      'swarm.proompteng.ai/stage': 'plan',
    },
    annotations: {
      'swarm.proompteng.ai/stage-clearance-action-class': 'dispatch_normal',
    },
    creationTimestamp: '2026-05-13T09:55:00.000Z',
  },
  spec: {
    parameters: {
      stage: 'plan',
      swarmStageClearanceActionClass: 'dispatch_normal',
    },
    agentRefName: 'codex-agent',
    implementationSpecRefName: 'jangar-control-plane-plan',
    runtimeType: 'workflow',
  },
  status: {
    phase: 'Failed',
    reason: 'BackoffLimitExceeded',
    message: 'runner job exhausted retries',
    startedAt: '2026-05-13T09:55:00.000Z',
    finishedAt: '2026-05-13T10:00:00.000Z',
    conditions: [
      {
        type: 'Succeeded',
        status: 'False',
        reason: 'BackoffLimitExceeded',
        message: 'failed job',
        lastTransitionTime: '2026-05-13T10:00:00.000Z',
      },
    ],
  },
  ...overrides,
})

const baseJob = (overrides: Partial<TerminalDebtJob> = {}): TerminalDebtJob => ({
  metadata: {
    name: 'jangar-control-plane-plan-job',
    namespace: 'agents',
    generation: 1,
    labels: {
      'swarm.proompteng.ai/name': 'jangar-control-plane',
      'swarm.proompteng.ai/stage': 'plan',
    },
    annotations: {
      'swarm.proompteng.ai/stage-clearance-action-class': 'dispatch_normal',
    },
    creationTimestamp: '2026-05-13T09:55:00.000Z',
  },
  status: {
    active: 0,
    failed: 1,
    startTime: '2026-05-13T09:55:00.000Z',
    completionTime: '2026-05-13T10:00:00.000Z',
    conditions: [
      {
        type: 'Failed',
        status: 'True',
        reason: 'BackoffLimitExceeded',
        message: 'job failed',
        lastTransitionTime: '2026-05-13T10:00:00.000Z',
      },
    ],
  },
  ...overrides,
})

const basePod = (overrides: Partial<TerminalDebtPod> = {}): TerminalDebtPod => ({
  metadata: {
    name: 'jangar-control-plane-plan-pod',
    namespace: 'agents',
    generation: 1,
    labels: {
      'swarm.proompteng.ai/name': 'jangar-control-plane',
      'swarm.proompteng.ai/stage': 'plan',
    },
    annotations: {
      'swarm.proompteng.ai/stage-clearance-action-class': 'dispatch_normal',
    },
    creationTimestamp: '2026-05-13T10:00:00.000Z',
  },
  status: {
    phase: 'Failed',
    conditions: [],
    containerStatuses: [
      {
        name: 'runner',
        image: 'runner:test',
        ready: false,
        state: {
          terminated: {
            reason: 'Error',
            message: 'process exited',
            exitCode: 1,
          },
        },
      },
    ],
  },
  ...overrides,
})

const buildLedger = (overrides: Partial<Parameters<typeof buildTerminalDebtCompactionLedger>[0]> = {}) =>
  buildTerminalDebtCompactionLedger({
    now,
    namespace: 'agents',
    workflows: workflowStatus(),
    watchReliability,
    controllerWitness,
    stageCreditLedger: null,
    readyTruthArbiter,
    repairBidAdmission,
    torghutConsumerEvidence,
    agentRuns: [],
    jobs: [],
    pods: [],
    collectionErrors: [],
    ...overrides,
  })

describe('control-plane terminal debt compaction ledger', () => {
  it('keeps historical failed AgentRuns, Jobs, and Pods as retained audit debt when the workflow window is clean', () => {
    const ledger = buildLedger({
      agentRuns: [baseAgentRun()],
      jobs: [baseJob()],
      pods: [basePod()],
    })

    expect(ledger).toMatchObject({
      schema_version: 'jangar.terminal-debt-compaction-ledger.v1',
      evidence_mode: 'observe',
      governing_design_refs: expect.arrayContaining([TERMINAL_DEBT_COMPACTION_DESIGN_ARTIFACT]),
      active_debt_summary: {
        count: 0,
      },
      retained_audit_summary: {
        count: 3,
      },
      scheduler_contract: {
        status: 'allow',
        would_hold_action_classes: [],
      },
      deployer_contract: {
        status: 'allow',
        merge_ready_action: 'allow',
        deploy_widen_action: 'allow',
      },
    })
    expect(ledger.cohorts).toHaveLength(3)
    expect(ledger.cohorts.map((cohort) => cohort.state)).toEqual(['retained_audit', 'retained_audit', 'retained_audit'])
    expect(ledger.cohorts.every((cohort) => cohort.active_gate_effect === 'audit_only')).toBe(true)
    expect(ledger.source_windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_class: 'agentrun', observed_count: 1, active_debt_count: 0 }),
        expect.objectContaining({ source_class: 'job', observed_count: 1, active_debt_count: 0 }),
        expect.objectContaining({ source_class: 'pod', observed_count: 1, active_debt_count: 0 }),
      ]),
    )
  })

  it('holds deploy and merge claims when failed terminal debt is inside the active window', () => {
    const ledger = buildLedger({
      workflows: workflowStatus({ recent_failed_jobs: 1 }),
      agentRuns: [
        baseAgentRun({
          metadata: {
            ...baseAgentRun().metadata,
            creationTimestamp: '2026-05-13T11:54:00.000Z',
          },
          status: {
            ...baseAgentRun().status,
            startedAt: '2026-05-13T11:54:00.000Z',
            finishedAt: '2026-05-13T11:55:00.000Z',
          },
        }),
      ],
      jobs: [
        baseJob({
          status: {
            ...baseJob().status,
            startTime: '2026-05-13T11:54:00.000Z',
            completionTime: '2026-05-13T11:55:00.000Z',
          },
        }),
      ],
    })

    expect(ledger.active_debt_summary).toMatchObject({
      count: 2,
      reason_codes: expect.arrayContaining(['agentrun_failure_active_window', 'job_failure_active_window']),
    })
    expect(ledger.retained_audit_summary.count).toBe(0)
    expect(ledger.scheduler_contract).toMatchObject({
      status: 'hold',
      would_hold_action_classes: ['dispatch_normal', 'deploy_widen', 'merge_ready'],
    })
    expect(ledger.deployer_contract).toMatchObject({
      status: 'hold',
      merge_ready_action: 'hold',
      deploy_widen_action: 'hold',
    })
    expect(ledger.cohorts.every((cohort) => cohort.active_gate_effect === 'hold')).toBe(true)
  })

  it('keeps collection failures as pending settlement debt instead of silently allowing material readiness', () => {
    const ledger = buildLedger({
      collectionErrors: ['AgentRun terminal debt collection failed: kubernetes list forbidden'],
    })

    expect(ledger.active_debt_summary).toMatchObject({
      count: 1,
      reason_codes: expect.arrayContaining(['terminal_debt_collection_error']),
    })
    expect(ledger.cohorts).toContainEqual(
      expect.objectContaining({
        class: 'source_ingest',
        state: 'pending_settlement',
        active_gate_effect: 'hold',
      }),
    )
    expect(ledger.scheduler_contract.status).toBe('hold')
  })

  it('carries Torghut repair outcome escrows into terminal debt handoff evidence', () => {
    const ledger = buildLedger({
      torghutConsumerEvidence: {
        ...torghutConsumerEvidence,
        repair_outcome_dividend_ledger_id: 'repair-outcome-dividend-ledger:test',
        repair_outcome_escrows: [
          {
            escrow_id: 'repair-outcome-escrow:quant',
            dispatch_ticket_id: 'repair-outcome-dispatch-ticket:quant',
            repair_lot_id: 'compacted-repair-lot:quant',
            expected_output_receipt: 'torghut.quant-pipeline-current-receipt.v1',
            expected_reason_code_delta: ['jangar_quant_ingestion_degraded'],
            launched_agentrun_ref: null,
            terminal_state: 'pending',
            outcome: 'pending',
            retired_reason_codes: [],
            preserved_reason_codes: ['jangar_quant_ingestion_degraded'],
            next_action: 'hold',
          },
        ],
      },
    })

    expect(ledger.repair_outcome_escrows).toEqual([
      expect.objectContaining({
        escrow_id: 'repair-outcome-escrow:quant',
        repair_lot_id: 'compacted-repair-lot:quant',
        terminal_state: 'pending',
        outcome: 'pending',
      }),
    ])
    expect(ledger.deployer_contract.evidence_refs).toEqual(
      expect.arrayContaining(['repair-outcome-dividend-ledger:test', 'repair-outcome-escrow:quant']),
    )
  })
})
