import { describe, expect, test } from 'bun:test'

import {
  CycleOperationsCondition,
  CycleOperationsReason,
  deriveCycleOperationsStatus,
  type CycleOperationsProjection,
  type CycleOperationsSnapshot,
} from './cycle-observability'
import { CycleState, CycleTerminalReason } from './cycle'
import { Authority, KillState, ReconciliationStatus } from './paper'

const now = '2026-07-20T12:00:00.000Z'
const thresholds = {
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
}

const snapshot = (phase: CycleState, overrides: Partial<CycleOperationsSnapshot> = {}): CycleOperationsSnapshot => ({
  cycleId: '1'.repeat(64),
  accountId: 'paper-account-1',
  signalSessionDate: '2026-07-17',
  executionSessionDate: '2026-07-20',
  phase,
  snapshotId: phase === CycleState.Pending ? null : '2'.repeat(64),
  decisionHash: phase === CycleState.Completed || phase === CycleState.NoTrade ? '3'.repeat(64) : null,
  terminalReason: phase === CycleState.Blocked ? CycleTerminalReason.DataStale : null,
  submissionOpenAt: '2026-07-20T11:30:00.000Z',
  submissionCutoffAt: '2026-07-20T12:30:00.000Z',
  executionOpenAt: '2026-07-20T12:32:00.000Z',
  executionCloseAt: '2026-07-20T20:00:00.000Z',
  createdAt: '2026-07-20T11:29:00.000Z',
  updatedAt: '2026-07-20T11:59:00.000Z',
  terminalAt:
    phase === CycleState.Completed || phase === CycleState.NoTrade || phase === CycleState.Blocked
      ? '2026-07-20T11:59:00.000Z'
      : null,
  ...overrides,
})

const projection = (overrides: Partial<CycleOperationsProjection> = {}): CycleOperationsProjection => ({
  current: null,
  last: null,
  unfinishedCycleCount: 0,
  authority: null,
  reconciliation: null,
  mutations: { eventCount: 0, unresolvedCount: 0, oldestUnresolvedAt: null, latestOccurredAt: null },
  ...overrides,
})

describe('autonomous cycle operations classification', () => {
  test('distinguishes expected publication waiting from exact deadline and attempt stalls', () => {
    const pending = snapshot(CycleState.Pending, {
      submissionOpenAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T11:00:00.000Z',
    })
    const waiting = deriveCycleOperationsStatus(
      projection({ current: pending, unfinishedCycleCount: 1 }),
      Date.parse('2026-07-20T11:59:59.999Z'),
      Authority.Observe,
      thresholds,
    )
    const missed = deriveCycleOperationsStatus(
      projection({ current: pending, unfinishedCycleCount: 1 }),
      Date.parse(pending.submissionOpenAt),
      Authority.Observe,
      thresholds,
    )
    const boundPending = snapshot(CycleState.Pending, {
      snapshotId: '2'.repeat(64),
      submissionOpenAt: '2026-07-20T11:55:00.000Z',
      updatedAt: '2026-07-20T11:55:00.000Z',
    })
    const stale = deriveCycleOperationsStatus(
      projection({ current: boundPending, unfinishedCycleCount: 1 }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )

    expect(waiting).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.AwaitingSignalPublication,
    })
    expect(missed).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.MissedPublicationDeadline,
      alerts: { cycleStalled: true },
    })
    expect(stale).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.AttemptStale,
      attemptAgeMs: 300_000,
    })
  })

  test('keeps snapshot-bound PENDING expected before submission opens', () => {
    const pending = snapshot(CycleState.Pending, {
      snapshotId: '2'.repeat(64),
      submissionOpenAt: '2026-07-20T12:05:00.000Z',
      submissionCutoffAt: '2026-07-20T12:30:00.000Z',
      updatedAt: '2026-07-20T11:00:00.000Z',
    })
    const beforeOpen = deriveCycleOperationsStatus(
      projection({ current: pending, unfinishedCycleCount: 1 }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )
    const atOpen = deriveCycleOperationsStatus(
      projection({ current: pending, unfinishedCycleCount: 1 }),
      Date.parse(pending.submissionOpenAt),
      Authority.Observe,
      thresholds,
    )

    expect(beforeOpen).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.AwaitingSubmissionOpen,
      attemptAgeMs: 3_600_000,
      alerts: { cycleStalled: false },
    })
    expect(atOpen).toMatchObject({
      condition: CycleOperationsCondition.Running,
      reason: CycleOperationsReason.AwaitingActivation,
      alerts: { cycleStalled: false },
    })
  })

  test('keeps ACTIVE healthy after cutoff through execution close and stalls exactly at close', () => {
    const active = snapshot(CycleState.Active, {
      submissionCutoffAt: '2026-07-20T11:58:00.000Z',
      executionOpenAt: '2026-07-20T12:00:00.000Z',
      executionCloseAt: '2026-07-20T20:00:00.000Z',
      updatedAt: '2026-07-20T11:57:00.000Z',
    })
    const afterCutoff = deriveCycleOperationsStatus(
      projection({ current: active, unfinishedCycleCount: 1 }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )
    const atClose = deriveCycleOperationsStatus(
      projection({ current: active, unfinishedCycleCount: 1 }),
      Date.parse(active.executionCloseAt),
      Authority.Observe,
      thresholds,
    )

    expect(afterCutoff).toMatchObject({
      condition: CycleOperationsCondition.Running,
      reason: CycleOperationsReason.Active,
      alerts: { cycleStalled: false },
    })
    expect(atClose).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.MissedExecutionClose,
      alerts: { cycleStalled: true },
    })
  })

  test('raises missed-submission at the exact cutoff and clears only on a later terminal cycle', () => {
    const pending = snapshot(CycleState.Pending, {
      snapshotId: '2'.repeat(64),
      submissionOpenAt: '2026-07-20T11:30:00.000Z',
      submissionCutoffAt: now,
    })
    const missed = deriveCycleOperationsStatus(
      projection({ current: pending, unfinishedCycleCount: 1 }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )
    const recovered = deriveCycleOperationsStatus(
      projection({
        last: snapshot(CycleState.Completed, {
          updatedAt: '2026-07-20T12:00:01.000Z',
          terminalAt: '2026-07-20T12:00:01.000Z',
        }),
      }),
      Date.parse('2026-07-20T12:00:01.000Z'),
      Authority.Observe,
      thresholds,
    )

    expect(missed).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.MissedSubmissionCutoff,
      alerts: { cycleStalled: true },
    })
    expect(recovered).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.LastCycleCompleted,
      alerts: { cycleStalled: false, cycleFailed: false },
    })
  })

  test('keeps a blocked terminal result failed through a later attempt and clears on confirmed terminal success', () => {
    const blocked = snapshot(CycleState.Blocked)
    const recovering = deriveCycleOperationsStatus(
      projection({
        current: snapshot(CycleState.Active, {
          cycleId: '4'.repeat(64),
          signalSessionDate: '2026-07-20',
          executionSessionDate: '2026-07-21',
          submissionOpenAt: '2026-07-20T12:00:00.000Z',
          submissionCutoffAt: '2026-07-20T12:30:00.000Z',
          executionOpenAt: '2026-07-20T12:32:00.000Z',
          executionCloseAt: '2026-07-20T20:00:00.000Z',
          updatedAt: '2026-07-20T11:59:59.000Z',
        }),
        last: blocked,
        unfinishedCycleCount: 1,
      }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )
    const recovered = deriveCycleOperationsStatus(
      projection({
        last: snapshot(CycleState.Completed, {
          cycleId: '4'.repeat(64),
          updatedAt: now,
          terminalAt: now,
        }),
      }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )

    expect(recovering).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.LastCycleBlocked,
      alerts: { cycleFailed: true },
    })
    expect(recovered).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.LastCycleCompleted,
      alerts: { cycleFailed: false, cycleStalled: false },
    })
  })

  test('keeps OBSERVE credential-free while PAPER requires coherent durable authority and reconciliation', () => {
    const observe = deriveCycleOperationsStatus(projection(), Date.parse(now), Authority.Observe, thresholds)
    const missingPaper = deriveCycleOperationsStatus(projection(), Date.parse(now), Authority.Paper, thresholds)
    const readyPaper = deriveCycleOperationsStatus(
      projection({
        authority: {
          generationHash: '4'.repeat(64),
          maximum: Authority.Paper,
          effective: Authority.Observe,
          kill: KillState.Clear,
          reason: null,
          updatedAt: now,
        },
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '5'.repeat(64),
          status: ReconciliationStatus.Exact,
          discrepancyCount: 0,
          reconciledAt: now,
          coversLatestMutation: true,
        },
      }),
      Date.parse(now),
      Authority.Paper,
      thresholds,
    )

    expect(observe).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.NoCycleRecorded,
      authority: null,
    })
    expect(missingPaper).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.AuthorityMissing,
      alerts: { authorityIncoherent: true },
    })
    expect(readyPaper).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.NoCycleRecorded,
      authority: { generationHash: '4'.repeat(64) },
      alerts: { authorityIncoherent: false, reconciliationBlocked: false },
    })
  })

  test('fails unresolved mutation immediately and raises its stale alert at the exact threshold', () => {
    const unresolved = projection({
      mutations: {
        eventCount: 1,
        unresolvedCount: 1,
        oldestUnresolvedAt: '2026-07-20T11:55:00.000Z',
        latestOccurredAt: '2026-07-20T11:55:00.000Z',
      },
    })
    const before = deriveCycleOperationsStatus(
      unresolved,
      Date.parse('2026-07-20T11:59:59.999Z'),
      Authority.Observe,
      thresholds,
    )
    const atThreshold = deriveCycleOperationsStatus(unresolved, Date.parse(now), Authority.Observe, thresholds)

    expect(before).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.UnresolvedMutation,
      zeroMutation: false,
      alerts: { cycleFailed: true, unknownMutationStale: false },
    })
    expect(atThreshold).toMatchObject({
      oldestUnresolvedMutationAgeMs: 300_000,
      alerts: { unknownMutationStale: true },
    })

    const cleared = deriveCycleOperationsStatus(projection(), Date.parse(now), Authority.Observe, thresholds)
    expect(cleared).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.NoCycleRecorded,
      alerts: { cycleFailed: false, unknownMutationStale: false },
    })
  })

  test('injects and clears kill, discrepancy, stale-data, and provenance failures through canonical state', () => {
    const observeAuthority = {
      generationHash: '4'.repeat(64),
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Clear,
      reason: null,
      updatedAt: now,
    } as const
    const paperAuthority = {
      ...observeAuthority,
      maximum: Authority.Paper,
      effective: Authority.Paper,
    } as const
    const exactReconciliation = {
      accountId: 'paper-account-1',
      reconciliationId: '5'.repeat(64),
      status: ReconciliationStatus.Exact,
      discrepancyCount: 0,
      reconciledAt: now,
      coversLatestMutation: true,
    } as const
    const observeClear = projection({ authority: observeAuthority })
    const paperClear = projection({ authority: paperAuthority, reconciliation: exactReconciliation })
    const scenarios = [
      {
        name: 'kill',
        maximum: Authority.Observe,
        injected: projection({ authority: { ...observeAuthority, kill: KillState.Active, reason: 'operator kill' } }),
        cleared: observeClear,
        reason: CycleOperationsReason.KillActive,
        terminalReason: null,
      },
      {
        name: 'reconciliation discrepancy',
        maximum: Authority.Paper,
        injected: projection({
          authority: paperAuthority,
          reconciliation: {
            ...exactReconciliation,
            status: ReconciliationStatus.Discrepancy,
            discrepancyCount: 1,
          },
        }),
        cleared: paperClear,
        reason: CycleOperationsReason.ReconciliationDiscrepancy,
        terminalReason: null,
      },
      {
        name: 'stale data',
        maximum: Authority.Observe,
        injected: projection({
          last: snapshot(CycleState.Blocked, { terminalReason: CycleTerminalReason.DataStale }),
        }),
        cleared: projection({ last: snapshot(CycleState.Completed) }),
        reason: CycleOperationsReason.LastCycleBlocked,
        terminalReason: CycleTerminalReason.DataStale,
      },
      {
        name: 'provenance mismatch',
        maximum: Authority.Observe,
        injected: projection({
          last: snapshot(CycleState.Blocked, { terminalReason: CycleTerminalReason.ProvenanceMismatch }),
        }),
        cleared: projection({ last: snapshot(CycleState.Completed) }),
        reason: CycleOperationsReason.LastCycleBlocked,
        terminalReason: CycleTerminalReason.ProvenanceMismatch,
      },
    ] as const

    for (const scenario of scenarios) {
      const injected = deriveCycleOperationsStatus(scenario.injected, Date.parse(now), scenario.maximum, thresholds)
      const cleared = deriveCycleOperationsStatus(scenario.cleared, Date.parse(now), scenario.maximum, thresholds)

      expect(injected.condition, scenario.name).toBe(CycleOperationsCondition.Failed)
      expect(injected.reason, scenario.name).toBe(scenario.reason)
      expect(injected.alerts.cycleFailed, scenario.name).toBe(true)
      expect(injected.last?.terminalReason ?? null, scenario.name).toBe(scenario.terminalReason)
      expect(cleared.condition, scenario.name).toBe(CycleOperationsCondition.Waiting)
      expect(cleared.alerts.cycleFailed, scenario.name).toBe(false)
    }
  })

  test('requires PAPER reconciliation to cover the latest selected-account mutation', () => {
    const authority = {
      generationHash: '4'.repeat(64),
      maximum: Authority.Paper,
      effective: Authority.Paper,
      kill: KillState.Clear,
      reason: null,
      updatedAt: now,
    } as const
    const latestOccurredAt = '2026-07-20T11:59:00.000Z'
    const input = (coversLatestMutation: boolean) =>
      projection({
        authority,
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '8'.repeat(64),
          status: ReconciliationStatus.Exact,
          discrepancyCount: 0,
          reconciledAt: latestOccurredAt,
          coversLatestMutation,
        },
        mutations: {
          eventCount: 2,
          unresolvedCount: 0,
          oldestUnresolvedAt: null,
          latestOccurredAt,
        },
      })
    const covered = deriveCycleOperationsStatus(input(true), Date.parse(now), Authority.Paper, thresholds)
    const predates = deriveCycleOperationsStatus(input(false), Date.parse(now), Authority.Paper, thresholds)

    expect(covered).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.NoCycleRecorded,
      reconciliationCoversLatestMutation: true,
      alerts: { reconciliationBlocked: false },
    })
    expect(predates).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.ReconciliationPredatesMutation,
      reconciliationCoversLatestMutation: false,
      alerts: { reconciliationBlocked: true },
    })
  })

  test('blocks PAPER on discrepancy and exact reconciliation staleness boundaries', () => {
    const authority = {
      generationHash: '4'.repeat(64),
      maximum: Authority.Paper,
      effective: Authority.Paper,
      kill: KillState.Clear,
      reason: null,
      updatedAt: now,
    } as const
    const discrepancy = deriveCycleOperationsStatus(
      projection({
        authority,
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '6'.repeat(64),
          status: ReconciliationStatus.Discrepancy,
          discrepancyCount: 1,
          reconciledAt: now,
          coversLatestMutation: true,
        },
      }),
      Date.parse(now),
      Authority.Paper,
      thresholds,
    )
    const stale = deriveCycleOperationsStatus(
      projection({
        authority,
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '7'.repeat(64),
          status: ReconciliationStatus.Exact,
          discrepancyCount: 0,
          reconciledAt: '2026-07-20T11:58:00.000Z',
          coversLatestMutation: true,
        },
      }),
      Date.parse(now),
      Authority.Paper,
      thresholds,
    )

    expect(discrepancy).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.ReconciliationDiscrepancy,
      alerts: { reconciliationBlocked: true },
    })
    expect(stale).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.ReconciliationStale,
      reconciliationAgeMs: 120_000,
      alerts: { reconciliationBlocked: true },
    })

    const cleared = deriveCycleOperationsStatus(
      projection({
        authority,
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '8'.repeat(64),
          status: ReconciliationStatus.Exact,
          discrepancyCount: 0,
          reconciledAt: now,
          coversLatestMutation: true,
        },
      }),
      Date.parse(now),
      Authority.Paper,
      thresholds,
    )
    expect(cleared).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.NoCycleRecorded,
      alerts: { cycleFailed: false, reconciliationBlocked: false },
    })
  })
})
