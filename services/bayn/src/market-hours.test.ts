import { accountTradingDate } from './time'
import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { continuousMarketHours, MarketSchedule, tradingWindow } from './market-hours'

const policy = {
  entryValidityMs: 60_000,
  maximumHoldingMs: 15 * 60_000,
  closeRecoveryMs: 180_000,
  sessionEntryCutoffMs: 300_000,
}

test('continuous admission has no midnight, weekend, or equity closing-bell gap', () => {
  for (const observedAt of ['2026-10-16T23:59:59.000Z', '2026-10-17T00:00:00.000Z', '2026-10-18T20:01:00.000Z']) {
    const window = Result.getOrThrow(tradingWindow(continuousMarketHours, observedAt, policy))
    expect(window?.schedule).toBe(MarketSchedule.Continuous)
    expect(window?.openAt).toBe(observedAt)
    expect(Date.parse(window?.entryCutoffAt ?? '') - Date.parse(observedAt)).toBe(60_000)
    expect(Date.parse(window?.closeAt ?? '') - Date.parse(observedAt)).toBe(19 * 60_000)
  }
})

test('continuous leases bound order and position recovery without inventing an exchange calendar', () => {
  const before = Result.getOrThrow(tradingWindow(continuousMarketHours, '2026-10-16T23:59:59.000Z', policy))
  const after = Result.getOrThrow(tradingWindow(continuousMarketHours, '2026-10-17T00:00:00.000Z', policy))
  expect(before?.closeAt).toBe('2026-10-17T00:18:59.000Z')
  expect(after?.closeAt).toBe('2026-10-17T00:19:00.000Z')
  expect(Result.isFailure(tradingWindow(continuousMarketHours, 'invalid', policy))).toBe(true)
  expect(
    Result.isFailure(
      tradingWindow(continuousMarketHours, '2026-10-17T00:00:00.000Z', { ...policy, maximumHoldingMs: 0 }),
    ),
  ).toBe(true)
})

test('the account risk day changes at New York midnight across UTC midnight and daylight saving', () => {
  expect(accountTradingDate('2026-10-17T00:00:00.000Z')).toBe('2026-10-16')
  expect(accountTradingDate('2026-10-17T03:59:59.999Z')).toBe('2026-10-16')
  expect(accountTradingDate('2026-10-17T04:00:00.000Z')).toBe('2026-10-17')
  expect(accountTradingDate('2026-11-02T04:59:59.999Z')).toBe('2026-11-01')
  expect(accountTradingDate('2026-11-02T05:00:00.000Z')).toBe('2026-11-02')
})
