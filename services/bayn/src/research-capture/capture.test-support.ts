import { sha256 } from '../hash'
import { CaptureDisposition, type ResearchCaptureEvent } from './capture'

export const captureEvent = (phase: 'STARTED' | 'STOPPED'): ResearchCaptureEvent => ({
  kind: 'consumer-boundary',
  consumerEpoch: 'consumer-1',
  phase,
  positions: [],
})
export const marketEvent: Extract<ResearchCaptureEvent, { readonly kind: 'market-record' }> = {
  kind: 'market-record',
  consumerEpoch: 'consumer-1',
  consumerSequence: 1,
  projectionSequence: 1,
  topic: 'quotes',
  partition: 0,
  offset: '0',
  rawValueSha256: sha256('é'),
  rawByteLength: 2,
  tombstone: false,
  bootstrap: false,
  disposition: CaptureDisposition.Accepted,
}

export const fullCaptureBufferEvents = (lastReceiptBytes = 64 * 1024): readonly ResearchCaptureEvent[] =>
  Array.from({ length: 64 }, (_, index) => {
    const event: ResearchCaptureEvent = {
      kind: 'consumer-boundary',
      consumerEpoch: 'consumer-1',
      phase: index === 0 ? 'STARTED' : index === 63 ? 'STOPPED' : 'ASSIGNED',
      positions: [],
      reason: 'x',
    }
    const targetBytes = index === 63 ? lastReceiptBytes : 64 * 1024
    const remaining = targetBytes - Buffer.byteLength(JSON.stringify({ sequence: index + 1, observedAtMs: 100, event }))
    return { ...event, reason: `x${'é'.repeat(Math.floor(remaining / 2))}${'x'.repeat(remaining % 2)}` }
  })
