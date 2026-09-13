import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'
import { canonicalHashV1, sha256 } from '../hash'
import { retainedReplayFixture as fixture } from '../testing/retained-replay-fixture'
import { openRetainedReplaySource, validateRetainedReplayCapture } from './source'
import { Result } from 'effect'

test('retained source preflights its bytes and advances only available records across the whole file', async () => {
  const data = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      yield* fs.writeFileString(path, data.body)
      const source = yield* openRetainedReplaySource(path, data.manifest, data.input.source.runId, data.capture)
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
        { body: data.body, manifest: { ...data.manifest, positions: [...data.manifest.positions].reverse() } },
        { body: reversed, manifest: { ...data.manifest, dataSha256: sha256(reversed) } },
        {
          body: duplicate,
          manifest: { ...data.manifest, dataSha256: sha256(duplicate), recordCount: data.manifest.recordCount + 1 },
        },
      ]
      for (const input of cases) {
        yield* fs.writeFileString(path, input.body)
        expect(
          (yield* Effect.exit(
            Effect.scoped(openRetainedReplaySource(path, input.manifest, data.input.source.runId, data.capture)),
          ))._tag,
        ).toBe('Failure')
      }
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
        yield* fs.writeFileString(path, body)
        const manifest = {
          ...data.manifest,
          dataSha256: sha256(body),
          recordCount: events.length,
          firstAvailableAtMs: events[0]?.availableAtMs,
          lastAvailableAtMs: events.at(-1)?.availableAtMs,
        }
        expect(
          (yield* Effect.exit(
            Effect.scoped(openRetainedReplaySource(path, manifest, data.input.source.runId, data.capture)),
          ))._tag,
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
      yield* fs.writeFileString(path, data.body)
      const source = yield* openRetainedReplaySource(path, data.manifest, data.input.source.runId, data.capture)
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
    dataSha256: sha256(body),
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
      yield* fs.writeFileString(path, body)
      const outcome = yield* Effect.exit(
        openRetainedReplaySource(path, manifest, data.input.source.runId, data.capture),
      )
      expect(outcome._tag).toBe('Failure')
      expect(JSON.stringify(outcome)).toContain('every partition in the Torghut capture topology')
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
          dataSha256: sha256(body),
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
        yield* fs.writeFileString(path, body)
        const outcome = yield* Effect.exit(
          openRetainedReplaySource(path, manifest, data.input.source.runId, data.capture),
        )
        expect(outcome._tag).toBe('Failure')
        expect(JSON.stringify(outcome)).toContain('independently captured session offsets')
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('capture receipt replacement fails against the separately pinned hash', () => {
  const data = fixture()
  const original = JSON.stringify(data.capture.value)
  const pinnedHash = sha256(original)
  expect(Result.isSuccess(validateRetainedReplayCapture(original, pinnedHash))).toBe(true)
  const changed = JSON.stringify({ ...data.capture.value, positions: data.capture.value.positions.slice(1) })
  const result = validateRetainedReplayCapture(changed, pinnedHash)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(String(result.failure)).toContain('independently pinned capture hash')
})
