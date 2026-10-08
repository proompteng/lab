import { expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'

import { Authority, KillState } from '../../execution/contracts'
import { canonicalHashV1 } from '../../hash'
import { riskContextFromRow } from '../../reconciliation/algebra'
import { authorityStateFromRow } from './authority-shared'
import { UtcDatabaseInstantSchema } from '../../schemas'
import { validateCurrentGenerationHistory } from '../../execution/capital-grant-algebra'

test.each(['2026-08-28T14:58:00.038Z', '2026-08-28T14:58:00.038402Z'])(
  'preserves the exact authority timestamp through store and reconciliation reads: %s',
  async (updatedAt) => {
    const expected = {
      schemaVersion: 'bayn.paper-authority.v1' as const,
      generationHash: '2'.repeat(64),
      maximum: Authority.Execution,
      effective: Authority.Execution,
      kill: KillState.Clear,
      version: 2,
      updatedAt,
    }
    const stored = await Effect.runPromise(
      authorityStateFromRow({
        schema_version: expected.schemaVersion,
        generation_hash: expected.generationHash,
        maximum: expected.maximum,
        effective: expected.effective,
        kill_state: expected.kill,
        reason: null,
        version: String(expected.version),
        updated_at: updatedAt,
      }),
    )
    const riskRow = {
      trading_date: '2026-08-28' as const,
      authority_schema_version: expected.schemaVersion,
      authority_generation_hash: expected.generationHash,
      authority_maximum: expected.maximum,
      authority_effective: expected.effective,
      authority_kill: expected.kill,
      authority_reason: null,
      authority_version: String(expected.version),
      authority_updated_at: updatedAt,
      authority_observed_at: new Date('2026-08-28T14:58:00.038Z'),
      daily_traded_notional_micros: '0',
      day_start_equity_micros: '100000000000',
      peak_equity_micros: '100000000000',
    }
    const reconciled = Result.getOrThrow(riskContextFromRow(riskRow, 0))
    expect(stored).toEqual(expected)
    expect(reconciled.authority).toEqual(expected)
    expect(reconciled.authorityObservedAt).toBe('2026-08-28T14:58:00.038Z')
    expect(canonicalHashV1(stored)).toBe(canonicalHashV1(expected))
    expect(canonicalHashV1(reconciled.authority)).toBe(canonicalHashV1(expected))
    expect(
      Result.isFailure(riskContextFromRow({ ...riskRow, authority_updated_at: '2026-08-28T14:58:00.039001Z' }, 0)),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateCurrentGenerationHistory(stored, {
          generationHash: expected.generationHash,
          maximum: expected.maximum,
          authorityVersion: String(expected.version),
          activatedAt: new Date(updatedAt),
        }),
      ),
    ).toBe(true)
  },
)

test('rejects unrepresentable or invalid database authority timestamps rather than rounding them', () => {
  const decode = Schema.decodeUnknownResult(UtcDatabaseInstantSchema)
  for (const value of [
    '2026-08-28T14:58:00.0384021Z',
    '2026-08-28T14:58:00.038402001Z',
    '2026-08-28T14:58:00.0384Z',
    '2026-08-28T14:58:00Z',
    '2026-02-30T14:58:00.038402Z',
    '2026-08-28T14:58:00.038402+00:00',
  ])
    expect(Result.isFailure(decode(value))).toBe(true)
})
