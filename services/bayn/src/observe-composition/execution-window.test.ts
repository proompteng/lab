import {
  continuousMarketHours,
  continuousExecutionPolicy,
  executionCloseRecoveryExpiry,
  tradingWindow,
} from '../market-hours'
import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { boundExecutionCycleCloseWindow, resolveExecutionCycleCloseWindow } from './execution-window'

describe('execution-cycle close windows', () => {
  test.each(['2026-10-18T06:00:00.000Z', '2026-10-18T23:59:50.000Z'])(
    'continuous leases keep the full admitted holding horizon at %s',
    (observedAt) => {
      const lease = Result.getOrThrow(
        tradingWindow(continuousMarketHours, observedAt, {
          ...continuousExecutionPolicy,
          sessionEntryCutoffMs: 0,
        }),
      )
      if (lease === null) throw new Error('Expected a continuous lease')
      const close = Result.getOrThrow(
        resolveExecutionCycleCloseWindow({
          executionCalendarSchemaVersion: continuousMarketHours.schemaVersion,
          observedAt,
          executionCloseAt: lease.closeAt,
          recoveryExpiresAt: null,
          sessionCloseStartLeadMs: 5 * 60_000,
          sessionCloseSubmitLeadMs: 0,
        }),
      )
      expect(close.startAt).toBe(
        new Date(Date.parse(lease.entryCutoffAt) + continuousExecutionPolicy.maximumHoldingMs).toISOString(),
      )
      expect(close.submitCutoffAt).toBe(lease.closeAt)
      expect(Date.parse(close.expiresAt) - Date.parse(close.startAt)).toBe(continuousExecutionPolicy.closeRecoveryMs)
    },
  )

  test('renews a bounded close lease after IEX ends while the verified broker session remains open', () => {
    const window = Result.getOrThrow(
      resolveExecutionCycleCloseWindow({
        executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
        observedAt: '2026-10-16T21:20:00.000Z',
        executionCloseAt: '2026-10-16T21:00:00.000Z',
        recoveryExpiresAt: '2026-10-16T21:23:00.000Z',
        sessionCloseStartLeadMs: 300_000,
        sessionCloseSubmitLeadMs: 0,
      }),
    )
    expect(window.expiresAt).toBe('2026-10-16T21:23:00.000Z')
  })
  test('uses the equity strategy close leads for a future session', () => {
    expect(
      Result.getOrThrow(
        resolveExecutionCycleCloseWindow({
          executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
          recoveryExpiresAt: null,
          observedAt: '2026-08-19T19:00:00.000Z',
          executionCloseAt: '2026-09-04T20:00:00.000Z',
          sessionCloseStartLeadMs: 5 * 60_000,
          sessionCloseSubmitLeadMs: 0,
        }),
      ),
    ).toEqual({
      startAt: '2026-09-04T19:55:00.000Z',
      submitCutoffAt: '2026-09-04T20:00:00.000Z',
      expiresAt: '2026-09-04T20:00:00.000Z',
    })
  })

  test('uses strategy-bound close leads for an intraday cycle', () => {
    expect(
      Result.getOrThrow(
        resolveExecutionCycleCloseWindow({
          executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
          recoveryExpiresAt: null,
          observedAt: '2026-08-19T19:00:00.000Z',
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
          executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
          recoveryExpiresAt: null,
          observedAt: '2026-08-19T19:00:00.000Z',
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
          executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
          recoveryExpiresAt: null,
          observedAt: '2026-08-19T19:00:00.000Z',
          executionCloseAt: '2026-08-19T20:00:00.000Z',
          sessionCloseStartLeadMs: 5 * 60_000,
          sessionCloseSubmitLeadMs: -1,
        }),
      ),
    ).toBeTrue()
  })

  test('continuous recovery renews only the bounded close lease after an outage', () => {
    const facts = {
      executionCalendarSchemaVersion: continuousMarketHours.schemaVersion,
      recoveryExpiresAt: executionCloseRecoveryExpiry(continuousMarketHours, '2026-10-14T23:56:58.612Z'),
      observedAt: '2026-10-14T23:56:58.612Z',
      executionCloseAt: '2026-10-14T21:54:35.260Z',
      sessionCloseStartLeadMs: 3 * 60_000,
      sessionCloseSubmitLeadMs: 60_000,
    }
    const window = Result.getOrThrow(resolveExecutionCycleCloseWindow(facts))
    expect(window).toEqual({
      startAt: '2026-10-14T21:51:35.260Z',
      submitCutoffAt: '2026-10-14T23:58:58.612Z',
      expiresAt: '2026-10-14T23:59:58.612Z',
    })
    expect(Result.getOrThrow(resolveExecutionCycleCloseWindow({ ...facts, recoveryExpiresAt: null })).expiresAt).toBe(
      facts.executionCloseAt,
    )
    expect(Result.isFailure(resolveExecutionCycleCloseWindow({ ...facts, observedAt: 'bad' }))).toBe(true)
    expect(Result.isFailure(resolveExecutionCycleCloseWindow({ ...facts, sessionCloseSubmitLeadMs: 3 * 60_000 }))).toBe(
      true,
    )
  })

  test('an unresolved close retains its immutable lease while a settled residual may receive a new one', () => {
    const facts = {
      executionCalendarSchemaVersion: continuousMarketHours.schemaVersion,
      recoveryExpiresAt: executionCloseRecoveryExpiry(continuousMarketHours, '2026-10-14T23:56:58.612Z'),
      observedAt: '2026-10-14T23:56:58.612Z',
      executionCloseAt: '2026-10-14T21:54:35.260Z',
      sessionCloseStartLeadMs: 3 * 60_000,
      sessionCloseSubmitLeadMs: 60_000,
    }
    const original = Result.getOrThrow(resolveExecutionCycleCloseWindow(facts))
    const renewed = Result.getOrThrow(
      resolveExecutionCycleCloseWindow({
        ...facts,
        observedAt: '2026-10-15T00:01:58.612Z',
        recoveryExpiresAt: executionCloseRecoveryExpiry(continuousMarketHours, '2026-10-15T00:01:58.612Z'),
      }),
    )
    expect(renewed.expiresAt).not.toBe(original.expiresAt)
    const pending = boundExecutionCycleCloseWindow(renewed, { expiresAt: original.expiresAt })
    expect(pending).toEqual(original)
    expect(facts.observedAt < pending.submitCutoffAt).toBe(true)
    expect('2026-10-15T00:01:58.612Z' < pending.submitCutoffAt).toBe(false)
    expect(boundExecutionCycleCloseWindow(renewed, { expiresAt: renewed.expiresAt })).toEqual(renewed)
  })

  test('rejects malformed close instants and invalid strategy leads', () => {
    expect(
      Result.isFailure(
        resolveExecutionCycleCloseWindow({
          executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
          recoveryExpiresAt: null,
          observedAt: '2026-08-19T19:00:00.000Z',
          executionCloseAt: 'invalid',
          sessionCloseStartLeadMs: 5 * 60_000,
          sessionCloseSubmitLeadMs: 0,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        resolveExecutionCycleCloseWindow({
          executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
          recoveryExpiresAt: null,
          observedAt: '2026-08-19T19:00:00.000Z',
          executionCloseAt: '2026-08-19T20:00:00.000Z',
          sessionCloseStartLeadMs: 15 * 60_000,
          sessionCloseSubmitLeadMs: 30 * 60_000,
        }),
      ),
    ).toBe(true)
  })
})
