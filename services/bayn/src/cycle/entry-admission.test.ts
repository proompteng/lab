import { withProviderSessions } from '../testing/market-calendar-fixture'
import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { continuousExecutionPolicy, continuousMarketHours, tradingWindow } from '../market-hours'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../jev/protocol'
import { makeCycleExecutionPolicyFromModel } from './construction'
import { unusedEntryExpiresAt } from './entry-admission'
import { CycleState, CycleTerminalReason } from './model'
import { selectCycleRecovery } from './runner/recovery-selection'
import {
  canRearmUnusedCycle,
  makeIntradayCycleDraft,
  nextIntradayEntryAttemptOrdinal,
} from './runner/calendar-decisions'
import { decideActivation, decideBlock, makeInitialCycle } from './store/decisions'

const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
const policy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') throw new Error('Expected active policy')
const candidate = {
  cycleBindingId: 'a'.repeat(64),
  strategyName: 'jev' as const,
  strategyProtocolHash: 'b'.repeat(64),
  accountId: 'shared-paper',
  executionPolicy: policy,
}
const session = { date: '2026-10-14', openAt: '2026-10-14T13:30:00.000Z', closeAt: '2026-10-14T20:00:00.000Z' }
const material = withProviderSessions({
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v2' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: session.date, end: session.date },
  timeZone: 'UTC' as const,
  sessions: [session],
})
const calendar = { ...material, normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(material)) }
const at = '2026-10-14T17:18:26.335Z'
const expiresAt = '2026-10-14T17:19:26.335Z'
const active = {
  ...makeInitialCycle(Result.getOrThrow(makeIntradayCycleDraft(candidate, calendar, session)), at),
  state: CycleState.Active,
  stateVersion: 2,
}
const recovery = (observedAt: string, cycle = active) =>
  selectCycleRecovery({
    cycleBindingId: candidate.cycleBindingId,
    accountId: candidate.accountId,
    strategyProtocolHash: candidate.strategyProtocolHash,
    observedAt,
    cycle,
  })

test('an unused equity admission expires after one minute while its exchange session remains open', () => {
  expect(unusedEntryExpiresAt(active)).toBe(Date.parse(expiresAt))
  expect(Result.getOrThrow(recovery('2026-10-14T17:19:26.334Z'))).toEqual({ action: 'BUILD_DECISION', cycle: active })
  expect(Result.getOrThrow(recovery(expiresAt))).toEqual({
    action: 'BLOCK',
    cycleId: active.identity.cycleId,
    observedAt: expiresAt,
    reason: CycleTerminalReason.UnusedEntryExpired,
  })
  expect(active.window.submissionCutoffAt).toBe('2026-10-14T19:55:00.000Z')
})

test('unused-entry expiry cannot consume a bound decision or precede the executable window', () => {
  const bound = { ...active, bindings: { snapshotId: 'c'.repeat(64), decisionHash: 'd'.repeat(64) } }
  expect(Result.getOrThrow(recovery('2026-10-14T17:28:26.335Z', bound))).toEqual({
    action: 'READ_DECISION',
    cycle: bound,
  })
  expect(Result.isFailure(decideBlock(bound, CycleTerminalReason.UnusedEntryExpired, expiresAt))).toBe(true)
  expect(
    Result.isFailure(decideBlock(active, CycleTerminalReason.UnusedEntryExpired, '2026-10-14T17:19:26.334Z')),
  ).toBe(true)
  expect(Result.getOrThrow(decideBlock(active, CycleTerminalReason.UnusedEntryExpired, expiresAt))._tag).toBe('Persist')
  const beforeOpen = { ...active, createdAt: '2026-10-14T13:00:00.000Z' }
  expect(unusedEntryExpiresAt(beforeOpen)).toBe(Date.parse(beforeOpen.window.submissionOpenAt) + 60_000)
})

test('an expired unused equity slot releases to crypto under the same approved contract after cooldown', () => {
  const blocked = {
    ...active,
    state: CycleState.Blocked,
    stateVersion: 3,
    terminalAt: expiresAt,
    updatedAt: expiresAt,
    terminalReason: CycleTerminalReason.UnusedEntryExpired,
  }
  const nextAt = '2026-10-14T17:20:26.335Z'
  const next = Result.getOrThrow(
    tradingWindow(continuousMarketHours, nextAt, { ...continuousExecutionPolicy, sessionEntryCutoffMs: 0 }),
  )
  if (next === null) throw new Error('Expected continuous window')
  expect(canRearmUnusedCycle(blocked, candidate, continuousMarketHours, next, nextAt)).toBe(true)
  expect(nextIntradayEntryAttemptOrdinal(blocked, nextAt, next.entryCutoffAt, true)).toBe(2)
  expect(nextIntradayEntryAttemptOrdinal(blocked, '2026-10-14T17:20:26.334Z', next.entryCutoffAt, true)).toBeUndefined()
  expect(canRearmUnusedCycle(blocked, { ...candidate, accountId: 'other' }, continuousMarketHours, next, nextAt)).toBe(
    false,
  )
  expect(
    canRearmUnusedCycle(
      { ...blocked, bindings: { snapshotId: 'c'.repeat(64) } },
      candidate,
      continuousMarketHours,
      next,
      nextAt,
    ),
  ).toBe(false)
})

test.each([CycleState.Pending, CycleState.Active])(
  'unused %s recovery retains expiry classification at cutoff',
  (state) => {
    const beforeCutoff = '2026-10-14T19:54:59.000Z'
    const cutoffAt = active.window.submissionCutoffAt
    const cycle = { ...active, state, createdAt: beforeCutoff, updatedAt: beforeCutoff }
    expect(unusedEntryExpiresAt(cycle)).toBe(Date.parse(cutoffAt))
    for (const observedAt of [cutoffAt, '2026-10-14T19:55:00.001Z']) {
      expect(Result.getOrThrow(recovery(observedAt, cycle))).toMatchObject({
        action: 'BLOCK',
        reason: CycleTerminalReason.UnusedEntryExpired,
      })
    }
    if (state === CycleState.Pending) {
      expect(Result.getOrThrow(decideActivation(cycle, beforeCutoff))._tag).toBe('Persist')
      expect(Result.getOrThrow(decideActivation(cycle, cutoffAt))).toMatchObject({
        _tag: 'Block',
        reason: CycleTerminalReason.UnusedEntryExpired,
      })
    }
  },
)

test('cutoff expiry preserves provenance, snapshot evidence and bound-decision recovery', () => {
  for (const observedAt of [expiresAt, active.window.submissionCutoffAt]) {
    const changed = selectCycleRecovery({
      cycleBindingId: candidate.cycleBindingId,
      accountId: candidate.accountId,
      strategyProtocolHash: 'f'.repeat(64),
      observedAt,
      cycle: active,
    })
    expect(Result.getOrThrow(changed)).toMatchObject({
      action: 'BLOCK',
      reason: observedAt === expiresAt ? CycleTerminalReason.ProvenanceMismatch : CycleTerminalReason.MissedSubmission,
    })
  }
  const snapshotBound = { ...active, bindings: { snapshotId: 'c'.repeat(64) } }
  expect(Result.getOrThrow(recovery(active.window.submissionCutoffAt, snapshotBound))).toMatchObject({
    action: 'BLOCK',
    reason: CycleTerminalReason.MissedSubmission,
  })
  const bound = { ...snapshotBound, bindings: { ...snapshotBound.bindings, decisionHash: 'd'.repeat(64) } }
  expect(Result.getOrThrow(recovery(active.window.submissionCutoffAt, bound))).toEqual({
    action: 'READ_DECISION',
    cycle: bound,
  })
})
