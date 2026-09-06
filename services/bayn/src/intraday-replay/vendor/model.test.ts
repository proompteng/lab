import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { decodeVendorReplayInput } from './model'

const input = {
  schemaVersion: 'bayn.vendor-intraday-replay-input.v1',
  experimentPlanHash: 'a'.repeat(64),
  strategyProtocolHash: 'b'.repeat(64),
  behaviorHash: 'c'.repeat(64),
  parameterHash: 'd'.repeat(64),
  riskPolicyHash: 'e'.repeat(64),
  range: { start: '2026-06-02', end: '2026-08-28' },
  calendar: [{ date: '2026-06-02', open: '09:30', close: '16:00', settlement_date: '2026-06-03' }],
  initialCapitalMicros: '100000000000',
  allocationCapitalMicros: '100000000000',
  scenarios: [
    {
      name: 'baseline',
      assumptions: {
        pollIntervalMs: 30000,
        firstPollDelayMs: 2000,
        orderLatencyMs: 100,
        availableLiquidityPpm: 1000000,
        slippageBps: 0,
        feeMultiplierPpm: 1000000,
      },
    },
  ],
}

test('accepts a bounded multi-month calendar export with provider response extras only', () => {
  const result = decodeVendorReplayInput(input)
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result))
    expect(result.success.calendar[0]).toEqual({ date: '2026-06-02', open: '09:30', close: '16:00' })
  expect(Result.isFailure(decodeVendorReplayInput({ ...input, permitLive: true }))).toBe(true)
})

test('rejects duplicate scenarios, invalid date bounds, and excess capital before data access', () => {
  expect(
    Result.isFailure(decodeVendorReplayInput({ ...input, scenarios: [...input.scenarios, ...input.scenarios] })),
  ).toBe(true)
  expect(
    Result.isFailure(decodeVendorReplayInput({ ...input, range: { start: '2026-08-28', end: '2026-06-02' } })),
  ).toBe(true)
  expect(
    Result.isFailure(decodeVendorReplayInput({ ...input, range: { start: '2026-01-01', end: '2026-08-28' } })),
  ).toBe(true)
  expect(Result.isFailure(decodeVendorReplayInput({ ...input, allocationCapitalMicros: '100000000001' }))).toBe(true)
})
