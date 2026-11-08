import { Result } from 'effect'
import { sha256 } from '../hash'
import { kafkaCaptureDisposition } from '../market-data/streaming/kafka'
import {
  makeNativeArrivalChunk,
  nativeArrival,
  nativeArrivalCaptureId,
  type NativeArrivalEpoch,
} from '../market-data/streaming/native-arrival'
import { nativeArrivalEpochFixture } from '../market-data/streaming/native-arrival.test-support'
import { emptyStreamingProjection, incorporateMarketRecord } from '../market-data/streaming/projection'
import { retainedReplayFixture } from '../testing/retained-replay-fixture'

export const nativeArrivalExportFixture = () => {
  const data = retainedReplayFixture()
  const bootstrap = {
    ...nativeArrivalEpochFixture.bootstrap,
    partitions: data.manifest.positions.map(({ topic, partition, startOffset, endOffsetExclusive }) => ({
      topic,
      partition,
      startOffset,
      logStartOffset: startOffset,
      endOffset: endOffsetExclusive,
    })),
  }
  const epoch: NativeArrivalEpoch = {
    ...nativeArrivalEpochFixture,
    bootstrap,
    sources: data.manifest.marketSources,
    captureId: Result.getOrThrow(
      nativeArrivalCaptureId(nativeArrivalEpochFixture.build, bootstrap, data.manifest.marketSources),
    ),
  }
  let projection = emptyStreamingProjection(bootstrap.epoch)
  const records = data.events.map((event, index) => {
    const before = projection
    const source = epoch.sources.find((source) => Object.values(source.topics).includes(event.record.topic))
    if (source === undefined) throw new Error('Fixture source is absent')
    const rawValue = Buffer.from(event.record.value)
    const record = {
      ...event.record,
      timestampMs: event.record.timestampMs ?? event.availableAtMs,
      leaderEpoch: 0,
      rawValue,
      rawByteLength: rawValue.length,
      rawValueSha256: sha256(rawValue),
    }
    projection = incorporateMarketRecord(projection, record, source, event.availableAtMs)
    return nativeArrival(epoch, {
      record,
      availableAtMs: event.availableAtMs,
      consumerSequence: index + 1,
      projectionSequence: projection.sequence,
      disposition: kafkaCaptureDisposition(before, projection),
      assignmentInvalidated: false,
    })
  })
  const split = Math.ceil(records.length / 2)
  const first = Result.getOrThrow(makeNativeArrivalChunk(epoch, 0, null, records.slice(0, split)))
  const second = Result.getOrThrow(makeNativeArrivalChunk(epoch, 1, first.contentHash, records.slice(split)))
  return { epoch, records, chunks: [first, second] }
}
