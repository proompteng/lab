import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import {
  CycleState,
  CycleTerminalReason,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  type AutonomousCycle,
  type CycleDraft,
} from './cycle'
import {
  cycleCompletionStateForTargetPlan,
  cycleTerminalReasonForBlockedTargetPlan,
  selectCycleRecovery,
  type CycleRecoverySelection,
  type CycleRecoveryState,
} from './cycle-recovery'
import { canonicalHashV1 } from './hash'
import { makeObserveShadowDecisionDocument, type ObserveShadowDecisionDocument } from './shadow-decision-contract'
import { TargetPlanReason, TargetPlanStatus, type BlockedTargetPlanReason } from './target-planner'

const hash = (character: string): string => character.repeat(64)
const qualificationRunId = hash('1')
const strategyProtocolHash = hash('2')
const accountId = 'paper-account-1'
const snapshotId = hash('3')

const value = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const draft = (signalCalendarVersion = 'XNYS-v1'): CycleDraft => {
  const calendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: '2026-02-02',
      openAt: '2026-02-02T14:30:00.000Z',
      closeAt: '2026-02-02T21:00:00.000Z',
    }),
  )
  const policy = value(
    makeCycleExecutionPolicy({
      schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
      strategyExecutionModelHash: hash('4'),
      submissionWindowMs: 30 * 60_000,
      submissionCutoffBeforeOpenMs: 2 * 60_000,
    }),
  )
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v1',
      strategyName: 'risk-balanced-trend',
      qualificationRunId,
      strategyProtocolHash,
      accountId,
      signalSessionDate: '2026-01-30',
      signalCalendarVersion,
      executionSessionDate: calendar.executionSessionDate,
      executionCalendarSchemaVersion: calendar.executionCalendarSchemaVersion,
      executionCalendarSource: calendar.executionCalendarSource,
      executionCalendarHash: calendar.executionCalendarHash,
      executionPolicy: policy,
    }),
  )
  const window = value(
    makeCycleWindow(
      {
        calendar_version: signalCalendarVersion,
        session_date: '2026-01-30',
        close_time: '16:00',
        timezone: 'America/New_York',
      },
      calendar,
      policy,
    ),
  )
  return value(makeCycleDraft(identity, window))
}

const pendingCycle = (signalCalendarVersion = 'XNYS-v1'): AutonomousCycle => ({
  ...draft(signalCalendarVersion),
  state: CycleState.Pending,
  bindings: {},
  stateVersion: 1,
  createdAt: '2026-01-30T21:15:00.000Z',
  updatedAt: '2026-01-30T21:15:00.000Z',
})

const boundPendingCycle = (): AutonomousCycle => ({
  ...pendingCycle(),
  bindings: { snapshotId },
  stateVersion: 2,
  updatedAt: '2026-01-30T21:16:00.000Z',
})

const activeCycle = (): AutonomousCycle => ({
  ...boundPendingCycle(),
  state: CycleState.Active,
  stateVersion: 3,
  updatedAt: '2026-02-02T13:56:00.000Z',
})

const targetPlan = (
  status: TargetPlanStatus.NoTrade | TargetPlanStatus.Blocked,
  reason: TargetPlanReason.TargetsSatisfied | BlockedTargetPlanReason,
) => {
  const targets =
    status === TargetPlanStatus.NoTrade
      ? [
          {
            symbol: 'AMD',
            targetWeight: 0.5,
            referencePriceMicros: '100000000',
            currentQuantityMicros: '1000000',
            targetQuantityMicros: '1000000',
          },
        ]
      : []
  const material = {
    schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
    inputHash: hash('5'),
    status,
    reason,
    targets,
    intentTargets: [],
    requiredReferenceBuyNotionalMicros: '0',
    availableBuyingPowerMicros: '0',
    residualBuyingPowerMicros: '0',
  }
  return { ...material, outputHash: canonicalHashV1(material) }
}

const decisionDocument = (
  cycle: AutonomousCycle,
  status: TargetPlanStatus.NoTrade | TargetPlanStatus.Blocked = TargetPlanStatus.NoTrade,
  reason: TargetPlanReason.TargetsSatisfied | BlockedTargetPlanReason = TargetPlanReason.TargetsSatisfied,
  createdAt = '2026-02-02T13:59:00.000Z',
): ObserveShadowDecisionDocument =>
  value(
    makeObserveShadowDecisionDocument({
      schemaVersion: 'bayn.observe-shadow-decision.v1',
      mode: 'OBSERVE',
      dispatchable: false,
      bindings: {
        strategyName: cycle.identity.strategyName,
        cycleId: cycle.identity.cycleId,
        strategyProtocolHash: cycle.identity.strategyProtocolHash,
        snapshotId,
        snapshotContentHash: hash('6'),
        snapshotFinalizedAt: cycle.window.signalCloseAt,
        strategyDecisionHash: hash('7'),
        policyHash: hash('8'),
        accountId,
        planningBrokerStateHash: hash('9'),
        reconciliationId: hash('a'),
        reconciliationHash: hash('b'),
      },
      targetPlan: targetPlan(status, reason),
      deltaRisk: [],
      createdAt,
      submissionCutoffAt: cycle.window.submissionCutoffAt,
      expiresAt: cycle.window.submissionCutoffAt,
    }),
  )

const recoveryState = (
  cycle: AutonomousCycle | undefined,
  overrides: Partial<Omit<CycleRecoveryState, 'cycle'>> = {},
): CycleRecoveryState => ({
  qualificationRunId,
  accountId,
  strategyProtocolHash,
  observedAt: '2026-02-02T13:57:00.000Z',
  cycle,
  ...overrides,
})

const select = (state: CycleRecoveryState): CycleRecoverySelection => value(selectCycleRecovery(state))

describe('cycle recovery algebra', () => {
  test('selects every discovery, readiness, activation, waiting, and decision-building action', () => {
    const pending = pendingCycle()
    const bound = boundPendingCycle()
    const active = activeCycle()
    const blockedReadinessCycle: AutonomousCycle = {
      ...pending,
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedPublication,
      terminalAt: pending.window.publicationDeadlineAt,
      updatedAt: pending.window.publicationDeadlineAt,
      stateVersion: 2,
    }

    expect(select(recoveryState(undefined))).toEqual({ action: 'DISCOVER' })
    expect(select(recoveryState(pending))).toEqual({ action: 'READ_PUBLICATION', cycle: pending })
    expect(
      select(
        recoveryState(pending, {
          observedAt: pending.updatedAt,
          readiness: {
            outcome: 'WAITING',
            reason: 'PUBLICATION_MISSING',
            observedAt: pending.updatedAt,
            cycle: pending,
          },
        }),
      ),
    ).toMatchObject({ action: 'RETURN_READINESS', recoveryAction: 'WAITING' })
    expect(
      select(
        recoveryState(pending, {
          readiness: {
            outcome: 'BLOCKED',
            observedAt: blockedReadinessCycle.updatedAt,
            cycle: blockedReadinessCycle,
          },
        }),
      ),
    ).toMatchObject({ action: 'RETURN_READINESS', recoveryAction: 'BLOCKED' })
    expect(
      select(
        recoveryState(pending, {
          observedAt: pending.updatedAt,
          readiness: {
            outcome: 'BOUND',
            observedAt: bound.updatedAt,
            cycle: bound,
            snapshotId,
          },
        }),
      ),
    ).toMatchObject({ action: 'RETURN_READINESS', recoveryAction: 'BOUND_SNAPSHOT' })
    expect(
      select(
        recoveryState(bound, {
          observedAt: bound.updatedAt,
          readiness: {
            outcome: 'ALREADY_BOUND',
            observedAt: bound.updatedAt,
            cycle: bound,
            snapshotId,
          },
        }),
      ),
    ).toEqual({ action: 'ACTIVATE', cycleId: bound.identity.cycleId, observedAt: bound.updatedAt })
    expect(select(recoveryState(active))).toEqual({
      action: 'WAIT',
      cycle: active,
      observedAt: '2026-02-02T13:57:00.000Z',
    })
    expect(
      select(
        recoveryState(active, {
          observedAt: active.window.submissionOpenAt,
        }),
      ),
    ).toEqual({ action: 'BUILD_DECISION', cycle: active })
  })

  test('preserves deadline, protocol, and decision-bound precedence and both completion states', () => {
    const pending = pendingCycle()
    const active = activeCycle()
    expect(
      select(
        recoveryState(pending, {
          observedAt: pending.window.publicationDeadlineAt,
          strategyProtocolHash: hash('f'),
        }),
      ),
    ).toMatchObject({ action: 'BLOCK', reason: CycleTerminalReason.MissedPublication })
    expect(
      select(
        recoveryState(active, {
          observedAt: active.window.submissionCutoffAt,
          strategyProtocolHash: hash('f'),
        }),
      ),
    ).toMatchObject({ action: 'BLOCK', reason: CycleTerminalReason.MissedSubmission })
    expect(select(recoveryState(active, { strategyProtocolHash: hash('f') }))).toMatchObject({
      action: 'BLOCK',
      reason: CycleTerminalReason.ProvenanceMismatch,
    })

    const noTrade = decisionDocument(active)
    const decisionBound: AutonomousCycle = {
      ...active,
      bindings: { snapshotId, decisionHash: noTrade.contentHash },
      updatedAt: '2026-02-02T14:01:00.000Z',
      stateVersion: 4,
    }
    const afterCutoff = '2026-02-02T14:29:00.000Z'
    expect(
      select(
        recoveryState(decisionBound, {
          observedAt: afterCutoff,
          strategyProtocolHash: hash('f'),
        }),
      ),
    ).toEqual({ action: 'READ_DECISION', cycle: decisionBound })
    expect(
      select(
        recoveryState(decisionBound, {
          observedAt: afterCutoff,
          strategyProtocolHash: hash('f'),
          decisionDocument: noTrade,
        }),
      ),
    ).toMatchObject({ action: 'FINISH', state: CycleState.NoTrade })
    expect(cycleCompletionStateForTargetPlan(TargetPlanStatus.Planned)).toBe(CycleState.Completed)
    expect(cycleCompletionStateForTargetPlan(TargetPlanStatus.NoTrade)).toBe(CycleState.NoTrade)

    const blocked = decisionDocument(active, TargetPlanStatus.Blocked, TargetPlanReason.InputStale)
    const blockedBound: AutonomousCycle = {
      ...decisionBound,
      bindings: { snapshotId, decisionHash: blocked.contentHash },
    }
    expect(
      select(
        recoveryState(blockedBound, {
          observedAt: afterCutoff,
          strategyProtocolHash: hash('f'),
          decisionDocument: blocked,
        }),
      ),
    ).toMatchObject({ action: 'BLOCK', reason: CycleTerminalReason.DataStale })
  })

  test('uses the freshest correlated readiness observation for activation and submission cutoff precedence', () => {
    const bound = boundPendingCycle()
    expect(bound.window.publicationDeadlineAt).toBe('2026-02-02T13:58:00.000Z')
    expect(bound.window.submissionCutoffAt).toBe('2026-02-02T14:28:00.000Z')

    const at = (readinessObservedAt: string): CycleRecoverySelection =>
      select(
        recoveryState(bound, {
          observedAt: '2026-02-02T13:57:00.000Z',
          readiness: {
            outcome: 'ALREADY_BOUND',
            observedAt: readinessObservedAt,
            cycle: bound,
            snapshotId,
          },
        }),
      )

    expect(at('2026-02-02T14:27:59.999Z')).toEqual({
      action: 'ACTIVATE',
      cycleId: bound.identity.cycleId,
      observedAt: '2026-02-02T14:27:59.999Z',
    })
    expect(at(bound.window.submissionCutoffAt)).toEqual({
      action: 'BLOCK',
      cycleId: bound.identity.cycleId,
      observedAt: bound.window.submissionCutoffAt,
      reason: CycleTerminalReason.MissedSubmission,
    })
    expect(at('2026-02-02T14:29:00.000Z')).toEqual({
      action: 'BLOCK',
      cycleId: bound.identity.cycleId,
      observedAt: '2026-02-02T14:29:00.000Z',
      reason: CycleTerminalReason.MissedSubmission,
    })
  })

  test('rejects a concurrent snapshot binding that became effective at or after the publication deadline', () => {
    const pending = pendingCycle()
    const selectConcurrentBinding = (bindingEffectiveAt: string, observedAt: string): CycleRecoverySelection => {
      const concurrentlyBound: AutonomousCycle = {
        ...pending,
        bindings: { snapshotId },
        stateVersion: pending.stateVersion + 1,
        updatedAt: bindingEffectiveAt,
      }
      return select(
        recoveryState(pending, {
          observedAt: '2026-02-02T13:57:00.000Z',
          readiness: {
            outcome: 'ALREADY_BOUND',
            observedAt,
            cycle: concurrentlyBound,
            snapshotId,
          },
        }),
      )
    }

    expect(selectConcurrentBinding('2026-02-02T13:57:59.999Z', '2026-02-02T14:00:00.000Z')).toMatchObject({
      action: 'ACTIVATE',
    })
    for (const bindingEffectiveAt of ['2026-02-02T13:58:00.000Z', '2026-02-02T13:58:00.001Z']) {
      expect(selectConcurrentBinding(bindingEffectiveAt, '2026-02-02T14:00:00.000Z')).toEqual({
        action: 'BLOCK',
        cycleId: pending.identity.cycleId,
        observedAt: '2026-02-02T14:00:00.000Z',
        reason: CycleTerminalReason.MissedPublication,
      })
    }
  })

  test('rejects stale recovery and readiness observations before the selected cycle update', () => {
    const active = activeCycle()
    const staleState = selectCycleRecovery(
      recoveryState(active, {
        observedAt: '2026-02-02T13:55:59.999Z',
      }),
    )
    expect(Result.isFailure(staleState)).toBe(true)
    if (Result.isFailure(staleState)) {
      expect(staleState.failure).toMatchObject({
        operation: 'select',
        reason: 'chronology',
        facts: {
          actualObservedAt: '2026-02-02T13:55:59.999Z',
          expectedMinimumObservedAt: active.updatedAt,
        },
      })
    }

    const pending = pendingCycle()
    const staleReadiness = selectCycleRecovery(
      recoveryState(pending, {
        readiness: {
          outcome: 'WAITING',
          reason: 'PUBLICATION_MISSING',
          observedAt: '2026-01-30T21:14:59.999Z',
          cycle: pending,
        },
      }),
    )
    expect(Result.isFailure(staleReadiness)).toBe(true)
    if (Result.isFailure(staleReadiness)) {
      expect(staleReadiness.failure).toMatchObject({
        operation: 'select',
        reason: 'readiness-binding',
        facts: {
          selectedUpdatedAt: pending.updatedAt,
          readinessObservedAt: '2026-01-30T21:14:59.999Z',
        },
      })
    }

    const readinessBeforeRecovery = selectCycleRecovery(
      recoveryState(pending, {
        observedAt: '2026-01-30T21:16:00.000Z',
        readiness: {
          outcome: 'WAITING',
          reason: 'PUBLICATION_MISSING',
          observedAt: pending.updatedAt,
          cycle: pending,
        },
      }),
    )
    expect(Result.isFailure(readinessBeforeRecovery)).toBe(true)
    if (Result.isFailure(readinessBeforeRecovery)) {
      expect(readinessBeforeRecovery.failure).toMatchObject({
        operation: 'select',
        reason: 'readiness-binding',
        facts: {
          expectedMinimumReadinessObservedAt: '2026-01-30T21:16:00.000Z',
          actualReadinessObservedAt: pending.updatedAt,
        },
      })
    }
  })

  test('rejects adversarial readiness snapshots, drafts, states, and version transitions', () => {
    const pending = pendingCycle()
    const bound = boundPendingCycle()
    const blocked: AutonomousCycle = {
      ...pending,
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedPublication,
      terminalAt: pending.window.publicationDeadlineAt,
      updatedAt: pending.window.publicationDeadlineAt,
      stateVersion: pending.stateVersion + 1,
    }
    const differentDraftBound: AutonomousCycle = {
      ...bound,
      window: {
        ...bound.window,
        signalCloseAt: '2026-01-30T20:59:00.000Z',
      },
    }
    const wrongSnapshotBound: AutonomousCycle = {
      ...bound,
      bindings: { snapshotId: hash('c') },
    }
    const cases = [
      {
        selected: pending,
        readiness: {
          outcome: 'BOUND',
          observedAt: bound.updatedAt,
          cycle: differentDraftBound,
          snapshotId,
        } as const,
      },
      {
        selected: pending,
        readiness: {
          outcome: 'BOUND',
          observedAt: bound.updatedAt,
          cycle: { ...bound, stateVersion: bound.stateVersion + 1 },
          snapshotId,
        } as const,
      },
      {
        selected: bound,
        readiness: {
          outcome: 'ALREADY_BOUND',
          observedAt: bound.updatedAt,
          cycle: wrongSnapshotBound,
          snapshotId: hash('c'),
        } as const,
      },
      {
        selected: pending,
        readiness: {
          outcome: 'BLOCKED',
          observedAt: blocked.updatedAt,
          cycle: pending,
        } as const,
      },
    ]

    for (const { readiness, selected } of cases) {
      const result = selectCycleRecovery(recoveryState(selected, { observedAt: selected.updatedAt, readiness }))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          operation: 'select',
          reason: 'readiness-binding',
        })
        expect(result.failure.facts).toMatchObject({
          expectedAccountId: selected.identity.accountId,
          actualAccountId: readiness.cycle.identity.accountId,
          expectedCycleId: selected.identity.cycleId,
          actualCycleId: readiness.cycle.identity.cycleId,
          expectedSubmissionCutoffAt: selected.window.submissionCutoffAt,
          actualSubmissionCutoffAt: readiness.cycle.window.submissionCutoffAt,
          selectedStateVersion: selected.stateVersion,
          actualStateVersion: readiness.cycle.stateVersion,
        })
      }
    }
  })

  test('rejects decision documents created before cycle creation or the submission window', () => {
    const active = activeCycle()
    const beforeCycleCreation = decisionDocument(
      active,
      TargetPlanStatus.NoTrade,
      TargetPlanReason.TargetsSatisfied,
      '2026-01-30T21:14:59.999Z',
    )
    const beforeSubmissionOpen = decisionDocument(
      active,
      TargetPlanStatus.Blocked,
      TargetPlanReason.InputStale,
      '2026-02-02T13:57:59.999Z',
    )
    const cases = [beforeCycleCreation, beforeSubmissionOpen]

    for (const document of cases) {
      const decisionBound: AutonomousCycle = {
        ...active,
        bindings: { snapshotId, decisionHash: document.contentHash },
        updatedAt: '2026-02-02T14:01:00.000Z',
        stateVersion: active.stateVersion + 1,
      }
      const result = selectCycleRecovery(
        recoveryState(decisionBound, {
          observedAt: decisionBound.updatedAt,
          decisionDocument: document,
        }),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          operation: 'validate-decision',
          reason: 'decision-binding',
          facts: {
            expectedAccountId: active.identity.accountId,
            actualAccountId: document.bindings.accountId,
            expectedCycleId: active.identity.cycleId,
            actualCycleId: document.bindings.cycleId,
            expectedSubmissionCutoffAt: active.window.submissionCutoffAt,
            actualSubmissionCutoffAt: document.submissionCutoffAt,
            actualDocumentCreatedAt: document.createdAt,
            minimumCycleCreatedAt: active.createdAt,
            minimumSubmissionOpenAt: active.window.submissionOpenAt,
          },
        })
      }
    }
  })

  test('maps the closed blocked-reason algebra exhaustively', () => {
    const cases: ReadonlyArray<readonly [BlockedTargetPlanReason, CycleTerminalReason]> = [
      [TargetPlanReason.SubmissionCutoffReached, CycleTerminalReason.MissedSubmission],
      [TargetPlanReason.IdentityMismatch, CycleTerminalReason.ProvenanceMismatch],
      [TargetPlanReason.InputMismatch, CycleTerminalReason.DataInvalid],
      [TargetPlanReason.InputStale, CycleTerminalReason.DataStale],
      [TargetPlanReason.ReconciliationNotExact, CycleTerminalReason.Reconciliation],
      [TargetPlanReason.AccountNotActive, CycleTerminalReason.BrokerDisabled],
      [TargetPlanReason.UnknownOrder, CycleTerminalReason.UnresolvedMutation],
      [TargetPlanReason.UnresolvedOrder, CycleTerminalReason.UnresolvedMutation],
      [TargetPlanReason.BelowMinimumBuyNotional, CycleTerminalReason.Risk],
      [TargetPlanReason.InsufficientBuyingPower, CycleTerminalReason.Risk],
      [TargetPlanReason.NonPositiveEquity, CycleTerminalReason.Risk],
      [TargetPlanReason.ShortPositionNotAllowed, CycleTerminalReason.Risk],
    ]
    expect(cases.map(([reason]) => cycleTerminalReasonForBlockedTargetPlan(reason))).toEqual(
      cases.map(([_, terminalReason]) => terminalReason),
    )
  })

  test('returns tagged failures for every reachable recovery-state contradiction', () => {
    const pending = pendingCycle()
    const otherPending = pendingCycle('XNYS-v2')
    const otherBound: AutonomousCycle = {
      ...pending,
      bindings: { snapshotId: hash('c') },
      stateVersion: 2,
      updatedAt: '2026-01-30T21:16:00.000Z',
    }
    const active = activeCycle()
    const document = decisionDocument(active)
    const otherDocument = decisionDocument(active, TargetPlanStatus.Blocked, TargetPlanReason.InputStale)
    const decisionBound: AutonomousCycle = {
      ...active,
      bindings: { snapshotId, decisionHash: document.contentHash },
      updatedAt: '2026-02-02T14:01:00.000Z',
      stateVersion: 4,
    }
    const cases: ReadonlyArray<readonly [unknown, string, string]> = [
      [{}, 'decode-state', 'decode'],
      [{ ...recoveryState(undefined), readiness: { outcome: 'WAITING' } }, 'decode-state', 'decode'],
      [
        recoveryState(undefined, {
          readiness: {
            outcome: 'WAITING',
            reason: 'PUBLICATION_MISSING',
            observedAt: pending.updatedAt,
            cycle: pending,
          },
        }),
        'select',
        'evidence-without-cycle',
      ],
      [recoveryState(pending, { accountId: 'another-account' }), 'select', 'scope'],
      [
        recoveryState({
          ...pending,
          state: CycleState.Blocked,
          terminalReason: CycleTerminalReason.MissedPublication,
          terminalAt: pending.updatedAt,
        }),
        'select',
        'terminal-cycle',
      ],
      [
        recoveryState(active, {
          readiness: {
            outcome: 'WAITING',
            reason: 'PUBLICATION_MISSING',
            observedAt: pending.updatedAt,
            cycle: pending,
          },
        }),
        'select',
        'state-evidence',
      ],
      [recoveryState(active, { decisionDocument: document }), 'select', 'state-evidence'],
      [recoveryState(pending, { decisionDocument: document }), 'select', 'state-evidence'],
      [
        recoveryState(decisionBound, { observedAt: decisionBound.updatedAt, decisionDocument: null }),
        'select',
        'decision-missing',
      ],
      [
        recoveryState(decisionBound, {
          observedAt: decisionBound.updatedAt,
          decisionDocument: otherDocument,
        }),
        'validate-decision',
        'decision-binding',
      ],
      [
        recoveryState(pending, {
          readiness: {
            outcome: 'WAITING',
            reason: 'PUBLICATION_MISSING',
            observedAt: otherPending.updatedAt,
            cycle: otherPending,
          },
        }),
        'select',
        'readiness-binding',
      ],
      [
        recoveryState(pending, {
          readiness: {
            outcome: 'BOUND',
            observedAt: otherBound.updatedAt,
            cycle: otherBound,
            snapshotId,
          },
        }),
        'select',
        'readiness-binding',
      ],
    ]

    for (const [state, operation, reason] of cases) {
      const result = selectCycleRecovery(state)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ _tag: 'CycleRecoveryFailure', operation, reason })
      }
    }
  })
})
