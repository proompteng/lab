import { describe, expect, test } from 'bun:test'
import { connect, createServer as createHttp2Server, type ClientHttp2Session } from 'node:http2'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Effect } from 'effect'

import { acquireRestateLifecycleHttp2Server } from './restate-lifecycle-server'

const reservePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createHttpServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      server.close((cause) => (cause === undefined ? resolve(address.port) : reject(cause)))
    })
  })

const connectSession = (origin: string): Promise<ClientHttp2Session> =>
  new Promise((resolve, reject) => {
    const session = connect(origin)
    session.once('connect', () => resolve(session))
    session.once('error', reject)
  })

describe('Bayn Restate lifecycle HTTP/2 server', () => {
  test('destroys active client sessions before waiting for server shutdown', async () => {
    const port = await reservePort()
    let client: ClientHttp2Session | undefined
    let closed: Promise<'closed'> | undefined

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = createHttp2Server()
          yield* acquireRestateLifecycleHttp2Server(server, port)
          client = yield* Effect.promise(() => connectSession(`http://127.0.0.1:${port}`))
          closed = new Promise((resolve) => client?.once('close', () => resolve('closed')))
          expect(client.closed).toBe(false)
        }),
      ),
    )

    if (closed === undefined) throw new Error('HTTP/2 session did not connect')
    expect(await Promise.race([closed, Bun.sleep(1_000).then(() => 'timeout' as const)])).toBe('closed')
    expect(client?.destroyed).toBe(true)
  })
})
