import { expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { NodeServices } from '@effect/platform-node'
import { Clock, Effect, FileSystem } from 'effect'
import { TestClock } from 'effect/testing'
import { makeReplayTimeline } from './session'
import { canonicalHashV1, sha256 } from '../hash'
import { retainedReplayFixture as fixture } from '../testing/retained-replay-fixture'
import {
  openBacktestSource,
  validateBacktestSourceCuts,
  validateBacktestSourceManifest,
  validateBacktestSourceReceipt,
} from './source'
import { Result } from 'effect'

const archiveTopology = (positions: ReturnType<typeof fixture>['manifest']['positions']) => ({
  positions: positions.filter((position) => position.startOffset !== position.endOffsetExclusive),
  archiveUnobservedPartitions: positions
    .filter((position) => position.startOffset === position.endOffsetExclusive)
    .map(({ topic, partition }) => ({ topic, partition })),
})

test('archive reconstruction cannot masquerade as a directly captured Kafka stream or prove live availability', () => {
  const data = fixture()
  const manifest = { ...data.manifest, transport: 'archive-reconstruction' as const }
  const { capturedAt, ...cut } = data.capture.value as Extract<
    typeof data.capture.value,
    { schemaVersion: 'bayn.replay-source-capture.v1' }
  >
  const receipt = {
    ...cut,
    schemaVersion: 'bayn.archive-reconstruction-receipt.v1',
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
    const topics = { ...base.universe.topics, technicalFeatures: 'torghut.technical-features.v1' }
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
      universe: { ...base.universe, topics },
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
      expect(source.source.sourceManifestHash).toBe(canonicalHashV1(data.manifest))
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
      yield* source.finish
      expect((yield* source.cursor).processedRecords).toBe(data.events.length)
      expect(yield* Clock.currentTimeMillis).toBe(closeMs + 1)
      expect(sqlTimes).toEqual(beforeTail)
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
    schemaVersion: 'bayn.archive-reconstruction-receipt.v1',
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
        data.manifest.positions.filter((position) => position.topic === data.manifest.universe.topics.quotes),
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
