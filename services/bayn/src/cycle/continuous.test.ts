import { withProviderSessions } from '../testing/market-calendar-fixture'
import { canonicalHashV1Result } from '../hash'
import { CycleState, CycleTerminalReason } from './model'
import {
  canRearmUnusedCycle,
  makeIntradayCycleDraft,
  nextIntradayEntryAttemptOrdinal,
} from './runner/calendar-decisions'
import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { continuousMarketHours, tradingWindow, continuousExecutionPolicy } from '../market-hours'
import { JevPurpose } from '../jev/portfolio'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../jev/protocol'
import { makeCycleExecutionPolicyFromModel } from './construction'
import { makeInitialCycle } from './store/decisions'
import { bindCycleExecutionSession } from '../execution-session'
import { jevObservationQuery } from '../jev/runtime'

for (const at of ['2026-10-09T23:59:50.000Z', '2026-10-11T00:00:10.000Z']) {
  test(`the current execution lease and signal window survive midnight and weekends at ${at}`, () => {
    const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
    const policy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
    if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') throw new Error('Expected current policy')
    const lease = Result.getOrThrow(
      tradingWindow(continuousMarketHours, at, { ...continuousExecutionPolicy, sessionEntryCutoffMs: 0 }),
    )
    if (lease === null) throw new Error('Continuous market must have a finite lease')
    const draft = Result.getOrThrow(
      makeIntradayCycleDraft(
        {
          cycleBindingId: 'a'.repeat(64),
          strategyName: 'jev',
          strategyProtocolHash: 'b'.repeat(64),
          accountId: 'paper-continuous',
          executionPolicy: policy,
        },
        continuousMarketHours,
        lease,
      ),
    )
    const cycle = makeInitialCycle(draft, at)
    const observedAt = new Date(Date.parse(at) + 20_000).toISOString()
    const binding = Result.getOrThrow(
      bindCycleExecutionSession({
        cycle,
        executionSessionDate: cycle.identity.executionSessionDate,
        planningBrokerState: { observedAt, contentHash: 'c'.repeat(64) },
        calendar: continuousMarketHours,
        executionModel: protocol.executionModel,
      }),
    )
    expect(binding.submissionCutoffAt).toBe(new Date(Date.parse(at) + 60_000).toISOString())
    expect(Date.parse(binding.executionSession.closeAt) - Date.parse(at)).toBe(19 * 60_000)
    const query = Result.getOrThrow(
      jevObservationQuery(cycle, protocol, continuousMarketHours, observedAt, JevPurpose.Entry),
    )
    expect(query.feed).toBe('us')
    expect(query.candidateSymbols).toEqual(['BTC/USD', 'ETH/USD', 'SOL/USD'])
    expect(Date.parse(query.rangeStartAt)).toBeLessThan(Date.parse(cycle.window.executionOpenAt))
    const managementAt = new Date(Date.parse(at) + 120_000).toISOString()
    expect(
      Result.isFailure(jevObservationQuery(cycle, protocol, continuousMarketHours, managementAt, JevPurpose.Entry)),
    ).toBe(true)
    expect(
      Result.getOrThrow(jevObservationQuery(cycle, protocol, continuousMarketHours, managementAt, JevPurpose.Manage))
        .candidateSymbols,
    ).toEqual(['BTC/USD', 'ETH/USD', 'SOL/USD'])
    expect(
      Result.isFailure(
        jevObservationQuery(cycle, protocol, continuousMarketHours, cycle.window.executionCloseAt, JevPurpose.Manage),
      ),
    ).toBe(true)
  })
}

test('completed crypto cycles rearm after their old entry deadline with all crypto candidates', () => {
  const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
  const policy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
  if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') throw new Error('Expected current policy')
  let prior: ReturnType<typeof makeInitialCycle> | undefined
  for (const index of [0, 1, 2, 3]) {
    const at = new Date(Date.parse('2026-10-10T23:40:00.000Z') + index * 20 * 60_000).toISOString()
    const lease = Result.getOrThrow(
      tradingWindow(continuousMarketHours, at, { ...continuousExecutionPolicy, sessionEntryCutoffMs: 0 }),
    )
    if (lease === null) throw new Error('Expected a continuous lease')
    const ordinal = prior === undefined ? 1 : nextIntradayEntryAttemptOrdinal(prior, at, lease.entryCutoffAt)
    expect(ordinal).toBe(index + 1)
    if (ordinal === undefined) throw new Error('Fresh continuous window must rearm')
    const draft = Result.getOrThrow(
      makeIntradayCycleDraft(
        {
          cycleBindingId: 'a'.repeat(64),
          strategyName: 'jev',
          strategyProtocolHash: 'b'.repeat(64),
          accountId: 'paper-continuous',
          executionPolicy: policy,
        },
        continuousMarketHours,
        lease,
        ordinal,
      ),
    )
    const cycle = makeInitialCycle(draft, at)
    const query = Result.getOrThrow(
      jevObservationQuery(
        cycle,
        protocol,
        continuousMarketHours,
        new Date(Date.parse(at) + 3000).toISOString(),
        JevPurpose.Entry,
      ),
    )
    expect(query.candidateSymbols).toEqual(['BTC/USD', 'ETH/USD', 'SOL/USD'])
    if (prior !== undefined) expect(cycle.identity.cycleId).not.toBe(prior.identity.cycleId)
    prior = { ...cycle, state: CycleState.Completed, terminalAt: new Date(Date.parse(at) + 15 * 60_000).toISOString() }
  }
})

test('an unused expired continuous lease rearms under the same approved contract after its deadline and cooldown', () => {
  const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
  const policy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
  if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') throw new Error('Expected current policy')
  const candidate = {
    cycleBindingId: 'a'.repeat(64),
    strategyName: 'jev' as const,
    strategyProtocolHash: 'b'.repeat(64),
    accountId: 'paper-continuous',
    executionPolicy: policy,
  }
  const at = '2026-10-12T14:30:00.000Z'
  const oldWindow = Result.getOrThrow(
    tradingWindow(continuousMarketHours, at, { ...continuousExecutionPolicy, sessionEntryCutoffMs: 0 }),
  )
  if (oldWindow === null) throw new Error('Expected lease')
  const draft = Result.getOrThrow(makeIntradayCycleDraft(candidate, continuousMarketHours, oldWindow))
  const cycle = {
    ...makeInitialCycle(draft, at),
    state: CycleState.Blocked,
    terminalAt: oldWindow.entryCutoffAt,
    terminalReason: CycleTerminalReason.MissedSubmission,
  }
  const nextAt = '2026-10-12T14:32:00.000Z'
  const next = Result.getOrThrow(
    tradingWindow(continuousMarketHours, nextAt, { ...continuousExecutionPolicy, sessionEntryCutoffMs: 0 }),
  )
  if (next === null) throw new Error('Expected successor lease')
  expect(canRearmUnusedCycle(cycle, candidate, continuousMarketHours, next, nextAt)).toBe(true)
  const equitySession = { date: '2026-10-12', openAt: '2026-10-12T13:30:00.000Z', closeAt: '2026-10-12T20:00:00.000Z' }
  const calendarMaterial = withProviderSessions({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v2' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: { start: equitySession.date, end: equitySession.date },
    timeZone: 'UTC' as const,
    sessions: [equitySession],
  })
  const calendar = {
    ...calendarMaterial,
    normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(calendarMaterial)),
  }
  expect(canRearmUnusedCycle(cycle, candidate, calendar, equitySession, nextAt)).toBe(true)
  expect(nextIntradayEntryAttemptOrdinal(cycle, nextAt, next.entryCutoffAt, true)).toBe(2)
  expect(nextIntradayEntryAttemptOrdinal(cycle, '2026-10-12T14:31:59.999Z', next.entryCutoffAt, true)).toBeUndefined()
  expect(canRearmUnusedCycle(cycle, candidate, continuousMarketHours, oldWindow, at)).toBe(false)
  expect(
    canRearmUnusedCycle(cycle, { ...candidate, accountId: 'another-account' }, continuousMarketHours, next, nextAt),
  ).toBe(false)
  expect(
    canRearmUnusedCycle(
      cycle,
      { ...candidate, strategyProtocolHash: 'c'.repeat(64) },
      continuousMarketHours,
      next,
      nextAt,
    ),
  ).toBe(false)
  for (const bindings of [{ snapshotId: 'd'.repeat(64) }, { snapshotId: 'd'.repeat(64), decisionHash: 'e'.repeat(64) }])
    expect(canRearmUnusedCycle({ ...cycle, bindings }, candidate, continuousMarketHours, next, nextAt)).toBe(false)
  for (const terminalReason of [
    CycleTerminalReason.Authority,
    CycleTerminalReason.KillActive,
    CycleTerminalReason.DataInvalid,
  ])
    expect(canRearmUnusedCycle({ ...cycle, terminalReason }, candidate, continuousMarketHours, next, nextAt)).toBe(
      false,
    )
})
