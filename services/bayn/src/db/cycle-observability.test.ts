import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { Authority, KillState, ReconciliationStatus } from '../paper'
import { decodeCycleOperationsProjection } from './cycle-observability'

const sha = (value: string): string => value.repeat(64)
const instant = (value: string): Date => new Date(value)

const emptyRow = () => ({
  current_cycle_id: null,
  current_account_id: null,
  current_signal_session_date: null,
  current_execution_session_date: null,
  current_state: null,
  current_snapshot_id: null,
  current_decision_hash: null,
  current_terminal_reason: null,
  current_submission_open_at: null,
  current_submission_cutoff_at: null,
  current_execution_open_at: null,
  current_execution_close_at: null,
  current_created_at: null,
  current_updated_at: null,
  current_terminal_at: null,
  last_cycle_id: null,
  last_account_id: null,
  last_signal_session_date: null,
  last_execution_session_date: null,
  last_state: null,
  last_snapshot_id: null,
  last_decision_hash: null,
  last_terminal_reason: null,
  last_submission_open_at: null,
  last_submission_cutoff_at: null,
  last_execution_open_at: null,
  last_execution_close_at: null,
  last_created_at: null,
  last_updated_at: null,
  last_terminal_at: null,
  selected_account_id: null,
  account_mismatch: false,
  unfinished_cycle_count: 0,
  authority_generation_hash: null,
  authority_maximum: null,
  authority_effective: null,
  authority_kill: null,
  authority_reason: null,
  authority_updated_at: null,
  reconciliation_id: null,
  reconciliation_account_id: null,
  reconciliation_status: null,
  reconciliation_discrepancy_count: null,
  reconciled_at: null,
  reconciliation_covers_latest_mutation: null,
  mutation_event_count: 0,
  unresolved_mutation_count: 0,
  oldest_unresolved_mutation_at: null,
  latest_mutation_at: null,
})

describe('cycle observability projection decisions', () => {
  test('decodes an empty projection without throwing or inventing state', () => {
    const result = decodeCycleOperationsProjection([emptyRow()])

    expect(result).toEqual(
      Result.succeed({
        current: null,
        last: null,
        unfinishedCycleCount: 0,
        authority: null,
        reconciliation: null,
        mutations: {
          eventCount: 0,
          unresolvedCount: 0,
          oldestUnresolvedAt: null,
          latestOccurredAt: null,
        },
      }),
    )
  })

  test('returns closed invariant failures for every incomplete projection family', () => {
    const current = decodeCycleOperationsProjection([{ ...emptyRow(), current_cycle_id: sha('a') }])
    const authority = decodeCycleOperationsProjection([{ ...emptyRow(), authority_maximum: Authority.Observe }])
    const reconciliation = decodeCycleOperationsProjection([{ ...emptyRow(), reconciliation_id: sha('b') }])

    for (const [result, message] of [
      [current, 'current cycle projection is incomplete'],
      [authority, 'durable authority projection is incomplete'],
      [reconciliation, 'reconciliation projection is incomplete'],
    ] as const) {
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: 'CycleObservabilityError',
          operation: 'read',
          failure: 'invariant',
          message,
        })
      }
    }
  })

  test('returns the configured-account mismatch as data', () => {
    const result = decodeCycleOperationsProjection([
      { ...emptyRow(), selected_account_id: 'paper-account', account_mismatch: true },
    ])

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'CycleObservabilityError',
        operation: 'read',
        failure: 'invariant',
        message: 'configured account paper-account differs from the projected current or last cycle',
      })
    }
  })

  test('decodes complete cycle, authority, reconciliation, and mutation observations', () => {
    const row = {
      ...emptyRow(),
      current_cycle_id: sha('a'),
      current_account_id: 'paper-account',
      current_signal_session_date: '2026-07-24',
      current_execution_session_date: '2026-07-27',
      current_state: 'ACTIVE',
      current_snapshot_id: sha('b'),
      current_decision_hash: sha('c'),
      current_terminal_reason: null,
      current_submission_open_at: instant('2026-07-27T12:00:00.000Z'),
      current_submission_cutoff_at: instant('2026-07-27T13:00:00.000Z'),
      current_execution_open_at: instant('2026-07-27T13:30:00.000Z'),
      current_execution_close_at: instant('2026-07-27T20:00:00.000Z'),
      current_created_at: instant('2026-07-24T21:00:00.000Z'),
      current_updated_at: instant('2026-07-24T21:01:00.000Z'),
      authority_generation_hash: sha('d'),
      authority_maximum: Authority.Observe,
      authority_effective: Authority.Observe,
      authority_kill: KillState.Clear,
      authority_updated_at: instant('2026-07-24T21:02:00.000Z'),
      reconciliation_id: sha('e'),
      reconciliation_account_id: 'paper-account',
      reconciliation_status: ReconciliationStatus.Exact,
      reconciliation_discrepancy_count: 0,
      reconciled_at: instant('2026-07-24T21:03:00.000Z'),
      reconciliation_covers_latest_mutation: true,
      mutation_event_count: 2,
      unresolved_mutation_count: 1,
      oldest_unresolved_mutation_at: instant('2026-07-24T21:04:00.000Z'),
      latest_mutation_at: instant('2026-07-24T21:05:00.000Z'),
    }
    const result = decodeCycleOperationsProjection([row])

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success).toMatchObject({
        current: {
          cycleId: sha('a'),
          accountId: 'paper-account',
          phase: 'ACTIVE',
          submissionOpenAt: '2026-07-27T12:00:00.000Z',
        },
        authority: {
          generationHash: sha('d'),
          maximum: Authority.Observe,
          effective: Authority.Observe,
          kill: KillState.Clear,
        },
        reconciliation: {
          reconciliationId: sha('e'),
          status: ReconciliationStatus.Exact,
          discrepancyCount: 0,
          coversLatestMutation: true,
        },
        mutations: {
          eventCount: 2,
          unresolvedCount: 1,
          oldestUnresolvedAt: '2026-07-24T21:04:00.000Z',
          latestOccurredAt: '2026-07-24T21:05:00.000Z',
        },
      })
    }
  })

  test('keeps malformed SQL rows in the decode failure channel', () => {
    const result = decodeCycleOperationsProjection([{ ...emptyRow(), mutation_event_count: -1 }])

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'CycleObservabilityError',
        operation: 'read',
        failure: 'decode',
      })
    }
  })
})
