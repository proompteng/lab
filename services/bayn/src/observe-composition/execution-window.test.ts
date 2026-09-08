import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { resolveExecutionCycleCloseWindow } from './execution-window'

describe('execution-cycle close windows', () => {
  test('derives a bounded close window from every trading session', () => {
    expect(
      Result.getOrThrow(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: '2026-09-04T20:00:00.000Z',
        }),
      ),
    ).toEqual({
      startAt: '2026-09-04T19:00:00.000Z',
      submitCutoffAt: '2026-09-04T19:45:00.000Z',
      expiresAt: '2026-09-04T20:00:00.000Z',
    })
  })

  test('closes an intraday cycle one hour before its session ends', () => {
    expect(
      Result.getOrThrow(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: '2026-08-19T20:00:00.000Z',
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
        }),
      ),
    ).toEqual({
      startAt: '2026-08-19T19:30:00.000Z',
      submitCutoffAt: '2026-08-19T19:45:00.000Z',
      expiresAt: '2026-08-19T20:00:00.000Z',
    })
  })

  test('keeps close submissions eligible until the closing bell without an idle pre-close gap', () => {
    for (const closeAt of ['2026-08-19T20:00:00.000Z', '2026-11-27T18:00:00.000Z']) {
      const window = Result.getOrThrow(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: closeAt,
          sessionCloseStartLeadMs: 5 * 60_000,
          sessionCloseSubmitLeadMs: 0,
        }),
      )
      expect(window.startAt).toBe(new Date(Date.parse(closeAt) - 5 * 60_000).toISOString())
      expect(window.submitCutoffAt).toBe(closeAt)
      expect(window.expiresAt).toBe(closeAt)
    }
    expect(
      Result.isFailure(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: '2026-08-19T20:00:00.000Z',
          sessionCloseStartLeadMs: 5 * 60_000,
          sessionCloseSubmitLeadMs: -1,
        }),
      ),
    ).toBeTrue()
  })

  test('rejects malformed close instants and invalid strategy leads', () => {
    expect(
      Result.isFailure(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: 'invalid',
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        resolveExecutionCycleCloseWindow({
          executionCloseAt: '2026-08-19T20:00:00.000Z',
          sessionCloseStartLeadMs: 15 * 60_000,
          sessionCloseSubmitLeadMs: 30 * 60_000,
        }),
      ),
    ).toBe(true)
  })
})
