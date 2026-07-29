import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { verifyCandidate6RejectionReceipt } from './candidate-research-receipt'

const receiptPath = resolve(import.meta.dir, '../candidates/ordinal-6-month-end-liquidity-reversal-rejection.json')

const readReceipt = async (): Promise<unknown> => JSON.parse(await Bun.file(receiptPath).text())

describe('candidate research rejection receipt', () => {
  test('strictly decodes and verifies the canonical Candidate 6 rejection boundary', async () => {
    const verified = verifyCandidate6RejectionReceipt(await readReceipt())
    assert(Result.isSuccess(verified))
    expect(verified.success.disposition).toBe('REJECTED_DEVELOPMENT_EVIDENCE_INSUFFICIENT')
    expect(verified.success.advancementGate.productionStrategyRetained).toBe(false)
    expect(verified.success.holdoutAttestation.status).toBe('UNTOUCHED')
    expect(verified.success.receiptHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('rejects content drift and unknown fields', async () => {
    const receipt = (await readReceipt()) as Record<string, unknown>
    const evidence = structuredClone(receipt.evidence) as { net: { sharpe: number } }
    evidence.net.sharpe += 1
    const changed = verifyCandidate6RejectionReceipt({ ...receipt, evidence })
    assert(Result.isFailure(changed))
    expect(changed.failure._tag).toBe('CandidateResearchReceiptHashMismatch')

    const extended = verifyCandidate6RejectionReceipt({ ...receipt, unsealedField: true })
    assert(Result.isFailure(extended))
    expect(extended.failure._tag).toBe('CandidateResearchReceiptSchemaInvalid')
  })
})
