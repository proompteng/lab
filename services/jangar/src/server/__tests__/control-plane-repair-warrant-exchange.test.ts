import { describe, expect, it } from 'vitest'

import type {
  ActionSloBudget,
  ActionSloBudgetActionClass,
  SourceRolloutTruthExchange,
} from '~/server/control-plane-status-types'
import {
  buildRepairWarrantExchange,
  buildScheduleDebtWindow,
  collectRepairScheduleAttempts,
  type RepairScheduleAttemptEvidence,
  type RepairScheduleJob,
} from '~/server/control-plane-repair-warrant-exchange'
import type { ControlPlaneRolloutHealth, ControlPlaneWatchReliability } from '~/server/control-plane-status-types'

const now = new Date('2026-05-07T14:30:00.000Z')

const watch = (status: ControlPlaneWatchReliability['status'] = 'healthy'): ControlPlaneWatchReliability => ({
  status,
  window_minutes: 15,
  observed_streams: status === 'healthy' ? 2 : 1,
  total_events: status === 'healthy' ? 20 : 3,
  total_errors: status === 'healthy' ? 0 : 2,
  total_restarts: status === 'healthy' ? 0 : 1,
  streams: [],
})

const rollout = (status: ControlPlaneRolloutHealth['status'] = 'healthy'): ControlPlaneRolloutHealth => ({
  status,
  observed_deployments: 2,
  degraded_deployments: status === 'healthy' ? 0 : 1,
  deployments: [],
  message: `rollout ${status}`,
})

const budget = (
  actionClass: ActionSloBudgetActionClass,
  reasons: string[] = [],
  overrides: Partial<ActionSloBudget> = {},
): ActionSloBudget => ({
  budget_id: `slo:${actionClass}:test`,
  router_epoch_id: 'ner:test',
  action_class: actionClass,
  consumer: actionClass === 'dispatch_repair' ? 'engineer' : 'torghut',
  scope: 'agents/jangar',
  decision: reasons.length > 0 ? 'hold' : 'allow',
  max_dispatches: actionClass === 'dispatch_repair' ? 1 : 0,
  max_runtime_seconds: actionClass === 'dispatch_repair' ? 1200 : 0,
  max_notional: 0,
  max_error_budget_spend: 0,
  fresh_until: '2026-05-07T14:31:00.000Z',
  downgrade_reasons: [],
  blocked_reasons: reasons,
  required_repairs: reasons.map((reason) => `repair ${reason}`),
  rollback_target: reasons.length > 0 ? `rollback ${actionClass}` : null,
  evidence_refs: reasons.map((reason) => `evidence:${reason}`),
  ...overrides,
})

const sourceExchange = (blockers: string[]): SourceRolloutTruthExchange => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md',
  exchange_id: 'source-rollout-truth:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-07T14:31:00.000Z',
  namespace: 'agents',
  source_head_sha: '99470fcfa0000000000000000000000000000000',
  gitops_revision: '99470fcfa0000000000000000000000000000000',
  desired_images: [],
  live_images: [],
  controller_heartbeats: [],
  route_statuses: [],
  database_projection_ref: 'database:healthy:healthy',
  watch_cache_ref: 'watch:healthy',
  torghut_proof_floor: {
    proof_floor_ref: 'torghut-proof-floor:repair_only:test',
    state: blockers.length > 0 ? 'repair_only' : 'closed',
    capital_state: blockers.length > 0 ? 'zero_notional' : 'paper',
    fresh_until: '2026-05-07T14:31:00.000Z',
    blockers,
    evidence_refs: blockers.map((blocker) => `torghut:proof-floor:${blocker}`),
  },
  receipts: [],
  deployer_summary: {
    settlement_state: blockers.length > 0 ? 'proof_floor_repair_only' : 'converged',
    freshest_blocking_reason: blockers[0] ?? null,
    rollback_target: blockers.length > 0 ? 'keep Torghut zero-notional' : null,
    held_action_classes: blockers.length > 0 ? ['paper_canary', 'live_micro_canary', 'live_scale'] : [],
    receipt_refs: [],
  },
  rollback_target: blockers.length > 0 ? 'keep Torghut zero-notional' : null,
})

const buildExchange = (input: {
  blockers: string[]
  watchStatus?: ControlPlaneWatchReliability['status']
  rolloutStatus?: ControlPlaneRolloutHealth['status']
  attempts?: RepairScheduleAttemptEvidence[]
  collectionErrors?: string[]
}) =>
  buildRepairWarrantExchange({
    now,
    namespace: 'agents',
    sourceRolloutTruthExchange: sourceExchange(input.blockers),
    actionSloBudgets: [
      budget('dispatch_repair'),
      budget('paper_canary', input.blockers),
      budget('live_micro_canary', input.blockers),
      budget('live_scale', input.blockers),
    ],
    torghutActionSloBudgets: [
      budget('paper_canary', input.blockers),
      budget('live_micro_canary', input.blockers),
      budget('live_scale', input.blockers),
    ],
    watchReliability: watch(input.watchStatus),
    rolloutHealth: rollout(input.rolloutStatus),
    scheduleAttempts: input.attempts ?? [],
    scheduleCollectionErrors: input.collectionErrors ?? [],
  })

const attempt = (
  observedAt: string,
  result: RepairScheduleAttemptEvidence['result'],
  overrides: Partial<RepairScheduleAttemptEvidence> = {},
): RepairScheduleAttemptEvidence => ({
  lane: 'hourly-jangar-plan',
  sourceRef: 'main@99470fc',
  imageRef: 'runtime-digest:plan',
  objectiveRef: 'AgentRun:agents:plan-template',
  result,
  observedAt,
  jobRef: `job:agents:${result}-${observedAt}`,
  reasonCodes: [result === 'error' ? 'BackoffLimitExceeded' : 'Complete'],
  ...overrides,
})

const listScheduleJobs = (jobs: RepairScheduleJob[]) => async () => jobs

const scheduledJob = (overrides: Partial<RepairScheduleJob> = {}): RepairScheduleJob => ({
  metadata: {
    name: 'hourly-jangar-plan-retry',
    namespace: 'agents',
    generation: null,
    labels: {
      'schedules.proompteng.ai/schedule': 'hourly-jangar-plan',
    },
    annotations: {
      'jangar.proompteng.ai/schedule-debt-source-ref': 'main@99470fc',
      'jangar.proompteng.ai/schedule-debt-image-ref': 'runtime-digest:plan',
      'jangar.proompteng.ai/schedule-debt-objective-ref': 'AgentRun:agents:plan-template',
    },
    creationTimestamp: '2026-05-07T14:00:00.000Z',
  },
  status: {
    active: 1,
    failed: 1,
    startTime: '2026-05-07T14:00:00.000Z',
    completionTime: null,
    conditions: [],
  },
  ...overrides,
})

describe('repair warrant exchange', () => {
  it('admits bounded zero-notional warrants from Torghut proof-floor blockers', () => {
    const exchange = buildExchange({
      blockers: ['execution_tca_stale', 'market_context_stale', 'hypothesis_not_promotion_eligible'],
    })

    expect(exchange).toMatchObject({
      mode: 'observe',
      status: 'healthy',
      namespace: 'agents',
      source_epoch_id: 'source-rollout-truth:test',
    })
    expect(exchange.active_warrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repair_dimension: 'execution_tca',
          action_class: 'dispatch_repair',
          admission_state: 'admitted',
          max_dispatches: 1,
          max_runtime_seconds: 1200,
          max_notional: 0,
          validation_refs: expect.arrayContaining(['GET /trading/status execution_tca']),
        }),
        expect.objectContaining({
          repair_dimension: 'alpha_readiness',
          max_notional: 0,
        }),
      ]),
    )
  })

  it('nets schedule errors only when a later success matches lane, source, image, and objective', () => {
    const debt = buildScheduleDebtWindow({
      now,
      attempts: [
        attempt('2026-05-07T13:00:00.000Z', 'error'),
        attempt('2026-05-07T13:10:00.000Z', 'success'),
        attempt('2026-05-07T13:20:00.000Z', 'error', { imageRef: 'runtime-digest:other' }),
        attempt('2026-05-07T13:30:00.000Z', 'error', { objectiveRef: null }),
      ],
    })

    const lane = debt.lanes.find((entry) => entry.lane === 'hourly-jangar-plan')
    expect(lane).toBeTruthy()
    expect(lane?.superseded_error_count).toBe(1)
    expect(lane?.open_error_count).toBe(2)
    expect(lane?.firebreak_state).toBe('clear')
    expect(lane?.attempts.find((entry) => entry.result === 'success')?.supersedes_attempt_ids).toHaveLength(1)
    expect(
      lane?.attempts.find((entry) => entry.image_ref === 'runtime-digest:other')?.superseded_by_attempt_id,
    ).toBeNull()
    expect(lane?.attempts.find((entry) => entry.objective_ref === null)?.signature_complete).toBe(false)
  })

  it('keeps the firebreak closed over open errors even when unrelated successes exist', () => {
    const debt = buildScheduleDebtWindow({
      now,
      attempts: [
        attempt('2026-05-07T13:00:00.000Z', 'error'),
        attempt('2026-05-07T13:05:00.000Z', 'error', { imageRef: 'runtime-digest:1' }),
        attempt('2026-05-07T13:10:00.000Z', 'error', { imageRef: 'runtime-digest:2' }),
        attempt('2026-05-07T13:15:00.000Z', 'success', { imageRef: 'runtime-digest:other' }),
      ],
    })

    const lane = debt.lanes.find((entry) => entry.lane === 'hourly-jangar-plan')
    expect(lane).toBeTruthy()
    expect(lane?.open_error_count).toBe(3)
    expect(lane?.success_count).toBe(1)
    expect(lane?.superseded_error_count).toBe(0)
    expect(lane?.firebreak_state).toBe('observe_only')
    expect(lane?.reason_codes).toContain('schedule_debt_error_margin_exceeded')
    expect(debt.firebreak_state).toBe('observe_only')
  })

  it('keeps retrying jobs running instead of failed schedule debt', async () => {
    const collection = await collectRepairScheduleAttempts({
      now,
      namespaces: ['agents'],
      listScheduleJobs: listScheduleJobs([scheduledJob()]),
    })
    const debt = buildScheduleDebtWindow({
      now,
      attempts: collection.attempts,
    })

    expect(collection.collectionErrors).toEqual([])
    expect(collection.attempts[0]).toMatchObject({
      result: 'running',
      reasonCodes: ['job_running'],
    })
    expect(debt).toMatchObject({
      open_error_count: 0,
      running_count: 1,
      firebreak_state: 'clear',
    })
  })

  it('counts failure-target jobs as failed schedule debt before terminal failed condition', async () => {
    const collection = await collectRepairScheduleAttempts({
      now,
      namespaces: ['agents'],
      listScheduleJobs: listScheduleJobs([
        scheduledJob({
          status: {
            active: 1,
            failed: 1,
            startTime: '2026-05-07T14:00:00.000Z',
            completionTime: null,
            conditions: [
              {
                type: 'FailureTarget',
                status: 'True',
                reason: 'BackoffLimitExceeded',
                lastTransitionTime: '2026-05-07T14:05:00.000Z',
              },
            ],
          },
        }),
      ]),
    })
    const debt = buildScheduleDebtWindow({
      now,
      attempts: collection.attempts,
    })

    expect(collection.collectionErrors).toEqual([])
    expect(collection.attempts[0]).toMatchObject({
      result: 'error',
      reasonCodes: ['BackoffLimitExceeded'],
      observedAt: '2026-05-07T14:05:00.000Z',
    })
    expect(debt).toMatchObject({
      open_error_count: 1,
      running_count: 0,
      firebreak_state: 'clear',
    })
  })

  it('keeps backing-off retry jobs out of failed schedule debt', async () => {
    const collection = await collectRepairScheduleAttempts({
      now,
      namespaces: ['agents'],
      listScheduleJobs: listScheduleJobs([
        scheduledJob({
          status: {
            active: 0,
            failed: 1,
            startTime: '2026-05-07T14:00:00.000Z',
            completionTime: null,
            conditions: [],
          },
        }),
      ]),
    })
    const debt = buildScheduleDebtWindow({
      now,
      attempts: collection.attempts,
    })

    expect(collection.collectionErrors).toEqual([])
    expect(collection.attempts[0]).toMatchObject({
      result: 'running',
      observedAt: '2026-05-07T14:00:00.000Z',
      reasonCodes: ['job_retrying'],
    })
    expect(debt).toMatchObject({
      open_error_count: 0,
      running_count: 1,
      firebreak_state: 'clear',
    })
  })

  it('downgrades new warrants to observe-only when schedule debt exceeds the firebreak margin', () => {
    const attempts = [
      attempt('2026-05-07T13:00:00.000Z', 'error'),
      attempt('2026-05-07T13:10:00.000Z', 'error', { imageRef: 'runtime-digest:1' }),
      attempt('2026-05-07T13:20:00.000Z', 'error', { imageRef: 'runtime-digest:2' }),
      attempt('2026-05-07T13:30:00.000Z', 'error', { imageRef: 'runtime-digest:3' }),
    ]
    const exchange = buildExchange({ blockers: ['execution_tca_stale'], attempts })

    expect(exchange.status).toBe('observe_only')
    expect(exchange.schedule_debt_window.firebreak_state).toBe('observe_only')
    expect(exchange.active_warrants[0]).toMatchObject({
      repair_dimension: 'execution_tca',
      admission_state: 'observe_only',
      max_dispatches: 0,
      reason_codes: expect.arrayContaining(['schedule_debt_firebreak_observe_only']),
    })
  })

  it('downgrades new warrants to observe-only when schedule debt collection fails', () => {
    const exchange = buildExchange({
      blockers: ['execution_tca_stale'],
      collectionErrors: ['agents: jobs: list failed'],
    })

    expect(exchange.status).toBe('degraded')
    expect(exchange.schedule_debt_window).toMatchObject({
      firebreak_state: 'observe_only',
      collection_errors: ['agents: jobs: list failed'],
    })
    expect(exchange.active_warrants[0]).toMatchObject({
      repair_dimension: 'execution_tca',
      admission_state: 'observe_only',
      max_dispatches: 0,
      reason_codes: expect.arrayContaining(['schedule_debt_firebreak_observe_only', 'schedule_debt_collection_error']),
    })
  })

  it('expires non-critical repair warrants when watch reliability is degraded', () => {
    const exchange = buildExchange({
      blockers: ['market_context_stale'],
      watchStatus: 'degraded',
    })

    expect(exchange.status).toBe('degraded')
    expect(exchange.active_warrants).toHaveLength(0)
    expect(exchange.expired_warrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repair_dimension: 'market_context',
          admission_state: 'expired',
          reason_codes: expect.arrayContaining(['watch_reliability_degraded']),
        }),
      ]),
    )
  })
})
