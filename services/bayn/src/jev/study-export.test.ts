import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { parseJevStudyExportArgs } from '../jev-study-export-command'
import { nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'
import { JevPurpose } from './portfolio'
import { verifyJevStudyExportRow } from './study-export'

const entry = nativeJevDecisionEvidence()
const rowFor = (evidence: typeof entry) => ({
  batchId: evidence.batchPlan.batchId,
  cycleId: evidence.batchPlan.cycleId,
  observationHash: evidence.batchPlan.observationHash,
  observation: evidence.observation,
  plan: evidence.batchPlan,
  result: evidence.batchResult,
})
const sessionDate = entry.observation.manifest.sessionDate
const accountId = entry.observation.portfolio.brokerState.account.accountId

describe('retained Jev study evidence', () => {
  test('reproduces the complete native entry and management evidence', () => {
    const row = rowFor(entry)
    expect(Result.getOrThrow(verifyJevStudyExportRow(row, sessionDate, accountId))).toEqual({
      ...row,
      purpose: JevPurpose.Entry,
    })
    const management = rowFor(nativeJevDecisionEvidence(nativeJevFixture(JevPurpose.Manage), 'hold'))
    expect(Result.getOrThrow(verifyJevStudyExportRow(management, sessionDate, accountId)).purpose).toBe(
      JevPurpose.Manage,
    )
  })

  test('retains pending results and abstentions rather than dropping them', () => {
    expect(
      Result.getOrThrow(verifyJevStudyExportRow({ ...rowFor(entry), result: null }, sessionDate, accountId)).result,
    ).toBeNull()
    const waiting = rowFor(nativeJevDecisionEvidence(undefined, 'wait'))
    expect(Result.getOrThrow(verifyJevStudyExportRow(waiting, sessionDate, accountId)).result).toEqual(waiting.result)
  })

  test('rejects missing, forged and substituted evidence', () => {
    const row = rowFor(entry)
    for (const changed of [
      { ...row, observation: null },
      { ...row, observationHash: 'a'.repeat(64) },
      { ...row, batchId: 'b'.repeat(64) },
      { ...row, cycleId: 'c'.repeat(64) },
      { ...row, plan: { ...entry.batchPlan, observedAt: '2026-09-18T15:31:02.000Z' } },
      { ...row, result: { ...entry.batchResult, resultHash: 'd'.repeat(64) } },
    ])
      expect(Result.isFailure(verifyJevStudyExportRow(changed, sessionDate, accountId))).toBe(true)
    expect(Result.isFailure(verifyJevStudyExportRow(row, '2026-09-19', accountId))).toBe(true)
    expect(Result.isFailure(verifyJevStudyExportRow(row, sessionDate, 'foreign-account'))).toBe(true)
  })

  test('requires one exact session and a new output destination', () => {
    expect(Result.getOrThrow(parseJevStudyExportArgs(['--help']))._tag).toBe('Help')
    expect(Result.getOrThrow(parseJevStudyExportArgs(['--session', '2026-10-06', '--output', '/tmp/new']))).toEqual({
      _tag: 'Export',
      sessionDate: '2026-10-06',
      outputPath: '/tmp/new',
    })
    for (const args of [
      [],
      ['--session', '2026-02-30', '--output', '/tmp/new'],
      ['--session', '2026-10-06', '--output', ' '],
      ['--session', '2026-10-06', '--output', '--help'],
      ['--session', '2026-10-06', '--output', '/tmp/new', '--live'],
    ])
      expect(Result.isFailure(parseJevStudyExportArgs(args))).toBe(true)
  })
})
