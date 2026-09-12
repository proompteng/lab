import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { decodeIntradayReplayInput, type IntradayReplayInput } from './model'

const input = {
  schemaVersion: 'bayn.intraday-replay-input.v2',
  operationalTiming: {
    decisionReadMs: 0,
    decisionComputeMs: 0,
    planningReadMs: 0,
    planningComputeMs: 0,
    commitMs: 0,
    submissionMs: 0,
  },
  range: { start: '2026-09-04', end: '2026-09-04' },
  calendar: [{ date: '2026-09-04', open: '09:30', close: '16:00' }],
  initialCapitalMicros: '100000000000',
  allocationCapitalMicros: '100000000000',
  assumptions: {
    pollIntervalMs: 30_000,
    firstPollDelayMs: 2_000,
    orderLatencyMs: 100,
    availableLiquidityPpm: 1_000_000,
    slippageBps: 0,
    feeMultiplierPpm: 1_000_000,
  },
} satisfies IntradayReplayInput

describe('intraday replay input boundary', () => {
  test('requires declared operational stages and admits venue delays longer than one second', () => {
    const { operationalTiming: _timing, ...missingTiming } = input
    expect(Result.isFailure(decodeIntradayReplayInput(missingTiming))).toBe(true)
    expect(
      Result.isFailure(decodeIntradayReplayInput({ ...input, schemaVersion: 'bayn.intraday-replay-input.v1' })),
    ).toBe(true)
    expect(
      Result.isSuccess(
        decodeIntradayReplayInput({ ...input, assumptions: { ...input.assumptions, orderLatencyMs: 10_000 } }),
      ),
    ).toBe(true)
    for (const duration of [-1, 0.5, 300_001]) {
      expect(
        Result.isFailure(
          decodeIntradayReplayInput({
            ...input,
            operationalTiming: { ...input.operationalTiming, commitMs: duration },
          }),
        ),
      ).toBe(true)
    }
  })

  test('accepts explicit capital, calendar, and causal execution assumptions', () => {
    expect(Result.getOrThrow(decodeIntradayReplayInput(input))).toEqual(input)
  })

  test('accepts provider calendar extensions while retaining the regular-session contract', () => {
    const result = decodeIntradayReplayInput({
      ...input,
      calendar: input.calendar.map((session) => ({
        ...session,
        session_open: '0400',
        session_close: '2000',
        settlement_date: '2026-09-08',
      })),
    })
    expect(Result.getOrThrow(result).calendar).toEqual(input.calendar)
  })

  test('rejects widened calendar ranges and capital that implies borrowing', () => {
    for (const invalid of [
      { ...input, range: { start: '2026-08-01', end: '2026-09-04' } },
      { ...input, range: { start: '2026-09-05', end: '2026-09-04' } },
      { ...input, allocationCapitalMicros: '100000000001' },
      { ...input, initialCapitalMicros: '0' },
      { ...input, initialCapitalMicros: '100000000000.1' },
    ]) {
      expect(Result.isFailure(decodeIntradayReplayInput(invalid))).toBe(true)
    }
  })

  test('rejects assumptions that bypass delay, liquidity, fee, or cadence limits', () => {
    for (const assumptions of [
      { ...input.assumptions, pollIntervalMs: 1 },
      { ...input.assumptions, firstPollDelayMs: 1_999 },
      { ...input.assumptions, firstPollDelayMs: 32_000 },
      { ...input.assumptions, orderLatencyMs: 0 },
      { ...input.assumptions, orderLatencyMs: 60_001 },
      { ...input.assumptions, availableLiquidityPpm: 1_000_001 },
      { ...input.assumptions, slippageBps: -1 },
      { ...input.assumptions, feeMultiplierPpm: 999_999 },
    ]) {
      expect(Result.isFailure(decodeIntradayReplayInput({ ...input, assumptions }))).toBe(true)
    }
  })

  test('rejects undeclared execution options rather than silently discarding them', () => {
    expect(Result.isFailure(decodeIntradayReplayInput({ ...input, forceFullFill: true }))).toBe(true)
    expect(
      Result.isFailure(
        decodeIntradayReplayInput({ ...input, assumptions: { ...input.assumptions, ignoreFees: true } }),
      ),
    ).toBe(true)
  })
})
