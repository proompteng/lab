import { expect, test } from 'bun:test'
import { Schema } from 'effect'
import { ResearchCaptureReceiptSchema } from '../research-capture/capture'
import { marketEvent } from '../research-capture/capture.test-support'
import { researchCaptureExportEntryReservation } from '../research-capture/export'
import { capacityAttributionCase } from './capture-capacity-metrics.mjs'

test('attribution modes preserve receipt bytes and reservations apart from equal-length random identities', () => {
  const variants = [
    ['full', '11111111-1111-4111-8111-111111111111'],
    ['proof-light', '22222222-2222-4222-8222-222222222222'],
  ] as const
  for (const arm of ['disabledName', 'enabledName'] as const) {
    const receipts = variants.map(([mode, runId]) => {
      const captureId = `bayn-capacity-${runId}-${capacityAttributionCase(mode)[arm]}`
      const receipt = Schema.decodeUnknownSync(ResearchCaptureReceiptSchema)({
        sequence: 1,
        observedAtMs: 100,
        event: { ...marketEvent, consumerEpoch: runId, topic: `${captureId}-quotes` },
      })
      const payload = JSON.stringify(receipt)
      const bytes = Buffer.byteLength(payload)
      return {
        normalizedCaptureId: captureId.replaceAll(runId, '<run-id>'),
        normalizedPayload: payload.replaceAll(runId, '<run-id>'),
        captureIdBytes: Buffer.byteLength(captureId),
        bytes,
        reservation: researchCaptureExportEntryReservation(bytes, marketEvent.rawByteLength ?? 0),
      }
    })
    expect(receipts[0]?.bytes).toBe(receipts[1]?.bytes)
    expect(receipts[0]).toEqual(receipts[1])
    expect(receipts[0]?.bytes).toBe(arm === 'disabledName' ? 444 : 443)
    expect(receipts[0]?.reservation).toBe(arm === 'disabledName' ? 2294 : 2290)
  }
})
