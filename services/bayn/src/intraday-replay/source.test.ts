import { expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { NodeServices } from '@effect/platform-node'
import { Clock, Deferred, Effect, Fiber, FileSystem, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { makeReplayTimeline } from './session'
import { sha256, canonicalHashV1Result } from '../hash'
import { retainedReplayFixture as fixture, retainedReplayCaptureFixture } from '../testing/retained-replay-fixture'
import {
  openBacktestSource,
  ReplaySourceFailure,
  validateBacktestSourceCuts,
  validateBacktestSourceManifest,
  validateBacktestSourceReceipt,
} from './source'
import { cryptoMarketProfile } from '../jev/markets'
import { backtestSourcePartitions } from './source'
import {
  kafkaCaptureDisposition,
  emptyStreamingProjection,
  incorporateMarketRecord,
} from '../market-data/streaming/projection'
import { CaptureDisposition, captureKafkaTransport } from '../market-data/streaming/transport-evidence'

const archiveTopology = (positions: ReturnType<typeof fixture>['manifest']['positions']) => ({
  positions: positions.filter((position) => position.startOffset !== position.endOffsetExclusive),
  archiveUnobservedPartitions: positions
    .filter((position) => position.startOffset === position.endOffsetExclusive)
    .map(({ topic, partition }) => ({ topic, partition })),
})

test.each(['tombstone', 'assignment-invalidated'] as const)(
  'original source cannot execute through native consumer termination: %s',
  async (termination) => {
    const data = fixture()
    const consumerEpoch = 'SYNTHETIC-original-terminal-source'
    const captureId = sha256(consumerEpoch)
    let projection = emptyStreamingProjection(consumerEpoch)
    const events = data.events.map((arrival, index) => {
      const before = projection
      projection = incorporateMarketRecord(
        projection,
        arrival.record,
        data.manifest.marketSources[0],
        arrival.availableAtMs,
      )
      const raw = Buffer.from(arrival.record.value)
      const record = arrival.record
      return {
        schemaVersion: 'bayn.original-market-arrival.v2' as const,
        availableAtMs: arrival.availableAtMs,
        record,
        originalTransport: captureKafkaTransport(undefined),
        rawValueBase64: raw.toString('base64'),
        receipt: {
          captureId,
          consumerEpoch,
          sequence: index + 1,
          consumerSequence: index + 1,
          projectionSequence: projection.sequence,
          disposition: kafkaCaptureDisposition(before, projection),
          tombstone: false,
          rawValueSha256: sha256(raw),
          rawByteLength: raw.byteLength,
        },
      }
    })
    const last = events.at(-1)
    if (last === undefined) throw new Error('Missing synthetic source events')
    const terminal = {
      ...last,
      ...(termination === 'tombstone' ? { record: { ...last.record, value: '' }, rawValueBase64: null } : {}),
      receipt: {
        ...last.receipt,
        sequence: events.length + 1,
        consumerSequence: events.length + 1,
        disposition: termination === 'tombstone' ? CaptureDisposition.Rejected : CaptureDisposition.Ignored,
        ...(termination === 'tombstone'
          ? { tombstone: true, rawValueSha256: null, rawByteLength: null }
          : { reason: 'assignment-invalidated' }),
      },
    }
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      for (const [label, records] of [
        ['valid', events],
        ['terminated', [...events, terminal]],
      ] as const) {
        const bytes = gzipSync(records.map((record) => JSON.stringify(record)).join('\n') + '\n')
        const manifest = {
          ...data.manifest,
          transport: 'original-capture' as const,
          dataSha256: sha256(bytes),
          recordCount: records.length,
          nativeVisiblePartitions: data.manifest.positions.map(({ topic, partition }) => ({ topic, partition })),
          deliveryModel: {
            schemaVersion: 'bayn.original-capture-arrivals.v1' as const,
            description: 'Synthetic native transport termination regression',
            tieBreak: 'availability-receipt-sequence' as const,
            captureId,
            consumerEpoch,
            exportManifestHash: '4'.repeat(64),
            intervalReceiptHash: '5'.repeat(64),
            finalConsumerSequence: records.length,
          },
        }
        const receiptText = JSON.stringify({
          schemaVersion: 'bayn.original-capture-replay-receipt.v2',
          recordedAt: new Date(manifest.coverageEndMs + 1).toISOString(),
          origin: manifest.origin,
          coverageStartMs: manifest.coverageStartMs,
          coverageEndMs: manifest.coverageEndMs,
          marketSources: manifest.marketSources,
          positions: manifest.positions,
          nativeVisiblePartitions: manifest.nativeVisiblePartitions,
          deliveryModel: manifest.deliveryModel,
          sourceDataSha256: manifest.dataSha256,
        })
        const receipt = Result.getOrThrow(validateBacktestSourceReceipt(receiptText, sha256(receiptText)))
        const path = `${directory}/${label}.gz`
        yield* fs.writeFile(path, bytes)
        const opened = yield* Effect.result(openBacktestSource(path, manifest, data.input.source.runId, receipt))
        expect(Result.isSuccess(opened)).toBe(label === 'valid')
      }
    })
    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  },
)

test('one source inventory and pinned receipt bind both markets without dropped or overlapping universes', () => {
  const data = fixture()
  const equity = data.manifest.marketSources[0]
  const crypto = {
    universeId: cryptoMarketProfile.universeId,
    universeSymbolHash: cryptoMarketProfile.universeSymbolHash,
    symbols: cryptoMarketProfile.universe,
    topics: { ...cryptoMarketProfile.sourceTopics, features: cryptoMarketProfile.streamingInput.featureTopic },
  }
  const material = { ...data.manifest, marketSources: [equity, crypto] as const }
  const positions = new Map(
    data.manifest.positions.map((position) => [`${position.topic}:${position.partition}`, position]),
  )
  const manifest = {
    ...material,
    positions: backtestSourcePartitions(material).map(
      ({ topic, partition }) =>
        positions.get(`${topic}:${partition}`) ?? { topic, partition, startOffset: '0', endOffsetExclusive: '0' },
    ),
  }
  expect(Result.isSuccess(validateBacktestSourceManifest(manifest))).toBe(true)
  const receipt = retainedReplayCaptureFixture(manifest)
  expect(Result.isSuccess(validateBacktestSourceCuts(manifest, receipt))).toBe(true)
  const filtered = { ...data.manifest, marketSources: [equity] as const }
  expect(Result.isFailure(validateBacktestSourceCuts(filtered, receipt))).toBe(true)
  expect(Result.isFailure(validateBacktestSourceManifest({ ...manifest, marketSources: [equity] }))).toBe(true)
  for (const changed of [
    { ...crypto, universeId: equity.universeId },
    { ...crypto, symbols: [equity.symbols[0]] },
    { ...crypto, topics: { ...crypto.topics, features: equity.topics.features } },
  ])
    expect(Result.isFailure(validateBacktestSourceManifest({ ...manifest, marketSources: [equity, changed] }))).toBe(
      true,
    )
  expect(
    Result.isFailure(validateBacktestSourceManifest({ ...manifest, schemaVersion: 'bayn.backtest-source.v1' })),
  ).toBe(true)
})

test('archive reconstruction cannot masquerade as a directly captured Kafka stream or prove live availability', () => {
  const data = fixture()
  const manifest = { ...data.manifest, transport: 'archive-reconstruction' as const }
  const { capturedAt, ...cut } = data.capture.value as Extract<
    typeof data.capture.value,
    { schemaVersion: 'bayn.replay-source-capture.v2' }
  >
  const receipt = {
    ...cut,
    schemaVersion: 'bayn.archive-reconstruction-receipt.v2',
    recordedAt: capturedAt,
    origin: manifest.origin,
    queryHashes: ['1'.repeat(64)],
    archiveResponseHashes: ['2'.repeat(64)],
    sourceDataSha256: manifest.dataSha256,
    normalization: 'bayn.archive-envelope-reconstruction.v1',
    originalStreamAvailability: 'NOT_OBSERVED',
    completeness: 'RETAINED_ROWS_ONLY',
    emptyPartitions: 'NO_RETAINED_RECORDS_NOT_PROOF_OF_EMPTY_LOG',
  }
  const text = JSON.stringify(receipt)
  const verified = Result.getOrThrow(validateBacktestSourceReceipt(text, sha256(text)))
  expect(Result.isSuccess(validateBacktestSourceCuts(manifest, verified))).toBe(true)
  expect(Result.isFailure(validateBacktestSourceCuts({ ...manifest, transport: 'captured-kafka' }, verified))).toBe(
    true,
  )
  expect(Result.isFailure(validateBacktestSourceCuts({ ...manifest, dataSha256: '3'.repeat(64) }, verified))).toBe(true)
  const claimedLive = JSON.stringify({ ...receipt, originalStreamAvailability: 'OBSERVED' })
  expect(Result.isFailure(validateBacktestSourceReceipt(claimedLive, sha256(claimedLive)))).toBe(true)
})

test('archive reconstruction rejects invented empty cuts while captured empty cuts remain valid', () => {
  const data = fixture()
  const positions = data.manifest.positions.map((position, index) =>
    index === 0 ? { ...position, endOffsetExclusive: position.startOffset } : position,
  )
  expect(Result.isSuccess(validateBacktestSourceManifest({ ...data.manifest, positions }))).toBe(true)
  expect(
    Result.isFailure(
      validateBacktestSourceManifest({ ...data.manifest, positions, transport: 'archive-reconstruction' }),
    ),
  ).toBe(true)
})

test('archive reconstruction accounts for partitions without retained rows without inventing empty log offsets', () => {
  const data = fixture()
  const missing = data.manifest.positions[0]
  if (missing === undefined) throw new Error('Fixture partition missing')
  const partition = { topic: missing.topic, partition: missing.partition }
  const manifest = {
    ...data.manifest,
    transport: 'archive-reconstruction' as const,
    ...archiveTopology(data.manifest.positions.slice(1)),
    archiveUnobservedPartitions: [
      partition,
      ...archiveTopology(data.manifest.positions.slice(1)).archiveUnobservedPartitions,
    ],
  }
  expect(Result.isSuccess(validateBacktestSourceManifest(manifest))).toBe(true)
  expect(Result.isFailure(validateBacktestSourceManifest({ ...manifest, archiveUnobservedPartitions: [] }))).toBe(true)
  expect(Result.isFailure(validateBacktestSourceManifest({ ...manifest, positions: data.manifest.positions }))).toBe(
    true,
  )
  expect(Result.isFailure(validateBacktestSourceManifest({ ...manifest, transport: 'captured-kafka' }))).toBe(true)
  expect(
    Result.isFailure(
      validateBacktestSourceManifest({ ...manifest, archiveUnobservedPartitions: [partition, partition] }),
    ),
  ).toBe(true)
})

for (const { name, rolling, technical } of [
  { name: 'original features', rolling: false, technical: false },
  { name: 'regenerated rolling only', rolling: true, technical: false },
  { name: 'regenerated technical only', rolling: false, technical: true },
  { name: 'both regenerated feature families', rolling: true, technical: true },
])
  test(`captured source binds separate rolling and technical partition counts: ${name}`, () => {
    const { regeneratedFeaturesRecordedAtMs: _recordedAt, ...base } = fixture().manifest
    const topics = { ...base.marketSources[0].topics, technicalFeatures: 'torghut.technical-features.v1' }
    const expectedCounts = [
      [topics.bars, 3],
      [topics.quotes, 13],
      [topics.trades, 3],
      [topics.features, rolling ? 1 : 3],
      [topics.technicalFeatures, technical ? 1 : 3],
    ] as const
    const manifest = {
      ...base,
      transport: 'captured-kafka' as const,
      marketSources: [{ ...base.marketSources[0], topics }] as const,
      ...(rolling ? { regeneratedFeaturesRecordedAtMs: base.lastAvailableAtMs } : {}),
      ...(technical ? { regeneratedTechnicalFeaturesRecordedAtMs: base.lastAvailableAtMs } : {}),
      positions: expectedCounts
        .flatMap(([topic, count]) =>
          Array.from({ length: count }, (_, partition) => ({
            topic,
            partition,
            startOffset: '0',
            endOffsetExclusive: '1',
          })),
        )
        .toSorted((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition),
    }
    expect(Result.getOrThrow(validateBacktestSourceManifest(manifest))).toEqual(manifest)
  })

test('retained source preflights its bytes and advances only available records across the whole file', async () => {
  const data = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      yield* fs.writeFile(path, gzipSync(data.body))
      const source = yield* openBacktestSource(path, data.manifest, data.input.source.runId, data.capture)
      expect(source.source.sourceManifestHash).toBe(Result.getOrThrow(canonicalHashV1Result(data.manifest)))
      yield* source.advanceTo(data.manifest.firstAvailableAtMs - 1)
      expect((yield* source.cursor).processedRecords).toBe(0)
      yield* source.advanceTo(data.manifest.lastAvailableAtMs)
      expect((yield* source.cursor).processedRecords).toBe(data.events.length)
      expect((yield* source.cursor).projection.sequence).toBe(data.input.cursor.projection.sequence)
      yield* source.advanceTo(data.manifest.lastAvailableAtMs + 1000)
      yield* source.finish
      expect((yield* Effect.exit(source.advanceTo(data.manifest.firstAvailableAtMs)))._tag).toBe('Failure')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('the retained source delivers each accepted quote to one scoped broker in availability order', async () => {
  const data = fixture()
  const quotes: { at: number; offset: string; topic: string }[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      yield* fs.writeFile(path, gzipSync(data.body))
      const source = yield* openBacktestSource(path, data.manifest, data.input.source.runId, data.capture)
      yield* Effect.scoped(source.observeBroker(() => Effect.void))
      yield* source.observeBroker((at, quote) =>
        Effect.sync(() => {
          if (quote !== null) {
            expect(quote.availableAtMs).toBe(at)
            quotes.push({ at, offset: quote.value.sourceOffset, topic: quote.value.sourceTopic })
          }
        }),
      )
      expect((yield* Effect.exit(source.observeBroker(() => Effect.void)))._tag).toBe('Failure')
      yield* source.advanceTo(data.manifest.lastAvailableAtMs)
      expect(quotes).toEqual(
        data.events
          .filter((event) => event.record.topic === data.manifest.marketSources[0].topics.quotes)
          .map((event) => ({ at: event.availableAtMs, offset: event.record.offset, topic: event.record.topic })),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test.each(['failure', 'defect', 'interruption'] as const)(
  'a broker %s prevents further source advancement',
  async (kind) => {
    const data = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* fs.makeTempFileScoped()
        yield* fs.writeFile(path, gzipSync(data.body))
        const source = yield* openBacktestSource(path, data.manifest, data.input.source.runId, data.capture)
        const entered = yield* Deferred.make<void>()
        yield* source.observeBroker(() =>
          kind === 'failure'
            ? Effect.fail(new ReplaySourceFailure({ message: 'synthetic settlement failure' }))
            : kind === 'defect'
              ? Effect.die(new Error('synthetic settlement defect'))
              : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        if (kind === 'interruption') {
          const pending = yield* source
            .advanceTo(data.manifest.lastAvailableAtMs)
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(pending)
        } else expect((yield* Effect.exit(source.advanceTo(data.manifest.lastAvailableAtMs)))._tag).toBe('Failure')
        const failed = yield* source.cursor
        expect((yield* Effect.exit(source.advanceTo(data.manifest.lastAvailableAtMs + 1)))._tag).toBe('Failure')
        expect(yield* source.cursor).toEqual(failed)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    )
  },
)

test('a delayed source tail is consumed after trading stops without advancing execution or database time', async () => {
  const data = fixture()
  const closeMs = data.manifest.lastAvailableAtMs - 35
  const sqlTimes: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      yield* fs.writeFile(path, gzipSync(data.body))
      const source = yield* openBacktestSource(path, data.manifest, data.input.source.runId, data.capture)
      yield* TestClock.setTime(closeMs - 1)
      const brokerTimes: number[] = []
      yield* source.observeBroker((at) =>
        Effect.sync(() => {
          brokerTimes.push(at)
        }),
      )
      const { advanceTo: advance } = yield* makeReplayTimeline(
        source,
        {
          advanceTo: (at) =>
            Effect.sync(() => {
              sqlTimes.push(at)
            }),
        },
        closeMs + 1,
      )
      yield* advance(closeMs + 1)
      expect((yield* source.cursor).processedRecords).toBeLessThan(data.events.length)
      const beforeTail = [...sqlTimes]
      const brokerBeforeTail = [...brokerTimes]
      yield* source.finish
      expect((yield* source.cursor).processedRecords).toBe(data.events.length)
      expect(yield* Clock.currentTimeMillis).toBe(closeMs + 1)
      expect(sqlTimes).toEqual(beforeTail)
      expect(brokerTimes).toEqual(brokerBeforeTail)
      expect((yield* Effect.exit(advance(data.manifest.lastAvailableAtMs)))._tag).toBe('Failure')
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer)),
  )
})

test('retained source rejects changed bytes, count, bounds, ordering and duplicate offsets before execution', async () => {
  const data = fixture()
  const reversed =
    [...data.events]
      .reverse()
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n'
  const duplicate = data.body + JSON.stringify(data.events.at(-1)) + '\n'
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      const cases = [
        { body: data.body + ' ', manifest: data.manifest },
        { body: data.body, manifest: { ...data.manifest, recordCount: data.manifest.recordCount + 1 } },
        { body: data.body, manifest: { ...data.manifest, firstAvailableAtMs: data.manifest.firstAvailableAtMs - 1 } },
        { body: data.body, manifest: { ...data.manifest, lastAvailableAtMs: data.manifest.lastAvailableAtMs + 1 } },
        { body: data.body, manifest: { ...data.manifest, positions: [] } },
        {
          body: data.body,
          manifest: { ...data.manifest, regeneratedTechnicalFeaturesRecordedAtMs: data.manifest.lastAvailableAtMs },
        },
        { body: data.body, manifest: { ...data.manifest, positions: [...data.manifest.positions].reverse() } },
        { body: reversed, manifest: { ...data.manifest, dataSha256: sha256(gzipSync(reversed)) } },
        {
          body: duplicate,
          manifest: {
            ...data.manifest,
            dataSha256: sha256(gzipSync(duplicate)),
            recordCount: data.manifest.recordCount + 1,
          },
        },
      ]
      for (const input of cases) {
        yield* fs.writeFile(path, gzipSync(input.body))
        expect(
          (yield* Effect.exit(
            Effect.scoped(openBacktestSource(path, input.manifest, data.input.source.runId, data.capture)),
          ))._tag,
        ).toBe('Failure')
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('archive reconstruction admits bound retained-coordinate gaps without weakening captured-stream completeness', async () => {
  const data = fixture()
  const bound = data.manifest.positions.find(
    (value) => BigInt(value.endOffsetExclusive) - BigInt(value.startOffset) > 2n,
  )
  if (bound === undefined) throw new Error('Expected a multi-record fixture partition')
  const missingOffset = String(BigInt(bound.startOffset) + 1n)
  const events = data.events.filter(
    ({ record }) =>
      record.topic !== bound.topic || record.partition !== bound.partition || record.offset !== missingOffset,
  )
  const body = gzipSync(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  const manifest = {
    ...data.manifest,
    transport: 'archive-reconstruction' as const,
    ...archiveTopology(data.manifest.positions),
    recordCount: events.length,
    dataSha256: sha256(body),
  }
  const text = JSON.stringify({
    ...data.capture.value,
    schemaVersion: 'bayn.archive-reconstruction-receipt.v2',
    capturedAt: undefined,
    recordedAt: '2026-09-10T00:00:00.000Z',
    origin: manifest.origin,
    queryHashes: ['1'.repeat(64)],
    archiveResponseHashes: ['2'.repeat(64)],
    sourceDataSha256: manifest.dataSha256,
    positions: manifest.positions,
    archiveUnobservedPartitions: manifest.archiveUnobservedPartitions,
    normalization: 'bayn.archive-envelope-reconstruction.v1',
    originalStreamAvailability: 'NOT_OBSERVED',
    completeness: 'RETAINED_ROWS_ONLY',
    emptyPartitions: 'NO_RETAINED_RECORDS_NOT_PROOF_OF_EMPTY_LOG',
  })
  const capture = Result.getOrThrow(validateBacktestSourceReceipt(text, sha256(text)))
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      yield* fs.writeFile(path, body)
      const source = yield* openBacktestSource(path, manifest, data.input.source.runId, capture)
      yield* source.finish
      expect((yield* source.cursor).processedRecords).toBe(events.length)
      expect(
        (yield* Effect.exit(
          openBacktestSource(path, { ...manifest, transport: 'captured-kafka' }, data.input.source.runId, data.capture),
        ))._tag,
      ).toBe('Failure')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('preflight rejects omitted partition endpoints and interior records even when the file hash and count match', async () => {
  const data = fixture()
  const partition = data.manifest.positions[0]
  if (partition === undefined) throw new Error('Fixture requires partition cuts')
  const matching = data.events.filter(
    ({ record }) => record.topic === partition.topic && record.partition === partition.partition,
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      for (const omitted of [matching[0], matching[1], matching.at(-1)]) {
        const events = data.events.filter((event) => event !== omitted)
        const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
        yield* fs.writeFile(path, gzipSync(body))
        const manifest = {
          ...data.manifest,
          dataSha256: sha256(gzipSync(body)),
          recordCount: events.length,
          firstAvailableAtMs: events[0]?.availableAtMs,
          lastAvailableAtMs: events.at(-1)?.availableAtMs,
        }
        expect(
          (yield* Effect.exit(Effect.scoped(openBacktestSource(path, manifest, data.input.source.runId, data.capture))))
            ._tag,
        ).toBe('Failure')
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('execution consumes the validated snapshot after the original file is changed or replaced', async () => {
  const data = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      yield* fs.writeFile(path, gzipSync(data.body))
      const source = yield* openBacktestSource(path, data.manifest, data.input.source.runId, data.capture)
      yield* fs.writeFileString(path, 'changed in place\n')
      yield* fs.remove(path)
      yield* fs.writeFileString(path, 'replacement file\n')
      yield* source.finish
      expect((yield* source.cursor).processedRecords).toBe(data.events.length)
      expect((yield* source.cursor).projection.sequence).toBe(data.input.cursor.projection.sequence)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('an entire omitted partition cannot redefine completeness by changing the file and manifest together', async () => {
  const data = fixture()
  const omitted = data.events[0]?.record
  if (omitted === undefined) throw new Error('fixture must have source records')
  const events = data.events.filter(
    ({ record }) => record.topic !== omitted.topic || record.partition !== omitted.partition,
  )
  const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const manifest = {
    ...data.manifest,
    dataSha256: sha256(gzipSync(body)),
    recordCount: events.length,
    firstAvailableAtMs: events[0]?.availableAtMs,
    lastAvailableAtMs: events.at(-1)?.availableAtMs,
    positions: data.manifest.positions.filter(
      (position) => position.topic !== omitted.topic || position.partition !== omitted.partition,
    ),
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      yield* fs.writeFile(path, gzipSync(body))
      const outcome = yield* Effect.exit(openBacktestSource(path, manifest, data.input.source.runId, data.capture))
      expect(outcome._tag).toBe('Failure')
      expect(JSON.stringify(outcome)).toContain('every partition in the declared source topology')
      expect(
        data.manifest.positions.filter((position) => position.topic === data.manifest.marketSources[0].topics.quotes),
      ).toHaveLength(13)
      expect(data.manifest.positions.some((position) => position.startOffset === position.endOffsetExclusive)).toBe(
        true,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('one partition cannot redefine its captured prefix or suffix while other arrivals preserve global coverage', async () => {
  const data = fixture()
  const bound = data.manifest.positions.find(
    (position) => BigInt(position.endOffsetExclusive) - BigInt(position.startOffset) > 2n,
  )
  if (bound === undefined) throw new Error('fixture requires a populated source cut')
  const matching = data.events.filter(
    ({ record }) => record.topic === bound.topic && record.partition === bound.partition,
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      for (const side of ['prefix', 'suffix'] as const) {
        const omitted = side === 'prefix' ? matching[0] : matching.at(-1)
        const events = data.events.filter((event) => event !== omitted)
        const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
        const manifest = {
          ...data.manifest,
          dataSha256: sha256(gzipSync(body)),
          recordCount: events.length,
          firstAvailableAtMs: events[0]?.availableAtMs,
          lastAvailableAtMs: events.at(-1)?.availableAtMs,
          positions: data.manifest.positions.map((position) =>
            position !== bound
              ? position
              : {
                  ...position,
                  ...(side === 'prefix'
                    ? { startOffset: String(BigInt(position.startOffset) + 1n) }
                    : { endOffsetExclusive: String(BigInt(position.endOffsetExclusive) - 1n) }),
                },
          ),
        }
        yield* fs.writeFile(path, gzipSync(body))
        const outcome = yield* Effect.exit(openBacktestSource(path, manifest, data.input.source.runId, data.capture))
        expect(outcome._tag).toBe('Failure')
        expect(JSON.stringify(outcome)).toContain('independently pinned receipt')
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('capture receipt replacement fails against the separately pinned hash', () => {
  const data = fixture()
  const original = JSON.stringify(data.capture.value)
  const pinnedHash = sha256(original)
  expect(Result.isSuccess(validateBacktestSourceReceipt(original, pinnedHash))).toBe(true)
  const changed = JSON.stringify({ ...data.capture.value, positions: data.capture.value.positions.slice(1) })
  const result = validateBacktestSourceReceipt(changed, pinnedHash)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(String(result.failure)).toContain('independently pinned capture hash')
})

test('native crypto source shares three raw channels with one three-partition topic and separate features', () => {
  const data = fixture()
  const native = {
    ...data.manifest,
    marketSources: [
      {
        universeId: cryptoMarketProfile.universeId,
        universeSymbolHash: cryptoMarketProfile.universeSymbolHash,
        symbols: cryptoMarketProfile.universe,
        topics: { ...cryptoMarketProfile.sourceTopics, features: cryptoMarketProfile.streamingInput.featureTopic },
      },
    ] as const,
  }
  const topology = backtestSourcePartitions(native)
  expect(topology).toHaveLength(6)
  expect(new Set(topology.map((p) => `${p.topic}:${p.partition}`)).size).toBe(6)
  expect(topology.filter((p) => p.topic === cryptoMarketProfile.sourceTopics.quotes).map((p) => p.partition)).toEqual([
    0, 1, 2,
  ])
  const manifest = { ...native, positions: topology.map((p) => ({ ...p, startOffset: '0', endOffsetExclusive: '0' })) }
  expect(Result.isSuccess(validateBacktestSourceManifest(manifest))).toBe(true)
  for (const universe of [
    { ...manifest.marketSources[0], universeSymbolHash: 'f'.repeat(64) },
    {
      ...manifest.marketSources[0],
      topics: { ...manifest.marketSources[0].topics, features: manifest.marketSources[0].topics.bars },
    },
    { ...manifest.marketSources[0], topics: { ...manifest.marketSources[0].topics, bars: 'unreviewed.raw' } },
  ])
    expect(Result.isFailure(validateBacktestSourceManifest({ ...manifest, marketSources: [universe] as const }))).toBe(
      true,
    )
})
