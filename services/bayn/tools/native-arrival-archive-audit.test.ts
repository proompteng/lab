import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { parseNativeArchiveAuditArgs } from './native-arrival-archive-audit'

const args = [
  '--capture',
  'a'.repeat(64),
  '--receipt',
  'b'.repeat(64),
  '--maximum-pages',
  '1000',
  '--source-revision',
  'c'.repeat(40),
]

test('requires explicit pinned capture, receipt, verifier source and bounded page budget', () => {
  expect(Result.isSuccess(parseNativeArchiveAuditArgs(args))).toBeTrue()
  expect(Result.isSuccess(parseNativeArchiveAuditArgs(['--help']))).toBeTrue()
  for (const [index, value] of [
    [1, '../capture'],
    [3, 'wrong-hash'],
    [5, '0'],
    [5, '100001'],
    [5, '1.5'],
    [7, 'HEAD'],
  ] as const) {
    const invalid = [...args]
    invalid[index] = value
    expect(Result.isFailure(parseNativeArchiveAuditArgs(invalid))).toBeTrue()
  }
  expect(Result.isFailure(parseNativeArchiveAuditArgs(args.slice(0, -2)))).toBeTrue()
})
