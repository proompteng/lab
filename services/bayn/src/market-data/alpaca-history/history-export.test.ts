import { gzipSync } from 'node:zlib'
import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Stream } from 'effect'
import { arrivalPosition, compareArrivalPositions, type HistoricalMarketArrival } from '../streaming/historical'
import { mergeArrivalFiles } from '../../../tools/history-export'

const arrival = (file: number, minute: number): HistoricalMarketArrival => ({
  availableAtMs: minute,
  record: { topic: 'bars', partition: 0, offset: String(minute), value: JSON.stringify({ file, minute }) },
})

test('historical merge accepts empty batches without producing invalid gzip intermediates', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const paths: string[] = []
      for (let index = 0; index < 70; index++) {
        const path = `${directory}/${index}.ndjson`
        yield* fs.writeFileString(path, '')
        paths.push(path)
      }
      expect(yield* Stream.runCollect(mergeArrivalFiles(paths))).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('historical merge bounds open inputs across multiple rounds and preserves stable arrival order', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const paths: string[] = []
      const expected: HistoricalMarketArrival[] = []
      for (let index = 0; index < 1_040; index++) {
        const rows = index % 17 === 0 ? [] : [arrival(index, 0), arrival(index, 1)]
        expected.push(...rows)
        const path = `${directory}/${index}.ndjson${index % 2 === 0 ? '.gz' : ''}`
        const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('')
        yield* fs.writeFile(path, index % 2 === 0 ? gzipSync(text) : new TextEncoder().encode(text))
        paths.push(path)
      }
      let open = 0,
        maximumOpen = 0
      const temporaryDirectories: string[] = []
      const tracked: FileSystem.FileSystem = {
        ...fs,
        makeTempDirectoryScoped: (options) =>
          fs
            .makeTempDirectoryScoped(options)
            .pipe(Effect.tap((path) => Effect.sync(() => temporaryDirectories.push(path)))),
        stream: (path, options) =>
          Stream.unwrap(
            Effect.sync(() => {
              maximumOpen = Math.max(maximumOpen, ++open)
              return fs.stream(path, options).pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    open--
                  }),
                ),
              )
            }),
          ),
      }
      const result = yield* Stream.runCollect(mergeArrivalFiles(paths)).pipe(
        Effect.provideService(FileSystem.FileSystem, tracked),
      )
      expect(result).toEqual(expected.sort((a, b) => compareArrivalPositions(arrivalPosition(a), arrivalPosition(b))))
      expect(maximumOpen).toBeLessThanOrEqual(32)
      expect(open).toBe(0)
      for (const path of temporaryDirectories) expect(yield* fs.exists(path)).toBe(false)
      for (const path of paths) expect(yield* fs.exists(path)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
}, 30_000)

for (const failure of ['unsorted', 'defect', 'interruption'] as const)
  test(`historical merge releases streams and intermediate files after ${failure}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const paths: string[] = []
        for (let index = 0; index < 65; index++) {
          const rows =
            index === 34 && failure === 'unsorted' ? [arrival(index, 1), arrival(index, 0)] : [arrival(index, 0)]
          const path = `${directory}/${index}.ndjson`
          yield* fs.writeFileString(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''))
          paths.push(path)
        }
        const entered = yield* Deferred.make<void>()
        let open = 0,
          acquired = 0,
          released = 0
        const temporaryDirectories: string[] = []
        const tracked: FileSystem.FileSystem = {
          ...fs,
          makeTempDirectoryScoped: (options) =>
            fs
              .makeTempDirectoryScoped(options)
              .pipe(Effect.tap((path) => Effect.sync(() => temporaryDirectories.push(path)))),
          stream: (path, options) =>
            Stream.unwrap(
              Effect.gen(function* () {
                yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    open++
                    acquired++
                  }),
                  () =>
                    Effect.sync(() => {
                      open--
                      released++
                    }),
                )
                if (path === paths[34]) {
                  if (failure === 'defect') return yield* Effect.die('merge fixture defect')
                  if (failure === 'interruption') {
                    yield* Deferred.succeed(entered, undefined)
                    return yield* Effect.never
                  }
                }
                return fs.stream(path, options)
              }),
            ),
        }
        const run = Stream.runDrain(mergeArrivalFiles(paths)).pipe(
          Effect.provideService(FileSystem.FileSystem, tracked),
        )
        if (failure === 'interruption') {
          const fiber = yield* Effect.forkChild(run)
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(fiber)
        } else {
          const result = yield* Effect.exit(run)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) {
            if (failure === 'unsorted')
              expect(Cause.pretty(result.cause)).toContain('Historical export input reverses arrival order')
            else expect(Cause.pretty(result.cause)).toContain('merge fixture defect')
          }
        }
        expect(open).toBe(0)
        expect(released).toBe(acquired)
        expect(temporaryDirectories).toHaveLength(1)
        for (const path of temporaryDirectories) expect(yield* fs.exists(path)).toBe(false)
        for (const path of paths) expect(yield* fs.exists(path)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    )
  })
