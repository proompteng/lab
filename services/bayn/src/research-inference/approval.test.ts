import { expect, test } from 'bun:test'
import { Redacted, Result } from 'effect'
import { approveResearchRun, decodeApprovedResearchRun } from './approval'
import { editorFixture } from './test-support'

test('operator approval binds the complete run and denies changed inputs, keys and envelopes', () => {
  const run = editorFixture()
  const key = Redacted.make('7'.repeat(64))
  const approval = Result.getOrThrow(approveResearchRun(run, key))
  expect(Result.getOrThrow(decodeApprovedResearchRun({ run, approval }, key))).toEqual(run)
  expect(Result.isFailure(decodeApprovedResearchRun({ run, approval }, Redacted.make('8'.repeat(64))))).toBe(true)
  expect(Result.isFailure(decodeApprovedResearchRun({ run: { ...run, attempt: 1 }, approval }, key))).toBe(true)
  expect(Result.isFailure(decodeApprovedResearchRun({ run, approval, extra: true }, key))).toBe(true)
  expect(Result.isFailure(approveResearchRun(run, Redacted.make('short')))).toBe(true)
  expect(Result.isFailure(decodeApprovedResearchRun({ run: { ...run, purpose: 'reflection' }, approval }, key))).toBe(
    true,
  )
})
