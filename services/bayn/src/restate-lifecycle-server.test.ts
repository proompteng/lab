import { describe, expect, test } from 'bun:test'
import { connect, createServer as createHttp2Server, type ClientHttp2Session } from 'node:http2'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import * as restate from '@restatedev/restate-sdk'
import { Effect, Result } from 'effect'

import { decodeRestateLifecycleConfig } from './restate-lifecycle'
import {
  makeBaynLifecycle,
  makeBaynLifecycleBootstrap,
  type LifecycleCommandClient,
} from './restate-lifecycle-controller'
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

const readDiscovery = (session: ClientHttp2Session): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const request = session.request({
      ':method': 'GET',
      ':path': '/discover',
      accept: 'application/vnd.restate.endpointmanifest.v4+json',
    })
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.once('error', reject)
    request.once('end', () => {
      try {
        resolve(JSON.parse(body) as unknown)
      } catch (cause) {
        reject(cause)
      }
    })
    request.end()
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

  test('publishes bounded activation retries without changing recurring lifecycle retries', async () => {
    const decoded = decodeRestateLifecycleConfig({
      schemaVersion: 'bayn.restate-lifecycle-config.v1',
      controllerKey: 'primary',
      commandBaseUrl: 'http://bayn-lifecycle-command.bayn.svc.cluster.local:8081',
      operationTimeoutMs: 30_000,
      pollIntervalMs: 30_000,
      sourceRevision: 'a'.repeat(40),
      port: 9080,
    })
    if (Result.isFailure(decoded)) throw decoded.failure
    const commandClient: LifecycleCommandClient = {
      readCursor: () => Promise.reject(new Error('not invoked by discovery')),
      advance: () => Promise.reject(new Error('not invoked by discovery')),
    }
    const lifecycle = makeBaynLifecycle(decoded.success, commandClient)
    const bootstrap = makeBaynLifecycleBootstrap(decoded.success, lifecycle)
    const port = await reservePort()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = createHttp2Server(restate.createEndpointHandler({ services: [lifecycle, bootstrap] }))
          yield* acquireRestateLifecycleHttp2Server(server, port)
          const client = yield* Effect.promise(() => connectSession(`http://127.0.0.1:${port}`))
          const discovery = yield* Effect.promise(() => readDiscovery(client))
          client.close()

          const services = (discovery as { readonly services?: readonly unknown[] }).services
          const lifecycleService = services?.find(
            (service) => (service as { readonly name?: string }).name === 'BaynLifecycle',
          ) as { readonly handlers?: readonly Record<string, unknown>[] }
          const bootstrapService = services?.find(
            (service) => (service as { readonly name?: string }).name === 'BaynLifecycleBootstrap',
          ) as { readonly handlers?: readonly Record<string, unknown>[] }
          const activate = lifecycleService.handlers?.find((handler) => handler['name'] === 'activate')
          const advance = lifecycleService.handlers?.find((handler) => handler['name'] === 'advance')
          const start = bootstrapService.handlers?.find((handler) => handler['name'] === 'start')

          expect(activate).toMatchObject({
            retryPolicyExponentiationFactor: 2,
            retryPolicyInitialInterval: 1_000,
            retryPolicyMaxInterval: 30_000,
            retryPolicyMaxAttempts: 8,
            retryPolicyOnMaxAttempts: 'KILL',
          })
          expect(advance).not.toHaveProperty('retryPolicyMaxAttempts')
          expect(advance).not.toHaveProperty('retryPolicyOnMaxAttempts')
          expect(start).toMatchObject({
            idempotencyRetention: 600_000,
            retryPolicyMaxAttempts: 1,
            retryPolicyOnMaxAttempts: 'KILL',
          })
        }),
      ),
    )
  })
})
