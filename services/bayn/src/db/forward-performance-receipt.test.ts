import { describe, expect, test } from 'bun:test'

import { canonicalHashV1 } from '../hash'
import { decodeForwardPerformanceReceiptEnvelopeResult } from './forward-performance-receipt'

const hash = 'a'.repeat(64)

const receiptMaterial = {
  schemaVersion: 'bayn.forward-performance-receipt.v3' as const,
  bindings: {
    runtime: {
      sourceRevision: 'b'.repeat(40),
      imageRepository: 'registry.example.test/lab/bayn',
      imageDigest: `sha256:${'c'.repeat(64)}`,
    },
    source: null,
    strategy: null,
    account: { accountReferenceHash: 'd'.repeat(64), provider: 'alpaca', environment: 'sandbox' },
  },
  window: {
    firstCycleId: null,
    lastCycleId: null,
    openedAt: null,
    closedAt: null,
    reconciliationId: null,
    reconciliationContentHash: null,
    reconciliationStatus: null,
    cashYieldAdjustedExact: null,
  },
  totals: {
    startingCapitalMicros: null,
    realizedGainsMicros: null,
    realizedLossesMicros: null,
    brokerExecutionFeesMicros: null,
    otherChargedCostsMicros: null,
    cashYieldMicros: null,
    grossRealizedPnlMicros: null,
    netRealizedPnlAfterCostsMicros: null,
    netRealizedReturn: null,
  },
  counts: { cycleCount: 0, completedExecutionCount: 0, realizedCloseCount: 0 },
  evidence: { status: 'INSUFFICIENT_EVIDENCE' as const, reasonCodes: ['ZERO_COMPLETED_EXECUTIONS'], cashYield: null },
  reconciliationProof: {
    accountingReceiptsExact: false,
    ledgerExact: false,
    missingLedgerAccountCount: 0,
    unresolvedMutationCount: 0,
    unclosedCycleCount: 0,
    openPositionCount: 0,
  },
  executionQuality: {
    status: 'NOT_ELIGIBLE' as const,
    reasonCodes: ['ZERO_COMPLETED_EXECUTIONS'],
    evidenceHash: null,
    implementationShortfall: null,
  },
  observedCapacity: {
    status: 'NOT_ELIGIBLE' as const,
    reasonCodes: ['ZERO_COMPLETED_EXECUTIONS'],
    evidenceHash: null,
    observations: [],
    boundedObservedReferenceNotionalMicros: null,
    boundedObservedExecutedNotionalMicros: null,
    maximumParticipationRate: null,
  },
  profitability: 'UNDETERMINED' as const,
}

const receipt = { ...receiptMaterial, receiptHash: canonicalHashV1(receiptMaterial) }

const envelopeMaterial = {
  schemaVersion: 'bayn.forward-performance-receipt-envelope.v1' as const,
  authorityGenerationHash: hash,
  cycleId: hash,
  receiptHash: receipt.receiptHash,
  receipt,
  createdAt: '2026-07-28T08:00:00.000Z',
}

const envelope = { ...envelopeMaterial, contentHash: canonicalHashV1(envelopeMaterial) }

describe('forward-performance receipt persistence contract', () => {
  test('rejects an envelope whose receipt only exposes a matching hash', () => {
    const decoded = decodeForwardPerformanceReceiptEnvelopeResult({
      schemaVersion: 'bayn.forward-performance-receipt-envelope.v1',
      authorityGenerationHash: hash,
      cycleId: hash,
      receiptHash: hash,
      receipt: { receiptHash: hash },
      createdAt: '2026-07-28T08:00:00.000Z',
      contentHash: hash,
    })

    expect(decoded._tag).toBe('Failure')
  })

  test('rejects a structurally valid envelope when the nested receipt hash is not canonical', () => {
    const tamperedReceiptHash = 'f'.repeat(64)
    const tamperedMaterial = {
      ...envelopeMaterial,
      receiptHash: tamperedReceiptHash,
      receipt: { ...receipt, receiptHash: tamperedReceiptHash },
    }
    const decoded = decodeForwardPerformanceReceiptEnvelopeResult({
      ...tamperedMaterial,
      contentHash: canonicalHashV1(tamperedMaterial),
    })

    expect(decodeForwardPerformanceReceiptEnvelopeResult(envelope)._tag).toBe('Success')
    expect(decoded._tag).toBe('Failure')
  })

  test('rejects a valid receipt when the envelope hash binding differs', () => {
    const mismatchedMaterial = { ...envelopeMaterial, receiptHash: hash }
    const decoded = decodeForwardPerformanceReceiptEnvelopeResult({
      ...mismatchedMaterial,
      contentHash: canonicalHashV1(mismatchedMaterial),
    })

    expect(decoded._tag).toBe('Failure')
  })
})
