import { expect, test } from 'bun:test'
import { Redacted, Result } from 'effect'
import { approveResearchRun, decodeApprovedResearchRun } from './approval'
import { editorFixture } from './test-support'

test('a serving-image change requires a new approval and cannot retarget a retained registration', () => {
  const run = editorFixture()
  const key = Redacted.make('7'.repeat(64))
  // Captured from the synthetic editor fixture before the serving-image admission change.
  const oldApproval = '3494e9eff7c4ce245a7641c8c5ffec511c6ae50dd26a1caad062c5f3a468def4'
  const old = {
    ...run,
    policy: {
      ...run.policy,
      servingImage: 'sha256:7ef5a35d1ef8ce2cf9d671dd91eec6e367c5849262e0362b4d3d4a26be0d87d2',
    },
  }
  expect(Result.isFailure(decodeApprovedResearchRun({ run: old, approval: oldApproval }, key))).toBe(true)
  expect(Result.isFailure(decodeApprovedResearchRun({ run, approval: oldApproval }, key))).toBe(true)
  const approval = Result.getOrThrow(approveResearchRun(run, key))
  expect(approval).not.toBe(oldApproval)
  expect(Result.getOrThrow(decodeApprovedResearchRun({ run, approval }, key))).toEqual(run)
})

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
