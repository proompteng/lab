import { connect, createServer as createHttp2Server, type ClientHttp2Session } from 'node:http2'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect, Exit } from 'effect'

import type { ApplicationPlan } from './app'
import { acquireRestateHttp2Server } from './restate-http2-server'
import {
  decodeRestateRequestIdentityKeys,
  makeRestateExecutionEndpointHandler,
  requireAutonomousApplicationPlan,
  restateExecutionServerConfig,
} from './restate-execution-server'

const controllerKey = 'a'.repeat(64)
const planHash = 'b'.repeat(64)
const sourceRevision = 'c'.repeat(40)
const requestIdentityKey = 'publickeyv1_2G8dCQhArfvGpzPw5Vx2ALciR4xCLHfS5YaT93XjNxX9'
const legacyDeactivationSchemaVersion = 'bayn.restate-lifecycle-activation.v1'

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

const readUnsignedDiscoveryStatus = (session: ClientHttp2Session): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = session.request({
      ':method': 'GET',
      ':path': '/discover',
      accept: 'application/vnd.restate.endpointmanifest.v4+json',
    })
    let status: number | undefined
    request.once('response', (headers) => {
      const candidate = headers[':status']
      status = typeof candidate === 'number' ? candidate : undefined
    })
    request.on('data', () => undefined)
    request.once('error', reject)
    request.once('end', () =>
      status === undefined ? reject(new Error('Restate endpoint omitted the HTTP status')) : resolve(status),
    )
    request.end()
  })

describe('native Restate execution server', () => {
  test('discovers only the account-keyed controller and its narrow bootstrap', async () => {
    const handler = makeRestateExecutionEndpointHandler(
      { controllerKey, operationTimeoutMs: 30_000, planHash, sourceRevision },
      {
        advance: () => Promise.reject(new Error('discovery must not advance execution')),
        log: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      },
      'd'.repeat(64),
      [],
    )
    const port = await reservePort()

    const discovery = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireRestateHttp2Server(createHttp2Server(handler), port)
          const client = yield* Effect.promise(() => connectSession(`http://127.0.0.1:${port}`))
          const manifest = yield* Effect.promise(() => readDiscovery(client))
          client.close()
          return manifest
        }),
      ),
    )

    const services = (discovery as { readonly services?: readonly { readonly name?: string }[] }).services ?? []
    expect(services.map(({ name }) => name)).toEqual(['BaynExecutionController', 'BaynExecutionBootstrap'])
  })

  test('requires a bounded unique Restate request-identity key set', () => {
    expect(decodeRestateRequestIdentityKeys(requestIdentityKey)).toMatchObject({ _tag: 'Success' })
    expect(decodeRestateRequestIdentityKeys(`${requestIdentityKey},${requestIdentityKey}`)).toMatchObject({
      _tag: 'Failure',
    })
    expect(decodeRestateRequestIdentityKeys('not-a-restate-key')).toMatchObject({ _tag: 'Failure' })
  })

  test('requires exact legacy owner provenance before the worker can start', async () => {
    const common = {
      BAYN_EXECUTION_BOOTSTRAP_TOKEN: 'test-bootstrap-token',
      RESTATE_REQUEST_IDENTITY_KEYS: requestIdentityKey,
    }
    const provide = (environment: Readonly<Record<string, string>>) =>
      restateExecutionServerConfig.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
      )

    for (const environment of [
      common,
      { ...common, BAYN_LEGACY_LIFECYCLE_PLAN_HASH: planHash },
      { ...common, BAYN_LEGACY_LIFECYCLE_SOURCE_REVISION: sourceRevision },
      {
        ...common,
        BAYN_LEGACY_LIFECYCLE_DEACTIVATION_SCHEMA_VERSION: 'unsupported',
        BAYN_LEGACY_LIFECYCLE_PLAN_HASH: planHash,
        BAYN_LEGACY_LIFECYCLE_SOURCE_REVISION: sourceRevision,
      },
    ]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(provide(environment)))).toBe(true)
    }

    expect(
      await Effect.runPromise(
        provide({
          ...common,
          BAYN_LEGACY_LIFECYCLE_PLAN_HASH: planHash,
          BAYN_LEGACY_LIFECYCLE_SOURCE_REVISION: sourceRevision,
        }),
      ),
    ).toMatchObject({
      legacyControllerKey: 'primary',
      legacyDeactivationSchemaVersion,
      legacyPlanHash: planHash,
      legacySourceRevision: sourceRevision,
    })
  })

  test('rejects an unsigned discovery request when request identity is configured', async () => {
    const handler = makeRestateExecutionEndpointHandler(
      { controllerKey, operationTimeoutMs: 30_000, planHash, sourceRevision },
      {
        advance: () => Promise.reject(new Error('unsigned discovery must not advance execution')),
        log: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      },
      'd'.repeat(64),
      [requestIdentityKey],
    )
    const port = await reservePort()

    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireRestateHttp2Server(createHttp2Server(handler), port)
          const client = yield* Effect.promise(() => connectSession(`http://127.0.0.1:${port}`))
          const responseStatus = yield* Effect.promise(() => readUnsignedDiscoveryStatus(client))
          client.close()
          return responseStatus
        }),
      ),
    )

    expect(status).toBe(401)
  })

  test('rejects every non-autonomous application plan before acquiring runtime resources', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        requireAutonomousApplicationPlan({
          _tag: 'BrokerlessService',
          config: { runtimeMode: 'BrokerlessService' },
        } as ApplicationPlan),
      ),
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe('native Restate execution requires the autonomous service runtime mode')
  })
})
