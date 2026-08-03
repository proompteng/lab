import { describe, expect, test } from 'bun:test'

import { decodeForwardPerformanceReceiptEnvelopeResult } from './forward-performance-receipt'

const hash = 'a'.repeat(64)

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
})
