import { expect, spyOn, test } from 'bun:test'
import * as zlib from 'node:zlib'
import { Effect, FileSystem, Result } from 'effect'
import { NodeServices } from '@effect/platform-node'
import { TestClock } from 'effect/testing'

import { canonicalHashV1, sha256 } from '../hash'
import { openBacktestSource } from '../intraday-replay/source'
import { ControlManagementMode, runControlStudy } from '../intraday-replay/control-study'
import { jevModel } from '../jev/contract'
import { constructSimulatedSnapshot, constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { historicalStreamingFixture } from '../testing/historical-streaming-fixture'
import { config as runtimeConfig } from '../testing/runtime-fixtures'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap'
import { kafkaCaptureDisposition } from '../market-data/streaming/kafka'
import { emptyStreamingProjection, incorporateMarketRecord } from '../market-data/streaming/projection'
import type { StreamingUniverse } from '../market-data/streaming/raw-events'
import {
  CaptureDisposition,
  CaptureInvalidation,
  CaptureQualification,
  ResearchCaptureFailure,
  captureKafkaTransport,
  encodeResearchCapture,
  type CaptureIntervalRequest,
  type ResearchCaptureReceipt,
  type ResearchCaptureEvent,
  type ResearchCaptureBytes,
} from './capture'
import {
  buildResearchCaptureExportChunk,
  buildResearchCaptureExportEnvelope,
  decodeResearchCaptureExportEnvelope,
  deriveResearchCaptureExportManifest,
  verifyResearchCaptureExport,
  verifyResearchCaptureExportPrefix,
} from './export'
import { readResearchCaptureInterval, replayResearchCaptureInterval } from './replay'
import { makeResearchCaptureRecorder } from './recorder'

const at = Date.parse('2026-09-25T13:30:00.000Z')
const universe: StreamingUniverse = {
  universeId: 'fixture',
  universeSymbolHash: 'a'.repeat(64),
  symbols: ['AAPL'],
  topics: { bars: 'bars', quotes: 'quotes', trades: 'trades', features: 'features', technicalFeatures: 'technical' },
}
const partitions = Object.values(universe.topics)
  .flatMap((topic) => Array.from({ length: topic === 'quotes' ? 13 : 3 }, (_, partition) => ({ topic, partition })))
  .toSorted((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition)
const request: CaptureIntervalRequest = {
  intervalId: 'session-1',
  coverageStartMs: at,
  coverageEndMs: at + 200,
  universeHash: canonicalHashV1(universe),
  expectedPartitions: partitions,
}
const quote = Buffer.from(
  JSON.stringify({
    version: 2,
    provider: 'alpaca',
    feed: 'iex',
    delayClass: 'real_time_exchange_only',
    marketSession: 'regular',
    channel: 'quotes',
    symbol: 'AAPL',
    eventTs: new Date(at).toISOString(),
    ingestTs: new Date(at).toISOString(),
    payload: { t: new Date(at).toISOString(), bp: 200, ap: 200.01, bs: 100, as: 100 },
  }),
)

const fixture = (
  mutate?: (receipts: ResearchCaptureReceipt[]) => ResearchCaptureReceipt[],
  format: 'v1' | 'v2' = 'v1',
) => {
  let projection = emptyStreamingProjection('consumer-1', universe.topics.technicalFeatures)
  const positions = partitions.map((partition) => ({ ...partition, offset: '0' }))
  const receipts: ResearchCaptureReceipt[] = []
  const raw = new Map<number, Uint8Array | null>()
  const add = (event: ResearchCaptureEvent, observedAtMs: number) =>
    receipts.push({ sequence: receipts.length + 1, observedAtMs, event })
  add({ kind: 'consumer-boundary', phase: 'STARTED', consumerEpoch: 'consumer-1', positions: [] }, at - 20)
  add(
    {
      kind: 'consumer-boundary',
      phase: 'ASSIGNED',
      consumerEpoch: 'consumer-1',
      positions,
      bootstrap: {
        schemaVersion: 'bayn.kafka-bootstrap.v1',
        epoch: 'consumer-1',
        observedAtMs: at - 10,
        lowerTimestampMs: at - 30 * 60_000,
        timestampPolicy: KafkaBootstrapTimestampPolicy.RetainedBeginning,
        partitions: partitions.map((partition) => ({
          ...partition,
          logStartOffset: '0',
          startOffset: '0',
          endOffset: '0',
        })),
      },
    },
    at - 5,
  )
  add({ kind: 'consumer-boundary', phase: 'BOOTSTRAPPED', consumerEpoch: 'consumer-1', positions }, at)
  const values = [quote, quote, Buffer.from([0x80]), Buffer.alloc(0), quote, quote, quote, quote, quote, quote, quote]
  const timestamps = [at, at, at, at, undefined, NaN, Infinity, -Infinity, -0, -1, at + 0.5]
  for (const [index, value] of values.entries()) {
    const offset = index === 1 ? '0' : String(index)
    const timestampMs = timestamps[index]
    const record = {
      topic: 'quotes',
      partition: 0,
      offset,
      value: value.toString('utf8'),
      ...(timestampMs === undefined ? {} : { timestampMs }),
    }
    const previous = projection
    projection = incorporateMarketRecord(projection, record, universe, at + 100)
    add(
      {
        kind: 'market-record',
        consumerEpoch: 'consumer-1',
        consumerSequence: index + 1,
        projectionSequence: projection.sequence,
        topic: record.topic,
        partition: 0,
        offset,
        originalTransport: captureKafkaTransport(timestampMs),
        rawValueSha256: sha256(value),
        rawByteLength: value.byteLength,
        tombstone: false,
        bootstrap: false,
        disposition: kafkaCaptureDisposition(previous, projection),
      },
      at + 100,
    )
    raw.set(receipts.length, value)
  }
  add(
    {
      kind: 'consumer-interval-cut',
      schemaVersion: 'bayn.native-visible-input-cut.v1',
      ...request,
      consumerEpoch: 'consumer-1',
      transport: {
        sdk: '@platformatic/kafka',
        version: '2.12.1',
        isolation: 'READ_COMMITTED',
        mode: 'MANUAL',
        fallback: 'FAIL',
        deserializationFailure: 'FAIL',
      },
      committedFence: {
        lookupStartedAtMs: at + 200,
        lookupCompletedAtMs: at + 205,
        positions: positions.map((position) =>
          position.topic === 'quotes' && position.partition === 0 ? { ...position, offset: '10' } : position,
        ),
      },
      drainedPositions: positions.map((position) =>
        position.topic === 'quotes' && position.partition === 0 ? { ...position, offset: '11' } : position,
      ),
      finalConsumerSequence: values.length,
    },
    at + 210,
  )
  const selected = mutate === undefined ? receipts : mutate(receipts)
  const chunk = {
    schemaVersion: 'bayn.research-capture-chunk.v1' as const,
    captureId: 'capture-1',
    sourceRevision: 'a'.repeat(40),
    chunkOrdinal: 0,
    previousContentHash: null,
    receipts: selected,
  }
  const metadata = encodeResearchCapture(chunk)
  const entries = selected.map((receipt) => ({
    receipt,
    ...(receipt.event.kind === 'market-record' ? { rawValue: raw.get(receipt.sequence) ?? null } : {}),
  }))
  const exported = (() => {
    if (format === 'v2') {
      const envelope = buildResearchCaptureExportEnvelope(chunk, metadata, entries, null)
      return {
        bytes: Result.getOrThrow(decodeResearchCaptureExportEnvelope(envelope)),
        objects: [envelope],
        lastIndexHash: envelope.contentHash,
      }
    }
    const objects = buildResearchCaptureExportChunk(chunk, metadata, entries, null)
    return {
      bytes: {
        metadata,
        raw: objects.raw.payload,
        index: { contentHash: objects.index.contentHash, payload: Buffer.from(objects.index.payload).toString('utf8') },
      },
      objects: Object.values(objects),
      lastIndexHash: objects.index.contentHash,
    }
  })()
  const seal = encodeResearchCapture({
    schemaVersion: 'bayn.research-capture-seal.v1',
    qualification: CaptureQualification.Unqualified,
    captureId: 'capture-1',
    sourceRevision: 'a'.repeat(40),
    closedAtMs: at + 215,
    observedReceipts: selected.at(-1)?.sequence ?? 0,
    persistedReceipts: selected.at(-1)?.sequence ?? 0,
    persistedChunks: 1,
    lastContentHash: metadata.contentHash,
    invalidations: [],
    exportRoot: {
      schemaVersion: format === 'v2' ? 'bayn.research-capture-export-root.v2' : 'bayn.research-capture-export-root.v1',
      exportedChunks: 1,
      lastIndexHash: exported.lastIndexHash,
    },
  })
  const manifest = Result.getOrThrow(deriveResearchCaptureExportManifest(seal))
  const manifestBytes = { contentHash: manifest.contentHash, payload: Buffer.from(manifest.payload).toString('utf8') }
  const chunks = [exported.bytes]
  const stored = new Map(
    [...exported.objects, manifest, { contentHash: seal.contentHash, payload: Buffer.from(seal.payload) }].map(
      (object) => [object.contentHash, object.payload],
    ),
  )
  return { chunks, seal, manifestBytes, stored, receipts: selected, projection }
}

test.each(['v1', 'v2'] as const)(
  'a sealed %s active-worker interval replays exact bytes, timestamps, dispositions and receipt order without STOPPED',
  async (format) => {
    const data = fixture(undefined, format)
    expect(Result.isFailure(verifyResearchCaptureExport(data.chunks, data.seal, data.manifestBytes))).toBe(true)
    expect(
      Result.getOrThrow(verifyResearchCaptureExportPrefix(data.chunks, data.seal, data.manifestBytes))
        .structurallyClosed,
    ).toBe(false)
    const replay = Result.getOrThrow(
      replayResearchCaptureInterval(data.chunks, data.seal, data.manifestBytes, request, universe),
    )
    expect(replay.qualification).toBe(CaptureQualification.Unqualified)
    expect(replay.structurallyClosed).toBe(false)
    expect(replay.controllerCoverage).toBe('UNKNOWN')
    expect(replay.manifest.nativeVisiblePartitions).toHaveLength(25)
    expect(replay.manifest.recordCount).toBe(11)
    expect(replay.events.map((event) => event.availableAtMs)).toEqual(Array(11).fill(at + 100))
    expect(replay.cursor.projection.sequence).toBe(data.projection.sequence)
    expect(replay.cursor.projection.quotes).toEqual(data.projection.quotes)
    expect(replay.cursor.projection.rejections).toEqual(data.projection.rejections)
    const original = replay.events.filter(
      (event) => 'schemaVersion' in event && event.schemaVersion === 'bayn.original-market-arrival.v2',
    )
    expect(original.map((event) => event.receipt.disposition)).toEqual([
      CaptureDisposition.Accepted,
      CaptureDisposition.Ignored,
      CaptureDisposition.Rejected,
      CaptureDisposition.Rejected,
      CaptureDisposition.Accepted,
      CaptureDisposition.Rejected,
      CaptureDisposition.Rejected,
      CaptureDisposition.Rejected,
      CaptureDisposition.Rejected,
      CaptureDisposition.Rejected,
      CaptureDisposition.Rejected,
    ])
    expect(original[2]?.rawValueBase64).toBe('gA==')
    expect(original[3]?.rawValueBase64).toBe('')
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* fs.makeTempFileScoped()
          yield* fs.writeFile(path, replay.bytes)
          const source = yield* openBacktestSource(path, replay.manifest, 'b'.repeat(64), replay.sourceReceipt)
          yield* source.advanceTo(at + 99)
          expect((yield* source.cursor).processedRecords).toBe(0)
          yield* source.finish
          const cursor = yield* source.cursor
          expect(cursor.processedRecords).toBe(11)
          expect(cursor.projection.quotes).toEqual(data.projection.quotes)
          expect(cursor.projection.rejections).toEqual(data.projection.rejections)
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  },
)

test.each(['v1', 'v2'] as const)(
  '%s reader follows only the durable root, checks actual objects and exact SQL metadata, and enforces its budget',
  async (format) => {
    const data = fixture(undefined, format)
    const read = (maximumBytes: number, missing?: string, corruptSql = false) =>
      readResearchCaptureInterval({
        seal: data.seal,
        maximumBytes,
        request,
        universe,
        readObject: (hash, limit) =>
          Effect.sync(() => {
            const value = hash === missing ? undefined : data.stored.get(hash)
            if (value === undefined || value.byteLength > limit) throw new Error('fixture bounded read refused')
            return value
          }),
        readMetadataChunk: (_ordinal, limit) =>
          Effect.sync(() => {
            const chunk = corruptSql ? { ...data.chunks[0].metadata, payload: '{}' } : data.chunks[0].metadata
            if (Buffer.byteLength(chunk.payload, 'utf8') > limit)
              throw new Error('Fixture SQL read exceeds its byte limit')
            return chunk
          }),
      })

    const replay = await Effect.runPromise(read(1024 * 1024))
    expect(replay.manifest.recordCount).toBe(11)
    expect(Result.isFailure(await Effect.runPromise(read(10).pipe(Effect.result)))).toBe(true)
    expect((await Effect.runPromiseExit(read(1024 * 1024, data.manifestBytes.contentHash)))._tag).toBe('Failure')
    expect(Result.isFailure(await Effect.runPromise(read(1024 * 1024, undefined, true).pipe(Effect.result)))).toBe(true)
  },
)

test.each(['v1', 'v2'] as const)(
  '%s capture budget charges SQL metadata and passes its exact allowed size to the reader',
  async (format) => {
    const data = fixture(undefined, format)
    const metadata = data.chunks[0].metadata
    const sqlBytes = Buffer.byteLength(metadata.payload, 'utf8')
    const objectBytes = [...data.stored.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0)
    const totalBytes = Buffer.byteLength(data.seal.payload, 'utf8') + objectBytes + sqlBytes
    const limits: number[] = []
    const read = (maximumBytes: number, oversizedSql = false) =>
      readResearchCaptureInterval({
        seal: data.seal,
        maximumBytes,
        request,
        universe,
        readObject: (hash, limit) => {
          const value = data.stored.get(hash)
          return value === undefined || value.byteLength > limit
            ? Effect.fail(
                new ResearchCaptureFailure({ message: 'Fixture object is missing or exceeds its read limit' }),
              )
            : Effect.succeed(value)
        },
        readMetadataChunk: (_ordinal, limit) => {
          limits.push(limit)
          return Effect.succeed(oversizedSql ? { ...metadata, payload: `${metadata.payload}é` } : metadata)
        },
      })
    expect((await Effect.runPromise(read(totalBytes))).manifest.recordCount).toBe(11)
    expect(limits).toEqual([sqlBytes])
    expect(Result.isFailure(await Effect.runPromise(read(totalBytes - 1).pipe(Effect.result)))).toBe(true)
    expect(Result.isFailure(await Effect.runPromise(read(totalBytes - sqlBytes).pipe(Effect.result)))).toBe(true)
    const oversized = await Effect.runPromise(read(totalBytes, true).pipe(Effect.result))
    if (Result.isSuccess(oversized)) throw new Error('Oversized SQL response was accepted')
    expect(oversized.failure.message).toBe('SQL metadata reader exceeded its byte limit')
  },
)

for (const [name, mutate] of [
  [
    'missing delivered record',
    (receipts: ResearchCaptureReceipt[]) =>
      receipts.filter((receipt) => !(receipt.event.kind === 'market-record' && receipt.event.consumerSequence === 5)),
  ],
  [
    'missing final delivery',
    (receipts: ResearchCaptureReceipt[]) =>
      receipts.filter((receipt) => !(receipt.event.kind === 'market-record' && receipt.event.consumerSequence === 11)),
  ],
  [
    'missing cut',
    (receipts: ResearchCaptureReceipt[]) =>
      receipts.filter((receipt) => receipt.event.kind !== 'consumer-interval-cut'),
  ],
  [
    'backdated fence',
    (receipts: ResearchCaptureReceipt[]) =>
      receipts.map((receipt) =>
        receipt.event.kind === 'consumer-interval-cut'
          ? {
              ...receipt,
              event: {
                ...receipt.event,
                committedFence: { ...receipt.event.committedFence, lookupStartedAtMs: at + 199 },
              },
            }
          : receipt,
      ),
  ],
  [
    'missing partition',
    (receipts: ResearchCaptureReceipt[]) =>
      receipts.map((receipt) =>
        receipt.event.kind === 'consumer-interval-cut'
          ? { ...receipt, event: { ...receipt.event, drainedPositions: receipt.event.drainedPositions.slice(1) } }
          : receipt,
      ),
  ],
  [
    'false empty partition',
    (receipts: ResearchCaptureReceipt[]) =>
      receipts.map((receipt) =>
        receipt.event.kind === 'consumer-interval-cut'
          ? {
              ...receipt,
              event: {
                ...receipt.event,
                drainedPositions: receipt.event.drainedPositions.map((position) => ({ ...position, offset: '0' })),
              },
            }
          : receipt,
      ),
  ],
  [
    'wrong disposition',
    (receipts: ResearchCaptureReceipt[]) =>
      receipts.map((receipt) =>
        receipt.event.kind === 'market-record' && receipt.event.consumerSequence === 1
          ? { ...receipt, event: { ...receipt.event, disposition: CaptureDisposition.Ignored } }
          : receipt,
      ),
  ],
  [
    'wrong epoch',
    (receipts: ResearchCaptureReceipt[]) =>
      receipts.map((receipt) =>
        receipt.event.kind === 'consumer-interval-cut'
          ? { ...receipt, event: { ...receipt.event, consumerEpoch: 'other' } }
          : receipt,
      ),
  ],
  [
    'invalidated epoch',
    (receipts: ResearchCaptureReceipt[]) =>
      receipts.map((receipt) =>
        receipt.event.kind === 'consumer-boundary' && receipt.event.phase === 'BOOTSTRAPPED'
          ? { ...receipt, event: { ...receipt.event, phase: 'INVALIDATED' as const } }
          : receipt,
      ),
  ],
] as const)
  test(`interval rejects ${name}`, () => {
    const data = fixture(mutate)
    expect(
      Result.isFailure(replayResearchCaptureInterval(data.chunks, data.seal, data.manifestBytes, request, universe)),
    ).toBe(true)
  })

test('original replay retains the exact compression failure cause', () => {
  const data = fixture()
  const cause = new Error('fixture compression failure')
  const compression = spyOn(zlib, 'gzipSync').mockImplementationOnce(() => {
    throw cause
  })
  try {
    const result = replayResearchCaptureInterval(data.chunks, data.seal, data.manifestBytes, request, universe)
    if (Result.isSuccess(result)) throw new Error('Compression unexpectedly succeeded')
    expect(result.failure).toBeInstanceOf(ResearchCaptureFailure)
    if (result.failure instanceof ResearchCaptureFailure) expect(result.failure.cause).toBe(cause)
  } finally {
    compression.mockRestore()
  }
})

test('a prefix with capture invalidations cannot authorize an otherwise plausible interval', () => {
  const data = fixture()
  const parsed = JSON.parse(data.seal.payload)
  const seal = encodeResearchCapture({ ...parsed, invalidations: [CaptureInvalidation.AssignmentChanged] })
  const object = Result.getOrThrow(deriveResearchCaptureExportManifest(seal))
  expect(
    Result.isFailure(
      replayResearchCaptureInterval(
        data.chunks,
        seal,
        { contentHash: object.contentHash, payload: Buffer.from(object.payload).toString('utf8') },
        request,
        universe,
      ),
    ),
  ).toBe(true)
})

test('original interval uses the existing snapshot and mechanical control-study path without model calls', async () => {
  const historical = historicalStreamingFixture()
  const selectedUniverse: StreamingUniverse = {
    universeId: historical.protocol.universeId,
    universeSymbolHash: historical.protocol.universeSymbolHash,
    symbols: historical.protocol.universe,
    topics: { ...historical.protocol.sourceTopics, features: historical.protocol.streamingInput.featureTopic },
  }
  const expectedPartitions = Object.values(selectedUniverse.topics)
    .flatMap((topic) =>
      Array.from({ length: topic === selectedUniverse.topics.quotes ? 13 : 3 }, (_, partition) => ({
        topic,
        partition,
      })),
    )
    .toSorted((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition)
  let featureSequence = 0
  const arrivals = historical.input.arrivals.events
    .map((arrival) => {
      if (arrival.record.topic !== selectedUniverse.topics.features) return arrival
      const sequence = featureSequence++
      return {
        ...arrival,
        record: { ...arrival.record, partition: sequence % 3, offset: String(Math.floor(sequence / 3)) },
      }
    })
    .toSorted(
      (a, b) =>
        a.availableAtMs - b.availableAtMs ||
        a.record.topic.localeCompare(b.record.topic) ||
        a.record.partition - b.record.partition ||
        Number(BigInt(a.record.offset) - BigInt(b.record.offset)),
    )
  const bounds = expectedPartitions.map(({ topic, partition }) => {
    const matching = arrivals.filter(
      (arrival) => arrival.record.topic === topic && arrival.record.partition === partition,
    )
    return {
      topic,
      partition,
      startOffset: matching[0]?.record.offset ?? '0',
      endOffset: matching.at(-1) === undefined ? '0' : String(BigInt(matching.at(-1)?.record.offset ?? '0') + 1n),
    }
  })
  const open = Date.parse('2026-09-04T13:30:00.000Z')
  const close = Date.parse('2026-09-04T20:00:00.000Z')
  const request = {
    intervalId: 'synthetic-session',
    coverageStartMs: open,
    coverageEndMs: close,
    universeHash: canonicalHashV1(selectedUniverse),
    expectedPartitions,
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const chunks: ResearchCaptureBytes[] = []
        const seals: Array<{ contentHash: string; payload: string }> = []
        const objects = new Map<string, Uint8Array>()
        const recorder = yield* makeResearchCaptureRecorder(
          {
            append: (chunk) =>
              Effect.sync(() => {
                chunks.push(chunk)
              }),
            seal: (seal) =>
              Effect.sync(() => {
                seals.push(seal)
              }),
          },
          {
            captureId: 'snapshot-control-fixture',
            sourceRevision: 'a'.repeat(40),
            maximumQueuedReceipts: 512,
            maximumQueuedBytes: 4 * 1024 * 1024,
            maximumReceiptBytes: 64 * 1024,
            flushIntervalMs: 1000,
            writeTimeoutMs: 1000,
          },
          {
            putVerified: (object) =>
              Effect.sync(() => {
                objects.set(object.contentHash, object.payload)
              }),
          },
        )
        recorder.record(
          { kind: 'consumer-boundary', phase: 'STARTED', consumerEpoch: 'synthetic-epoch', positions: [] },
          open - 2,
        )
        recorder.record(
          {
            kind: 'consumer-boundary',
            phase: 'ASSIGNED',
            consumerEpoch: 'synthetic-epoch',
            positions: bounds.map(({ topic, partition, startOffset }) => ({ topic, partition, offset: startOffset })),
            bootstrap: {
              schemaVersion: 'bayn.kafka-bootstrap.v1',
              epoch: 'synthetic-epoch',
              observedAtMs: open - 1,
              lowerTimestampMs: open - 30 * 60_000,
              timestampPolicy: KafkaBootstrapTimestampPolicy.RetainedBeginning,
              partitions: bounds.map((position) => ({
                ...position,
                logStartOffset: position.startOffset,
                endOffset: position.startOffset,
              })),
            },
          },
          open - 1,
        )
        recorder.record(
          {
            kind: 'consumer-boundary',
            phase: 'BOOTSTRAPPED',
            consumerEpoch: 'synthetic-epoch',
            positions: bounds.map((position) => ({
              topic: position.topic,
              partition: position.partition,
              offset: position.startOffset,
            })),
          },
          open,
        )
        let projection = emptyStreamingProjection('synthetic-epoch')
        for (const [index, arrival] of arrivals.entries()) {
          const value = Buffer.from(arrival.record.value)
          const payload = JSON.parse(arrival.record.value)
          const timestampMs = payload.computedAtMs ?? Date.parse(payload.ingestTs)
          const previous = projection
          projection = incorporateMarketRecord(
            projection,
            { ...arrival.record, timestampMs },
            selectedUniverse,
            arrival.availableAtMs,
          )
          recorder.record(
            {
              kind: 'market-record',
              consumerEpoch: 'synthetic-epoch',
              consumerSequence: index + 1,
              projectionSequence: projection.sequence,
              topic: arrival.record.topic,
              partition: arrival.record.partition,
              offset: arrival.record.offset,
              originalTransport: captureKafkaTransport(timestampMs),
              rawValueSha256: sha256(value),
              rawByteLength: value.byteLength,
              tombstone: false,
              bootstrap: false,
              disposition: kafkaCaptureDisposition(previous, projection),
            },
            arrival.availableAtMs,
            value,
          )
        }
        const positions = bounds.map((position) => ({
          topic: position.topic,
          partition: position.partition,
          offset: position.endOffset,
        }))
        recorder.record(
          {
            kind: 'consumer-interval-cut',
            schemaVersion: 'bayn.native-visible-input-cut.v1',
            ...request,
            consumerEpoch: 'synthetic-epoch',
            transport: {
              sdk: '@platformatic/kafka',
              version: '2.12.1',
              isolation: 'READ_COMMITTED',
              mode: 'MANUAL',
              fallback: 'FAIL',
              deserializationFailure: 'FAIL',
            },
            committedFence: { lookupStartedAtMs: close, lookupCompletedAtMs: close + 1, positions },
            drainedPositions: positions,
            finalConsumerSequence: arrivals.length,
          },
          close + 2,
        )
        yield* recorder.finish
        const seal = seals[0]
        if (seal === undefined) throw new Error('Fixture did not persist a seal')
        const replay = yield* readResearchCaptureInterval({
          seal,
          maximumBytes: 8 * 1024 * 1024,
          request,
          universe: selectedUniverse,
          readObject: (hash, limit) =>
            Effect.sync(() => {
              const bytes = objects.get(hash)
              if (bytes === undefined || bytes.byteLength > limit)
                throw new Error('Missing or oversized fixture object')
              return bytes
            }),
          readMetadataChunk: (ordinal, limit) =>
            Effect.sync(() => {
              const chunk = chunks[ordinal]
              if (chunk === undefined || Buffer.byteLength(chunk.payload, 'utf8') > limit)
                throw new Error('Missing or oversized fixture SQL chunk')
              return chunk
            }),
        })
        const fs = yield* FileSystem.FileSystem
        const path = yield* fs.makeTempFileScoped()
        yield* fs.writeFile(path, replay.bytes)
        const source = yield* openBacktestSource(path, replay.manifest, 'b'.repeat(64), replay.sourceReceipt)
        yield* source.advanceTo(Date.parse(historical.query.observedAt))
        const snapshot = Result.getOrThrow(
          constructSimulatedSnapshot(yield* source.cursor, source.source, historical.query),
        )
        const native = Result.getOrThrow(
          constructStreamingSnapshot(
            {
              projection,
              positions,
              bootstrap: {
                schemaVersion: 'bayn.kafka-bootstrap.v1',
                epoch: 'synthetic-epoch',
                observedAtMs: open - 1,
                lowerTimestampMs: open - 30 * 60_000,
                timestampPolicy: KafkaBootstrapTimestampPolicy.RetainedBeginning,
                partitions: bounds.map((position) => ({ ...position, logStartOffset: position.startOffset })),
              },
            },
            historical.query,
          ),
        )
        expect(snapshot.bars).toEqual(native.bars)
        expect(snapshot.quotes).toEqual(native.quotes)
        expect(snapshot.trades).toEqual(native.trades)
        const { verification: _verification, ...build } = runtimeConfig.build
        const report = yield* runControlStudy(
          {
            schemaVersion: 'bayn.control-study-input.v2',
            management: ControlManagementMode.Mechanical,
            decisionLatencyMs: 1000,
            repeatedTargetWeightPpm: 100000,
            backtest: {
              schemaVersion: 'bayn.backtest.v3',
              inference: {
                mode: 'measured-provider',
                model: jevModel,
                inputDefinition: 'bayn.jev-trading-signal-state.v2',
                costs: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
              },
              allocatedDataCostPerSessionMicros: '0',
              replicate: 'original-interval-fixture',
              sessionDates: ['2026-09-04'],
              source: replay.manifest,
              openingCashMicros: '100000000000',
              fractionalTrading: false,
              calendar: [...historical.input.calendar, { date: '2026-09-08', open: '09:30', close: '16:00' }],
              assets: historical.protocol.universe.map((symbol, index) => ({
                id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
                symbol,
                class: 'us_equity',
                exchange: 'NASDAQ',
                status: 'active',
                tradable: true,
                fractionable: true,
              })),
              assetObservationAt: '2026-09-04T13:29:00.000Z',
              assetObservationPolicy: 'retained-as-of-session',
              build,
              assumptions: {
                latencyMs: 100,
                slippageBps: 1,
                availableLiquidityPpm: 1000000,
                feeMultiplierPpm: 1000000,
              },
              cadence: {
                pollIntervalMs: 30000,
                reconciliationIntervalMs: 30000,
                reconciliationPassTimeoutMs: 30000,
                reconciliationStaleThresholdMs: 120000,
              },
            },
          },
          path,
          replay.sourceReceipt,
          { mode: ControlManagementMode.Mechanical },
        ).pipe(Effect.provide(TestClock.layer()))
        expect(report.sessions).toHaveLength(3)
        expect(report.sessions.every((session) => session.modelCallCount === 0)).toBe(true)
        expect(report.sessions.every((session) => session.completion === 'INCOMPLETE')).toBe(true)
        expect(replay.controllerCoverage).toBe('UNKNOWN')
        yield* source.finish
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
})
