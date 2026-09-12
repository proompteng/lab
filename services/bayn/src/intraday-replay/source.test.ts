import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'
import { canonicalHashV1, sha256 } from '../hash'
import { retainedReplayFixture as fixture } from '../testing/retained-replay-fixture'
import { openRetainedReplaySource } from './source'

test('retained source preflights its bytes and advances only available records across the whole file', async () => {
  const data = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped()
      yield* fs.writeFileString(path, data.body)
      const source = yield* openRetainedReplaySource(path, data.manifest, data.input.source.runId)
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
        { body: data.body, manifest: { ...data.manifest, positions: [] } },
        { body: reversed, manifest: { ...data.manifest, dataSha256: sha256(reversed) } },
        {
          body: duplicate,
          manifest: { ...data.manifest, dataSha256: sha256(duplicate), recordCount: data.manifest.recordCount + 1 },
        },
      ]
      for (const input of cases) {
        yield* fs.writeFileString(path, input.body)
        expect(
          (yield* Effect.exit(Effect.scoped(openRetainedReplaySource(path, input.manifest, data.input.source.runId))))
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
      yield* fs.writeFileString(path, data.body)
      const source = yield* openRetainedReplaySource(path, data.manifest, data.input.source.runId)
      yield* fs.writeFileString(path, 'changed in place\n')
      yield* fs.remove(path)
      yield* fs.writeFileString(path, 'replacement file\n')
      yield* source.finish
      expect((yield* source.cursor).processedRecords).toBe(data.events.length)
      expect((yield* source.cursor).projection.sequence).toBe(data.input.cursor.projection.sequence)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
