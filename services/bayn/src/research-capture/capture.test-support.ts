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
