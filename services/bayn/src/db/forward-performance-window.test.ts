import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeWindowReceiptFixture, performanceWindowGenerationHash } from '../forward-performance/window.test-support'
import { decodeForwardPerformanceWindow, makeForwardPerformanceWindow } from './forward-performance-window'

describe('closed forward-performance windows', () => {
  test('binds one deterministic cut without converting it into terminal-generation authority', () => {
    const receipt = makeWindowReceiptFixture()
    const first = Result.getOrThrow(makeForwardPerformanceWindow(performanceWindowGenerationHash, receipt))
    const repeated = Result.getOrThrow(makeForwardPerformanceWindow(performanceWindowGenerationHash, receipt))
    expect(first).toEqual(repeated)
    expect(first.schemaVersion).toBe('bayn.forward-performance-window.v1')
    expect(first.authorityGenerationHash).toBe(performanceWindowGenerationHash)
    expect(first.receipt.window.closedAt).toBe('2026-09-18T20:01:00.000Z')
    expect(first.receipt.executionQuality.status).toBe('UNDETERMINED')
    expect(Result.getOrThrow(decodeForwardPerformanceWindow(JSON.parse(JSON.stringify(first))))).toEqual(first)
  })

  test('a later reconciliation produces another immutable window in the same standing generation', () => {
    const receipt = makeWindowReceiptFixture()
    const first = Result.getOrThrow(makeForwardPerformanceWindow(performanceWindowGenerationHash, receipt))
    const nextReceipt = makeWindowReceiptFixture({
      window: { ...receipt.window, reconciliationId: 'e'.repeat(64), closedAt: '2026-09-18T20:02:00.000Z' },
    })
    const next = Result.getOrThrow(makeForwardPerformanceWindow(performanceWindowGenerationHash, nextReceipt))
    expect(next.windowId).not.toBe(first.windowId)
    expect(next.authorityGenerationHash).toBe(first.authorityGenerationHash)
  })

  test('rejects open positions and unresolved mutations even under a mislabeled sufficient receipt', () => {
    const receipt = makeWindowReceiptFixture()
    for (const field of [
      'openPositionCount',
      'unclosedCycleCount',
      'unresolvedMutationCount',
      'missingLedgerAccountCount',
    ]) {
      const changed = makeWindowReceiptFixture({ reconciliationProof: { ...receipt.reconciliationProof, [field]: 1 } })
      expect(makeForwardPerformanceWindow(performanceWindowGenerationHash, changed)).toMatchObject({
        _tag: 'Failure',
        failure: { failure: 'incomplete' },
      })
    }
  })

  test('rejects absent or inconsistent accounting and cut evidence', () => {
    const receipt = makeWindowReceiptFixture()
    for (const changed of [
      makeWindowReceiptFixture({
        evidence: { status: 'INSUFFICIENT_EVIDENCE', reasonCodes: ['UNCLOSED_WINDOW'], cashYield: null },
      }),
      makeWindowReceiptFixture({ window: { ...receipt.window, lastCycleId: null } }),
      makeWindowReceiptFixture({ window: { ...receipt.window, closedAt: '2026-09-18T12:00:00.000Z' } }),
      makeWindowReceiptFixture({ reconciliationProof: { ...receipt.reconciliationProof, ledgerExact: false } }),
      makeWindowReceiptFixture({ counts: { cycleCount: 1, completedExecutionCount: 0, realizedCloseCount: 0 } }),
    ])
      expect(Result.isFailure(makeForwardPerformanceWindow(performanceWindowGenerationHash, changed))).toBe(true)
  })

  test('rejects altered receipt content, generation or window identity during readback', () => {
    const receipt = makeWindowReceiptFixture()
    const window = Result.getOrThrow(makeForwardPerformanceWindow(performanceWindowGenerationHash, receipt))
    for (const changed of [
      { ...window, authorityGenerationHash: '2'.repeat(64) },
      { ...window, windowId: '0'.repeat(64) },
      { ...window, receipt: { ...receipt, profitability: 'NOT_PROFITABLE' } },
    ])
      expect(Result.isFailure(decodeForwardPerformanceWindow(changed))).toBe(true)
  })
})
