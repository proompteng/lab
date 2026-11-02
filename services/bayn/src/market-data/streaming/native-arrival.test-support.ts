import { Result } from 'effect'

import { sha256 } from '../../hash'
import { KafkaBootstrapTimestampPolicy } from './bootstrap'
import { nativeArrivalCaptureId } from './native-arrival'
import { CaptureDisposition } from './transport-evidence'
import type { NativeArrivalEpoch, NativeArrivalObservation } from './native-arrival'

const build = {
  sourceRevision: '1'.repeat(40),
  imageRepository: 'example.test/bayn',
  imageDigest: 'sha256:' + '2'.repeat(64),
  strategyBehaviorHash: '3'.repeat(64),
  strategyParameterHash: '4'.repeat(64),
  verification: 'development-configured',
} as const
const bootstrap = {
  schemaVersion: 'bayn.kafka-bootstrap.v1',
  epoch: 'synthetic-native-arrival-epoch',
  observedAtMs: 1_000,
  lowerTimestampMs: 0,
  timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
  partitions: [{ topic: 'crypto', partition: 0, logStartOffset: '0', startOffset: '0', endOffset: '2' }],
} as const
const sources = [
  {
    universeId: 'synthetic-crypto',
    universeSymbolHash: '5'.repeat(64),
    symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
    topics: { bars: 'crypto', quotes: 'crypto', trades: 'crypto', features: 'features' },
  },
] as const
export const nativeArrivalEpochFixture: NativeArrivalEpoch = {
  schemaVersion: 'bayn.native-arrival-epoch.v1',
  captureId: Result.getOrThrow(nativeArrivalCaptureId(build, bootstrap, sources)),
  build,
  bootstrap,
  sources,
}
export const nativeArrivalObservationFixture = (
  sequence: number,
  value = '{"symbol":"BTC/USD","payload":"λ"}',
): NativeArrivalObservation => {
  const rawValue = Buffer.from(value)
  return {
    record: {
      topic: 'crypto',
      partition: 0,
      offset: String(sequence - 1),
      timestampMs: 900,
      leaderEpoch: 1,
      rawValue,
      rawValueSha256: sha256(rawValue),
      rawByteLength: rawValue.byteLength,
      value,
    },
    availableAtMs: 1_000 + sequence,
    consumerSequence: sequence,
    projectionSequence: sequence,
    disposition: CaptureDisposition.Accepted,
    assignmentInvalidated: false,
  }
}
