import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { resolveExecutionCycleCloseWindow } from './execution-window'

const mandateWindow = {
  mandateForceCloseAt: '2026-09-01T13:30:00.000Z',
  mandateCloseSubmitCutoffAt: '2026-09-03T20:00:00.000Z',
  mandateCloseExpiresAt: '2026-09-03T20:15:00.000Z',
} as const

describe('execution-cycle close windows', () => {
  test('closes an intraday cycle one hour before its session ends', () => {
    expect(
      Result.getOrThrow(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: '2026-08-19T20:00:00.000Z',
          ...mandateWindow,
        }),
      ),
    ).toEqual({
      startAt: '2026-08-19T19:00:00.000Z',
      submitCutoffAt: '2026-08-19T19:45:00.000Z',
      expiresAt: '2026-08-19T20:00:00.000Z',
    })
  })

  test('uses strategy-bound close leads for an intraday cycle', () => {
    expect(
      Result.getOrThrow(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: '2026-08-19T20:00:00.000Z',
          sessionCloseStartLeadMs: 30 * 60_000,
          sessionCloseSubmitLeadMs: 15 * 60_000,
          ...mandateWindow,
        }),
      ),
    ).toEqual({
      startAt: '2026-08-19T19:30:00.000Z',
      submitCutoffAt: '2026-08-19T19:45:00.000Z',
      expiresAt: '2026-08-19T20:00:00.000Z',
    })
  })

  test('forces flattening at the global entry cutoff instead of extending to the daily close window', () => {
    expect(
      Result.getOrThrow(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: '2026-09-01T20:00:00.000Z',
          mandateForceCloseAt: '2026-09-01T13:30:00.000Z',
          mandateCloseSubmitCutoffAt: '2026-09-01T19:30:00.000Z',
          mandateCloseExpiresAt: '2026-09-01T19:50:00.000Z',
        }),
      ),
    ).toEqual({
      startAt: '2026-09-01T13:30:00.000Z',
      submitCutoffAt: '2026-09-01T19:30:00.000Z',
      expiresAt: '2026-09-01T19:50:00.000Z',
    })
  })

  test('rejects malformed close instants and empty bounded windows', () => {
    expect(
      Result.isFailure(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: 'invalid',
          ...mandateWindow,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: '2026-08-19T20:00:00.000Z',
          ...mandateWindow,
          mandateCloseExpiresAt: 'invalid',
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: '2026-08-19T20:00:00.000Z',
          mandateForceCloseAt: '2026-08-19T19:50:00.000Z',
          mandateCloseSubmitCutoffAt: '2026-08-19T18:50:00.000Z',
          mandateCloseExpiresAt: '2026-08-19T18:55:00.000Z',
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: '2026-08-19T20:00:00.000Z',
          sessionCloseStartLeadMs: 15 * 60_000,
          sessionCloseSubmitLeadMs: 30 * 60_000,
          ...mandateWindow,
        }),
      ),
    ).toBe(true)
  })
})
