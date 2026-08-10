import { describe, expect, test } from 'bun:test'

import { DateTime, Result } from 'effect'

import { CycleState, CycleTerminalReason } from '../cycle'
import { Authority, KillState, ReconciliationStatus } from '../execution/contracts'
import {
  decodeCycleObservabilityProjectionRows,
  projectCycleObservabilityRow,
  type CycleObservabilityProjectionRow,
} from './cycle-observability'

const sqlTimestamp = (value: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value))

const emptyRow = (): CycleObservabilityProjectionRow => ({
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

const currentCycleRow = (): CycleObservabilityProjectionRow => ({
  ...emptyRow(),
  current_cycle_id: '1'.repeat(64),
  current_account_id: 'paper-account-1',
  current_signal_session_date: '2026-07-24',
  current_execution_session_date: '2026-07-27',
  current_state: CycleState.Pending,
  current_snapshot_id: '2'.repeat(64),
  current_decision_hash: null,
  current_terminal_reason: null,
  current_submission_open_at: sqlTimestamp('2026-07-27T13:00:00.000Z'),
  current_submission_cutoff_at: sqlTimestamp('2026-07-27T13:28:00.000Z'),
  current_execution_open_at: sqlTimestamp('2026-07-27T13:30:00.000Z'),
  current_execution_close_at: sqlTimestamp('2026-07-27T20:00:00.000Z'),
  current_created_at: sqlTimestamp('2026-07-24T21:00:00.000Z'),
  current_updated_at: sqlTimestamp('2026-07-24T21:01:00.000Z'),
})

describe('cycle observability projection', () => {
  test('decodes the unknown SQL projection once at the adapter boundary', () => {
    expect(decodeCycleObservabilityProjectionRows([emptyRow()])).toEqual(Result.succeed([emptyRow()]))
    expect(decodeCycleObservabilityProjectionRows([{ ...emptyRow(), unfinished_cycle_count: '0' }])).toMatchObject({
      _tag: 'Failure',
    })
  })

  test('projects the empty durable state without effects', () => {
    expect(projectCycleObservabilityRow(emptyRow())).toEqual(
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

  test('projects complete cycle, authority, reconciliation, and mutation facts', () => {
    const row: CycleObservabilityProjectionRow = {
      ...currentCycleRow(),
      unfinished_cycle_count: 1,
      authority_generation_hash: '3'.repeat(64),
      authority_maximum: Authority.Observe,
      authority_effective: Authority.Observe,
      authority_kill: KillState.Clear,
      authority_reason: null,
      authority_updated_at: sqlTimestamp('2026-07-24T21:02:00.000Z'),
      reconciliation_id: '4'.repeat(64),
      reconciliation_account_id: 'paper-account-1',
      reconciliation_status: ReconciliationStatus.Exact,
      reconciliation_discrepancy_count: 0,
      reconciled_at: sqlTimestamp('2026-07-24T21:03:00.000Z'),
      reconciliation_covers_latest_mutation: true,
      mutation_event_count: 2,
      unresolved_mutation_count: 1,
      oldest_unresolved_mutation_at: sqlTimestamp('2026-07-24T21:04:00.000Z'),
      latest_mutation_at: sqlTimestamp('2026-07-24T21:05:00.000Z'),
    }

    const projected = projectCycleObservabilityRow(row)
    expect(Result.isSuccess(projected)).toBe(true)
    if (Result.isFailure(projected)) return expect.unreachable(projected.failure.message)
    expect(projected.success).toMatchObject({
      current: {
        cycleId: '1'.repeat(64),
        accountId: 'paper-account-1',
        phase: CycleState.Pending,
        submissionOpenAt: '2026-07-27T13:00:00.000Z',
      },
      unfinishedCycleCount: 1,
      authority: {
        generationHash: '3'.repeat(64),
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
      },
      reconciliation: {
        reconciliationId: '4'.repeat(64),
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
  })

  test('returns every incomplete projection as typed failure data without throwing', () => {
    const cases = [
      {
        row: { ...emptyRow(), current_cycle_id: '1'.repeat(64) },
        message: 'current cycle projection is incomplete',
      },
      {
        row: { ...emptyRow(), last_cycle_id: '2'.repeat(64) },
        message: 'last cycle projection is incomplete',
      },
      {
        row: { ...emptyRow(), authority_maximum: Authority.Observe },
        message: 'durable authority projection is incomplete',
      },
      {
        row: { ...emptyRow(), reconciliation_id: '3'.repeat(64) },
        message: 'reconciliation projection is incomplete',
      },
    ] as const

    for (const testCase of cases) {
      expect(() => projectCycleObservabilityRow(testCase.row)).not.toThrow()
      const projected = projectCycleObservabilityRow(testCase.row)
      expect(Result.isFailure(projected)).toBe(true)
      if (Result.isSuccess(projected)) return expect.unreachable('incomplete projection unexpectedly succeeded')
      expect(projected.failure).toMatchObject({
        _tag: 'CycleObservabilityError',
        operation: 'read',
        failure: 'invariant',
        message: testCase.message,
      })
    }
  })

  test('keeps explicit account mismatch ahead of other incomplete row failures', () => {
    const row: CycleObservabilityProjectionRow = {
      ...emptyRow(),
      current_cycle_id: '1'.repeat(64),
      selected_account_id: 'paper-account-expected',
      account_mismatch: true,
    }

    const projected = projectCycleObservabilityRow(row)
    expect(Result.isFailure(projected)).toBe(true)
    if (Result.isSuccess(projected)) return expect.unreachable('account mismatch unexpectedly succeeded')
    expect(projected.failure).toMatchObject({
      failure: 'invariant',
      message: 'configured account paper-account-expected differs from the projected current or last cycle',
    })
  })

  test('preserves terminal cycle fields without deriving missing values', () => {
    const row: CycleObservabilityProjectionRow = {
      ...currentCycleRow(),
      current_cycle_id: null,
      current_account_id: null,
      current_signal_session_date: null,
      current_execution_session_date: null,
      current_state: null,
      current_snapshot_id: null,
      current_submission_open_at: null,
      current_submission_cutoff_at: null,
      current_execution_open_at: null,
      current_execution_close_at: null,
      current_created_at: null,
      current_updated_at: null,
      last_cycle_id: '5'.repeat(64),
      last_account_id: 'paper-account-1',
      last_signal_session_date: '2026-07-24',
      last_execution_session_date: '2026-07-27',
      last_state: CycleState.Blocked,
      last_snapshot_id: '6'.repeat(64),
      last_decision_hash: null,
      last_terminal_reason: CycleTerminalReason.MissedPublication,
      last_submission_open_at: sqlTimestamp('2026-07-27T13:00:00.000Z'),
      last_submission_cutoff_at: sqlTimestamp('2026-07-27T13:28:00.000Z'),
      last_execution_open_at: sqlTimestamp('2026-07-27T13:30:00.000Z'),
      last_execution_close_at: sqlTimestamp('2026-07-27T20:00:00.000Z'),
      last_created_at: sqlTimestamp('2026-07-24T21:00:00.000Z'),
      last_updated_at: sqlTimestamp('2026-07-24T21:10:00.000Z'),
      last_terminal_at: sqlTimestamp('2026-07-24T21:10:00.000Z'),
    }

    const projected = projectCycleObservabilityRow(row)
    expect(Result.isSuccess(projected)).toBe(true)
    if (Result.isFailure(projected)) return expect.unreachable(projected.failure.message)
    expect(projected.success.last).toMatchObject({
      cycleId: '5'.repeat(64),
      phase: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedPublication,
      terminalAt: '2026-07-24T21:10:00.000Z',
    })
  })
})
