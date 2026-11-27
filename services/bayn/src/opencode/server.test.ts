import { expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { Cause, Clock, Deferred, Effect, Exit, Fiber, FileSystem, Sink, Stream } from 'effect'
import { HttpClient, HttpClientError, HttpClientResponse, HttpServer } from 'effect/http'
import { NetAddress } from 'effect/net'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'

import { openCodeVersion } from './configuration'
import { serveOpenCode } from './server'

type Probe =
  | 'ready'
  | 'wrong-version'
  | 'wrong-version-starting'
  | 'unauthorized'
  | 'failed'
  | 'waiting'
  | 'stalled-once'
  | 'recovering'
  | 'starting'
  | 'defect'

const harness = (probe: Probe) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-opencode-startup-' })
    const probed = yield* Deferred.make<void>()
    const serving = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>()
    const commands: ChildProcess.StandardCommand[] = []
    const children: ChildProcessSpawner.ChildProcessHandle[] = []
    const observations = { probes: 0, authenticated: 0, cancelled: 0, released: 0, providerCalls: 0, stoppedAt: -1 }
    const defect = new Error('native probe defect')
    let expectedAuthorization: string | undefined
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (command._tag !== 'StandardCommand') throw new Error('Native harness requires one standard command')
          commands.push(command)
          const password = command.options.env?.['OPENCODE_SERVER_PASSWORD']
          if (typeof password !== 'string' || !/^[0-9a-f]{64}$/.test(password))
            throw new Error('Native harness requires a fresh private password')
          expectedAuthorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
          const versionProbe = command.args[0] === '--version'
          let running = !versionProbe
          const output = versionProbe
            ? Stream.make(new TextEncoder().encode(`opencode v${openCodeVersion}\n`))
            : Stream.empty
          const handle = ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(100 + commands.length),
            exitCode: versionProbe ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Deferred.await(exited),
            isRunning: Effect.sync(() => running),
            kill: () =>
              Effect.sync(() => {
                running = false
              }),
            stdin: Sink.drain,
            stdout: output,
            stderr: Stream.empty,
            all: output,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
          children.push(handle)
          return handle
        }),
        (child) =>
          child.kill().pipe(
            Effect.orDie,
            Effect.andThen(
              Effect.sync(() => {
                observations.released += 1
              }),
            ),
          ),
      ),
    )
    const native = HttpClient.make((request) =>
      Effect.gen(function* () {
        observations.probes += 1
        yield* Deferred.succeed(probed, undefined)
        if (probe === 'defect') return yield* Effect.die(defect)
        if (probe === 'waiting' || (probe === 'stalled-once' && observations.probes === 1))
          return yield* Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                observations.cancelled += 1
              }),
            ),
          )
        if (probe === 'recovering' && observations.probes === 1)
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error('connection refused') }),
          })
        const authenticated = request.headers['authorization'] === expectedAuthorization
        if (authenticated) observations.authenticated += 1
        const status =
          !authenticated || probe === 'unauthorized'
            ? 401
            : probe === 'failed'
              ? 500
              : probe === 'wrong-version-starting' || (probe === 'starting' && observations.probes === 1)
                ? 503
                : 200
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ version: probe.startsWith('wrong-version') ? '0.0.0' : openCodeVersion }), {
            status,
          }),
        )
      }),
    )
    const upstream = HttpClient.make(() =>
      Effect.sync(() => {
        observations.providerCalls += 1
      }).pipe(Effect.andThen(Effect.never)),
    )
    const server = serveOpenCode(
      { sourceRevision: 'a'.repeat(40), proxy: 'http://127.0.0.1:9', binary: '/pinned/opencode' },
      upstream,
      { directory, nativePort: 0, relayPort: 0 },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HttpClient.HttpClient, native),
      Effect.provideService(
        HttpServer.HttpServer,
        HttpServer.make({
          address: NetAddress.inetAddressFromIpStringUnsafe('127.0.0.1', 0),
          serve: () => Deferred.succeed(serving, undefined).pipe(Effect.asVoid),
        }),
      ),
      Effect.onExit(() =>
        Effect.gen(function* () {
          observations.stoppedAt = yield* Clock.currentTimeMillis
          yield* Deferred.succeed(stopped, undefined)
        }),
      ),
    )
    return { server, probed, serving, stopped, exited, commands, children, observations, defect }
  })

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

test('one native process proves its live identity before serving and remains owned until interruption', async () => {
  await run(
    Effect.gen(function* () {
      const fixture = yield* harness('ready')
      const fiber = yield* fixture.server.pipe(Effect.forkScoped)
      yield* Deferred.await(fixture.serving).pipe(Effect.raceFirst(Fiber.join(fiber)))
      expect(fixture.commands.length).toBe(1)
      expect(fixture.commands[0]?.args[0]).toBe('serve')
      expect(fixture.commands[0]?.options.extendEnv).not.toBe(true)
      expect(fixture.observations.authenticated).toBe(1)
      expect(fixture.observations.released).toBe(0)
      expect(fixture.observations.providerCalls).toBe(0)
      for (const child of fixture.children) expect(yield* child.isRunning).toBe(true)
      yield* Fiber.interrupt(fiber)
      expect(fixture.observations.released).toBe(1)
      for (const child of fixture.children) expect(yield* child.isRunning).toBe(false)
    }).pipe(Effect.scoped),
  )
})

test.each([
  ['wrong-version', 'pinned harness version'],
  ['wrong-version-starting', 'pinned harness version'],
  ['unauthorized', 'HTTP 401'],
  ['failed', 'HTTP 500'],
] as const)('rejects %s before serving or provider I/O', async (probe, message) => {
  await run(
    Effect.gen(function* () {
      const fixture = yield* harness(probe)
      const fiber = yield* fixture.server.pipe(Effect.forkScoped)
      yield* Deferred.await(fixture.probed)
      yield* TestClock.adjust('25 seconds')
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '').toContain(message)
      expect(fixture.observations.probes).toBe(1)
      expect(fixture.observations.authenticated).toBe(1)
      expect(fixture.observations.stoppedAt).toBe(0)
      expect(yield* Deferred.isDone(fixture.serving)).toBe(false)
      expect(fixture.observations.providerCalls).toBe(0)
      expect(fixture.observations.released).toBe(1)
      for (const child of fixture.children) expect(yield* child.isRunning).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test.each([0, 17])('reports native exit code %i while a readiness request is still pending', async (code) => {
  await run(
    Effect.gen(function* () {
      const fixture = yield* harness('waiting')
      const fiber = yield* fixture.server.pipe(Effect.forkScoped)
      yield* Deferred.await(fixture.probed)
      yield* Deferred.succeed(fixture.exited, ChildProcessSpawner.ExitCode(code))
      yield* TestClock.adjust('25 seconds')
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '').toContain(`exited with code ${code}`)
      expect(fixture.observations.stoppedAt).toBe(0)
      expect(fixture.observations.cancelled).toBe(1)
      expect(fixture.observations.released).toBe(1)
      expect(yield* Deferred.isDone(fixture.serving)).toBe(false)
      expect(fixture.observations.providerCalls).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test('the original 25-second readiness bound cancels the request and releases its child exactly once', async () => {
  await run(
    Effect.gen(function* () {
      const fixture = yield* harness('waiting')
      const fiber = yield* fixture.server.pipe(Effect.forkScoped)
      yield* Deferred.await(fixture.probed)
      yield* TestClock.adjust(24_999)
      expect(yield* Deferred.isDone(fixture.stopped)).toBe(false)
      expect(fixture.observations.released).toBe(0)
      yield* TestClock.adjust(1)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '').toContain('TimeoutError')
      expect(fixture.observations.stoppedAt).toBe(25_000)
      expect(fixture.observations.probes).toBeGreaterThan(1)
      expect(fixture.observations.cancelled).toBe(fixture.observations.probes)
      expect(fixture.observations.released).toBe(1)
      expect(yield* Deferred.isDone(fixture.serving)).toBe(false)
      expect(fixture.observations.providerCalls).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test.each(['recovering', 'starting'] as const)(
  'a %s native server can become ready within the same startup budget',
  async (probe) => {
    await run(
      Effect.gen(function* () {
        const fixture = yield* harness(probe)
        const fiber = yield* fixture.server.pipe(Effect.forkScoped)
        yield* Deferred.await(fixture.probed)
        yield* TestClock.adjust(200)
        yield* Deferred.await(fixture.serving).pipe(Effect.raceFirst(Fiber.join(fiber)))
        expect(fixture.observations.probes).toBe(2)
        expect(fixture.observations.authenticated).toBe(probe === 'starting' ? 2 : 1)
        expect(fixture.observations.released).toBe(0)
        yield* Fiber.interrupt(fiber)
        expect(fixture.observations.released).toBe(1)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
  },
)

test('an unanswered startup probe is cancelled before another probe proves the same child identity', async () => {
  await run(
    Effect.gen(function* () {
      const fixture = yield* harness('stalled-once')
      const fiber = yield* fixture.server.pipe(Effect.forkScoped)
      yield* Deferred.await(fixture.probed)
      yield* TestClock.adjust('1200 millis')
      expect(fixture.observations.probes).toBe(2)
      yield* Deferred.await(fixture.serving).pipe(Effect.raceFirst(Fiber.join(fiber)))
      expect(fixture.observations.cancelled).toBe(1)
      expect(fixture.observations.authenticated).toBe(1)
      expect(fixture.commands.length).toBe(1)
      expect(fixture.observations.providerCalls).toBe(0)
      yield* Fiber.interrupt(fiber)
      expect(fixture.observations.released).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test('a probe defect remains a defect and releases the native child', async () => {
  await run(
    Effect.gen(function* () {
      const fixture = yield* harness('defect')
      const exit = yield* Effect.exit(fixture.server)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '').toContain(fixture.defect.message)
      expect(fixture.observations.probes).toBe(1)
      expect(fixture.observations.released).toBe(1)
      expect(yield* Deferred.isDone(fixture.serving)).toBe(false)
      expect(fixture.observations.providerCalls).toBe(0)
    }).pipe(Effect.scoped),
  )
})

test('scope shutdown escalates for an owned native child that ignores SIGTERM', async () => {
  let child: ChildProcessSpawner.ChildProcessHandle | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let watchdogFired = false
  const forceStop = async () => {
    if (child === undefined) return
    await Effect.runPromise(
      child.isRunning.pipe(
        Effect.flatMap((running) =>
          running && child !== undefined
            ? child.kill({ killSignal: 'SIGKILL', forceKillAfter: '1 second' })
            : Effect.void,
        ),
        Effect.ignore,
      ),
    )
  }
  try {
    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-opencode-shutdown-' })
        const binary = `${directory}/native`
        const ready = `${directory}/child-ready`
        yield* fs.writeFileString(
          binary,
          `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'\nprocess.on('SIGTERM', () => {})\nwriteFileSync(${JSON.stringify(ready)}, 'ready')\nsetInterval(() => {}, 1000)\n`,
          { mode: 0o700 },
        )
        const originalSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const spawner = ChildProcessSpawner.make((command) => {
          if (command._tag !== 'StandardCommand') throw new Error('Native shutdown requires one standard command')
          expect(command.options.forceKillAfter).toBe('25 seconds')
          // Check the production drain budget above, then exercise real signal escalation on a shorter budget.
          const testCommand = ChildProcess.make(command.command, command.args, {
            ...command.options,
            forceKillAfter: '100 millis',
          })
          return originalSpawner.spawn(testCommand).pipe(
            Effect.tap((handle) =>
              Effect.sync(() => {
                child = handle
                // A failing regression must still reap its real child without relying on Bun's test timeout.
                watchdog = setTimeout(() => {
                  watchdogFired = true
                  void forceStop()
                }, 30_000)
              }),
            ),
          )
        })
        const probed = yield* Deferred.make<void>()
        const native = HttpClient.make(() =>
          Effect.gen(function* () {
            while (!(yield* fs.exists(ready).pipe(Effect.orDie))) yield* Effect.sleep('10 millis')
            yield* Deferred.succeed(probed, undefined)
            return yield* Effect.never
          }),
        )
        const server = serveOpenCode({ sourceRevision: 'a'.repeat(40), proxy: 'http://127.0.0.1:9', binary }, native, {
          directory,
          nativePort: 0,
          relayPort: 0,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, native),
          Effect.provideService(
            HttpServer.HttpServer,
            HttpServer.make({
              address: NetAddress.inetAddressFromIpStringUnsafe('127.0.0.1', 0),
              serve: () => Effect.void,
            }),
          ),
        )
        const fiber = yield* server.pipe(Effect.forkScoped)
        yield* Deferred.await(probed).pipe(Effect.raceFirst(Fiber.join(fiber)))
        const ownedChild = child
        if (ownedChild === undefined) return yield* Effect.fail(new Error('Native child was not acquired'))
        expect(yield* ownedChild.isRunning).toBe(true)
        yield* Fiber.interrupt(fiber)
        expect(watchdogFired).toBe(false)
        expect(yield* ownedChild.isRunning).toBe(false)
      }).pipe(Effect.scoped),
    )
  } finally {
    clearTimeout(watchdog)
    await forceStop()
  }
}, 35_000)
