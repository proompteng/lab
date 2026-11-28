import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Redacted, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../src/effect-test-support'
import { checkAnalysesOffline } from './auto-ontology-postgres'

const notReady = String.raw`
process.exitCode = 99
process.on('SIGINT', () => process.exit(0))
process.stdin.resume()
process.stderr.write('starting up\n')
`

const scratchCheck = (scenario: 'native' | 'early-exit' | 'not-ready') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const native = yield* ChildProcessSpawner.ChildProcessSpawner
    const parentDirectory = yield* fs.makeTempDirectoryScoped({ prefix: 'bo-' })
    const directories: string[] = []
    const processes: ChildProcessSpawner.ChildProcessHandle[] = []
    const releases: string[] = []
    const waiting = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>()

    // Keep failures in the assertions from leaving fixture processes behind.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        processes,
        (child) => child.kill({ forceKillAfter: '1 second' }).pipe(Effect.when(child.isRunning), Effect.ignore),
        { discard: true },
      ),
    )

    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== 'StandardCommand') return yield* Effect.die('Expected a single scratch command')
        const { command: name, options } = command
        let executable = command
        if (scenario !== 'native') {
          let script = ''
          if (name === 'postgres') script = scenario === 'early-exit' ? 'process.exitCode = 42' : notReady
          executable = ChildProcess.make(process.execPath, ['-e', script], { ...options, stdin: 'pipe' })
        }
        // Registered before spawn so the real process finalizer runs first.
        yield* Effect.addFinalizer(() => Effect.sync(() => void releases.push(name)))
        const child = yield* native.spawn(executable)
        processes.push(child)
        return scenario === 'not-ready' && name === 'postgres'
          ? ChildProcessSpawner.makeHandle({
              ...child,
              stderr: child.stderr.pipe(Stream.tap(() => Deferred.succeed(waiting, child))),
            })
          : child
      }),
    )
    const check = checkAnalysesOffline([]).pipe(
      Effect.provideContext(
        Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner).pipe(
          Context.add(FileSystem.FileSystem, {
            ...fs,
            makeTempDirectoryScoped: (options) =>
              Effect.acquireRelease(
                fs
                  .makeTempDirectory({ ...options, directory: parentDirectory })
                  .pipe(Effect.tap((directory) => Effect.sync(() => void directories.push(directory)))),
                (directory) =>
                  Effect.gen(function* () {
                    for (const child of processes) expect(yield* child.isRunning).toBe(false)
                    yield* fs.remove(directory, { recursive: true })
                    releases.push('directory')
                  }).pipe(Effect.orDie),
              ),
          }),
        ),
      ),
    )

    return {
      check,
      waiting: Deferred.await(waiting),
      expectReleased: (serverExitCode: number) =>
        Effect.gen(function* () {
          expect(releases).toEqual(['initdb', 'postgres', 'directory'])
          expect(directories).toHaveLength(1)
          for (const directory of directories) expect(yield* fs.exists(directory)).toBe(false)
          const exitCodes: readonly number[] = yield* Effect.forEach(processes, (child) => child.exitCode)
          expect(exitCodes).toEqual([0, serverExitCode])
        }),
    }
  })

// The offline check owns its own Unix-socket cluster, not the shared test database.
test.skipIf(process.getuid?.() === 0 || Bun.which('initdb') === null || Bun.which('postgres') === null)(
  'a successful scratch PostgreSQL check releases the server before removing its directory, once',
  () =>
    Effect.runPromise(
      provideTestLayer(
        Effect.gen(function* () {
          const fixture = yield* scratchCheck('native')
          yield* fixture.check
          yield* fixture.expectReleased(0)
        }).pipe(Effect.scoped),
        NodeServices.layer,
      ),
    ),
  15000,
)

test('a server that exits before readiness releases the scratch directory once', () =>
  Effect.runPromise(
    provideTestLayer(
      Effect.gen(function* () {
        const fixture = yield* scratchCheck('early-exit')
        const failure = yield* Effect.flip(fixture.check)
        expect(failure).toMatchObject({
          _tag: 'OntologySyncError',
          operation: 'postgres',
          message: 'Scratch PostgreSQL stopped before accepting connections',
        })
        yield* fixture.expectReleased(42)
      }).pipe(Effect.scoped),
      NodeServices.layer,
    ),
  ))

test.each(['readiness timeout', 'fiber interruption'] as const)(
  '%s stops the running server before removing the scratch directory, once',
  (ending) =>
    Effect.runPromise(
      provideTestLayer(
        Effect.gen(function* () {
          const fixture = yield* scratchCheck('not-ready')
          const fiber = yield* Effect.forkChild(fixture.check)
          const server = yield* Effect.raceFirst(
            fixture.waiting,
            Fiber.join(fiber).pipe(Effect.andThen(Effect.die('Scratch check finished without observing startup'))),
          )
          expect(yield* server.isRunning).toBe(true)
          if (ending === 'readiness timeout') {
            yield* TestClock.adjust('15 seconds')
            const failure = yield* Effect.flip(Fiber.join(fiber))
            expect(failure).toMatchObject({ _tag: 'OntologySyncError', operation: 'postgres' })
            expect(Cause.isTimeoutError(failure.cause === undefined ? undefined : Redacted.value(failure.cause))).toBe(
              true,
            )
          } else {
            yield* Fiber.interrupt(fiber)
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          }
          // The helper exits with code 0 only after receiving PostgreSQL's configured SIGINT.
          yield* fixture.expectReleased(0)
        }).pipe(Effect.scoped),
        Layer.merge(NodeServices.layer, TestClock.layer()),
      ).pipe(Effect.timeout('8 seconds')),
    ),
  15000,
)
