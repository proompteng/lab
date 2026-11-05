import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'

import { NodeRedis } from '@effect/platform-node'
import { ConfigProvider, Effect, Exit, Fiber, FileSystem, Layer, Logger, Option, Result } from 'effect'

import {
  makeValkeyCache,
  ValkeyCache,
  ValkeyCacheError,
  ValkeyFailureCategory,
  valkeyClientOptions,
} from '../valkey-cache'
import { withValkeyStartupRetry } from '../valkey-startup'

const mode = process.argv[2]
assert(mode !== undefined)
const peers = new Set<Socket>()
const handshake = Promise.withResolvers<void>()
const command = Promise.withResolvers<void>()
const disconnected = Promise.withResolvers<void>()
const closed: Promise<void>[] = []
let connections = 0
let closes = 0
let aborts = 0
let phase = 'acquire'
let stalled = mode !== 'idle'
const errors: unknown[] = []
const server = createServer((socket) => {
  const closure = Promise.withResolvers<void>()
  closed.push(closure.promise)
  peers.add(socket)
  connections++
  let buffer = ''
  socket.on('error', () => {})
  socket.once('close', () => {
    closes++
    peers.delete(socket)
    disconnected.resolve()
    closure.resolve()
  })
  socket.on('data', (data) => {
    buffer += data.toString()
    while (buffer.length > 0) {
      const head = buffer.indexOf('\r\n')
      if (head < 0) return
      const count = Number(buffer.slice(1, head))
      const args: string[] = []
      let offset = head + 2
      for (let index = 0; index < count; index++) {
        const end = buffer.indexOf('\r\n', offset)
        if (end < 0) return
        const length = Number(buffer.slice(offset + 1, end))
        if (buffer.length < end + length + 4) return
        args.push(buffer.slice(end + 2, end + 2 + length))
        offset = end + length + 4
      }
      buffer = buffer.slice(offset)
      if (args[0] === 'CLIENT' || args[0] === 'AUTH') {
        handshake.resolve()
        if (mode !== 'startup-deadline' && mode !== 'startup-interrupt') socket.write('+OK\r\n')
      } else if (args[0] === 'GET') {
        command.resolve()
        if (mode === 'command-disconnect' && stalled) socket.destroy()
        else if (!stalled) socket.write('$-1\r\n')
      } else if (args[0] === 'PING') {
        socket.write('+PONG\r\n')
      } else socket.write('-ERR unsupported fixture command\r\n')
    }
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address !== null && typeof address !== 'string')
const guard = setTimeout(() => {
  throw new Error(
    `Valkey lifecycle fixture exceeded its bounded completion grace: ${JSON.stringify({ mode, phase, connections, closes, aborts })}`,
  )
}, 7_000)

try {
  const options = await valkeyClientOptions.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        VALKEY_HOST: '127.0.0.1',
        VALKEY_PORT: address.port,
        VALKEY_PASSWORD: 'fixture-only',
        VALKEY_TLS_SERVER_NAME: 'localhost',
      }),
    ),
    Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed('fixture-only') })),
    Effect.runPromise,
  )
  // Exercise production lifecycle options against a local RESP fixture; TLS identity is tested separately.
  const { tls: _tls, servername: _name, ca: _ca, cert: _cert, key: _key, ...socket } = options.socket
  const native = withValkeyStartupRetry((signal) => {
    signal.addEventListener(
      'abort',
      () => {
        aborts++
      },
      { once: true },
    )
    return NodeRedis.layer({ ...options, RESP: 2, socket: { ...socket, tls: false, signal } })
  })
  const layer = Layer.effect(ValkeyCache, makeValkeyCache).pipe(Layer.provideMerge(native))
  const program = Effect.gen(function* () {
    const cache = yield* ValkeyCache
    const { client } = yield* NodeRedis.NodeRedis
    client.on('error', (cause) => errors.push(cause))
    if (mode === 'idle') {
      assert(Option.isNone(yield* cache.get('bayn:before')))
      // A delayed event-loop turn must not turn an idle healthy connection into a failed command.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_200)
      yield* Effect.sleep('100 millis')
      assert.equal(client.isReady, true)
      assert.equal(connections, 1)
      assert.equal(closes, 0)
      assert.equal(errors.length, 0)
      assert(Option.isNone(yield* cache.get('bayn:after')))
      return
    }
    if (mode === 'command-interrupt') {
      const fiber = yield* cache.get('bayn:stalled').pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() => command.promise)
      yield* Fiber.interrupt(fiber)
    } else {
      const result = yield* cache.get('bayn:stalled').pipe(Effect.result)
      assert(Result.isFailure(result))
      assert(result.failure instanceof ValkeyCacheError)
      assert.equal(
        result.failure.category,
        mode === 'command-disconnect' ? ValkeyFailureCategory.Transport : ValkeyFailureCategory.OperationDeadline,
      )
    }
    yield* Effect.promise(() => disconnected.promise)
    assert.equal(closes, 1)
    stalled = false
    assert(Option.isNone(yield* cache.get('bayn:reconnected')))
    assert.equal(connections, 2)
  })
  if (mode === 'startup-deadline') {
    const result = await Effect.void.pipe(
      Effect.provide(layer),
      Effect.result,
      Effect.provide(Logger.layer([])),
      Effect.runPromise,
    )
    assert(Result.isFailure(result))
    assert.equal(connections, 1)
  } else if (mode === 'startup-interrupt') {
    await Effect.gen(function* () {
      const fiber = yield* Effect.void.pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() => handshake.promise)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      assert(Exit.isFailure(exit))
    }).pipe(Effect.provide(Logger.layer([])), Effect.runPromise)
    assert.equal(connections, 1)
  } else {
    await program.pipe(Effect.provide(layer), Effect.provide(Logger.layer([])), Effect.runPromise)
  }
  phase = 'finalize'
  await Promise.all(closed)
  assert.equal(closes, connections)
  assert.equal(aborts, mode.startsWith('startup-') ? 1 : 0)
  console.log(JSON.stringify({ mode, connections, closes, errors: errors.length }))
} finally {
  clearTimeout(guard)
  for (const peer of peers) peer.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
