import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Clock, Config, Effect, Exit, Option, Redacted, Schedule, Schema, Scope, Result } from 'effect'

import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from '../broker/identity'
import {
  BrokerNotificationSchema,
  SignedBrokerNotificationSchema,
  brokerNotificationVersion,
  verifyBrokerNotification,
} from '../broker/notifications'
import { sha256 } from '../hash'
import { acquireRestateHttp2Server } from './restate-http2-server'
import { brokerObservationJsonSerde, makeBaynBrokerObservations } from './restate-broker-observations'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_ADMIN_URL'))).pipe(Option.getOrUndefined)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const describeRestate = admin === undefined || ingress === undefined ? describe.skip : describe
const reference = Result.getOrThrow(
  Schema.decodeUnknownResult(
    Schema.fromJsonString(
      Schema.Struct({
        description: Schema.String,
        accountId: Schema.String,
        keyId: Schema.String,
        secret: Schema.String,
        key: Schema.String,
        notification: SignedBrokerNotificationSchema,
      }),
    ),
  )(readFileSync(new URL('../../../dorvud/fixtures/bayn-broker-notification-v1.json', import.meta.url), 'utf8')),
)
const connection = {
  identity: Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: randomUUID(),
    }),
  ),
  key: Redacted.make(reference.keyId),
  secret: Redacted.make(reference.secret),
}
const original = Result.getOrThrow(
  Schema.decodeUnknownResult(Schema.fromJsonString(BrokerNotificationSchema))(reference.notification.message),
)
const eventId = sha256(
  `${connection.identity.identityHash}\n${original._tag === 'TradeUpdate' ? original.frameJson : `${original.session.sessionId}\nready`}`,
)
const message = JSON.stringify({
  ...original,
  eventId,
  session: {
    ...original.session,
    identityHash: connection.identity.identityHash,
    accountId: connection.identity.accountId,
  },
})
const fixture = {
  notification: {
    schemaVersion: 'bayn.signed-broker-notification.v1',
    message,
    signature: createHmac('sha256', reference.secret).update(`${brokerNotificationVersion}\n${message}`).digest('hex'),
  },
}
const config = {
  controllerKey: connection.identity.identityHash,
  sourceRevision: '2'.repeat(40),
  maxAgeMs: 60_000,
  freshnessLeadMs: 5_000,
  operationTimeoutMs: 5_000,
}
const json = (url: string, body?: unknown, headers?: Record<string, string>) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        signal,
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: { 'content-type': 'application/json', ...headers },
      })
      if (!response.ok) throw new Error(`Local Restate returned ${response.status}: ${await response.text()}`)
      return response.json() as Promise<unknown>
    },
    catch: (cause) => cause,
  })
const waitFor = (check: () => Effect.Effect<boolean, unknown>) =>
  Effect.suspend(check).pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail('local observation owner has not advanced'))),
    Effect.retry({ schedule: Schedule.spaced('100 millis'), times: 100 }),
  )
// SDK definitions deliberately hide implementation options in their public client type.
// Override only the test endpoint, rather than weakening production's operation deadline.
const alwaysReplay = <A extends { name: string }>(service: A): A => {
  const definition = service as A & { options?: restate.ObjectOptions }
  definition.options = { ...definition.options, inactivityTimeout: 0 }
  return service
}
const localTargets = () => {
  if (admin === undefined || ingress === undefined) throw new Error('Missing local Restate URLs')
  for (const target of [admin, ingress])
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname))
      throw new Error('Restate integration targets must be local')
  return { admin, ingress }
}
const wakeReceiver = (record: () => void = () => undefined) =>
  alwaysReplay(
    restate.object({
      name: 'BaynExecutionController',
      handlers: {
        wake: async (ctx: restate.ObjectContext, _candidate: unknown) => {
          await ctx.run('record published wake', async () => {
            record()
          })
        },
      },
      options: { ingressPrivate: true },
    }),
  )

describeRestate('Real always-replay Restate broker ingress', () => {
  test('verified public ingress coalesces republication and survives a process restart before its quota deadline', async () => {
    const { admin, ingress } = localTargets()
    let activations = 0
    let captures = 0
    let wakes = 0
    const clock = Clock.Clock.defaultValue()
    const makeObserved = () =>
      alwaysReplay(
        makeBaynBrokerObservations(config, {
          verifyNotification: (candidate, nowMs) => verifyBrokerNotification(candidate, connection, nowMs),
          recordNotification: async () => ({ covered: false }),
          invalidate: async () => undefined,
          activate: async () => {
            activations += 1
          },
          poll: async () => {
            captures += 1
            const now = clock.currentTimeMillisUnsafe()
            return {
              poll: {
                _tag: 'Published',
                snapshotHash: captures.toString(16).padStart(64, '0'),
                observedAt: new Date(now).toISOString(),
                nextPollNotBeforeMs: now + 2_000,
              },
              startedAtMs: now,
              completedAtMs: now,
            }
          },
        }),
      )
    const bridge = alwaysReplay(
      restate.service({
        name: 'ObservationTestBridge',
        handlers: {
          start: (ctx: restate.Context) =>
            ctx.genericCall({
              service: 'BaynBrokerObservations',
              method: 'activate',
              key: config.controllerKey,
              parameter: { sourceRevision: config.sourceRevision },
              inputSerde: brokerObservationJsonSerde,
              outputSerde: brokerObservationJsonSerde,
            }),
          status: (ctx: restate.Context) =>
            ctx.genericCall({
              service: 'BaynBrokerObservations',
              method: 'status',
              key: config.controllerKey,
              parameter: {},
              inputSerde: brokerObservationJsonSerde,
              outputSerde: brokerObservationJsonSerde,
            }),
          refresh: (ctx: restate.Context) =>
            ctx.genericCall({
              service: 'BaynBrokerObservations',
              method: 'refresh',
              key: config.controllerKey,
              parameter: { sourceRevision: config.sourceRevision },
              inputSerde: brokerObservationJsonSerde,
            }),
        },
      }),
    )
    const receiver = wakeReceiver(() => {
      wakes++
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpointScope = yield* Scope.fork(yield* Effect.scope)
          const server = createServer(restate.createEndpointHandler({ services: [makeObserved(), bridge, receiver] }))
          yield* acquireRestateHttp2Server(server, 0).pipe(Effect.provideService(Scope.Scope, endpointScope))
          const address = server.address()
          if (address === null || typeof address === 'string') throw new Error('Missing endpoint address')
          const register = () =>
            json(`${admin}/deployments`, { uri: `http://host.docker.internal:${address.port}`, force: true })
          yield* register()
          const service = yield* json(`${admin}/services/BaynBrokerObservations`)
          expect(service).toMatchObject({ inactivity_timeout: '0s' })
          const invoke = (method: string, body: unknown = {}, headers?: Record<string, string>) =>
            json(`${ingress}/ObservationTestBridge/${method}`, body, headers)
          const activationId = randomUUID()
          const activated = yield* invoke('start', {}, { 'idempotency-key': activationId })
          expect(activated).toMatchObject({
            sourceRevision: config.sourceRevision,
            epoch: 1,
            sequence: 1,
            captureScheduled: false,
          })
          expect(yield* invoke('start', {}, { 'idempotency-key': activationId })).toEqual(activated)
          expect(activations).toBe(1)
          expect(captures).toBe(1)
          const rejected = yield* Effect.promise(() =>
            fetch(`${ingress}/BaynBrokerObservations/${config.controllerKey}/notify`, {
              method: 'POST',
              body: JSON.stringify({ ...fixture.notification, signature: 'f'.repeat(64) }),
              headers: { 'content-type': 'application/json' },
            }),
          )
          expect(rejected.status).toBe(400)
          const denied = yield* Effect.promise(() =>
            fetch(`${ingress}/BaynBrokerObservations/${config.controllerKey}/activate`, {
              method: 'POST',
              body: JSON.stringify({ sourceRevision: config.sourceRevision }),
              headers: { 'content-type': 'application/json' },
            }),
          )
          expect(denied.status).toBe(400)
          yield* Effect.all(
            Array.from({ length: 100 }, () =>
              json(`${ingress}/BaynBrokerObservations/${config.controllerKey}/notify`, fixture.notification),
            ),
            { concurrency: 20 },
          )
          yield* waitFor(() =>
            invoke('status').pipe(
              Effect.map(
                (state) =>
                  typeof state === 'object' &&
                  state !== null &&
                  'captureScheduled' in state &&
                  state.captureScheduled === true,
              ),
            ),
          )
          expect(captures).toBe(1)
          yield* Scope.close(endpointScope, Exit.succeed(undefined))
          yield* Effect.sleep('300 millis')
          const restarted = createServer(
            restate.createEndpointHandler({ services: [makeObserved(), bridge, receiver] }),
          )
          yield* acquireRestateHttp2Server(restarted, address.port)
          yield* register()
          yield* waitFor(() =>
            invoke('status').pipe(
              Effect.map(
                (state) =>
                  typeof state === 'object' &&
                  state !== null &&
                  'captureScheduled' in state &&
                  state.captureScheduled === false &&
                  captures === 2,
              ),
            ),
          )
          expect(activations).toBe(1)
          yield* json(`${ingress}/BaynBrokerObservations/${config.controllerKey}/notify`, fixture.notification)
          yield* Effect.sleep('300 millis')
          expect(captures).toBe(2)
          expect(yield* invoke('status')).toMatchObject({ captureScheduled: false, sequence: 3 })
          yield* waitFor(() => Effect.sync(() => wakes === 2))
          const counts = yield* json(
            `${admin}/query`,
            {
              query: `SELECT COUNT(*) AS accepted FROM sys_invocation WHERE target_service_name = 'BaynBrokerObservations' AND target_service_key = '${config.controllerKey}' AND target_handler_name = 'accept'`,
            },
            { accept: 'application/json' },
          )
          expect(counts).toEqual({ rows: [{ accepted: 1 }] })
          yield* invoke('refresh')
          expect(captures).toBe(2)
          yield* waitFor(() =>
            invoke('status').pipe(
              Effect.map(
                (state) =>
                  typeof state === 'object' &&
                  state !== null &&
                  'captureScheduled' in state &&
                  state.captureScheduled === false &&
                  captures === 3,
              ),
            ),
          )
          expect(captures).toBe(3)
          yield* waitFor(() => Effect.sync(() => wakes === 3))
        }),
      ),
    )
  }, 30_000)
  test('replay after a journaled deadline and wake tolerates a changed live transport clock without recapturing', async () => {
    const { admin, ingress } = localTargets()
    let attempts = 0
    let captures = 0
    let clockOffsetMs = 0
    const clock = Clock.Clock.defaultValue()
    const replayKey = randomUUID().replaceAll('-', '').repeat(2)
    const observations = alwaysReplay(
      makeBaynBrokerObservations(
        { ...config, controllerKey: replayKey },
        {
          verifyNotification: (candidate, nowMs) => verifyBrokerNotification(candidate, connection, nowMs),
          recordNotification: async () => ({ covered: false }),
          invalidate: async () => undefined,
          activate: async () => undefined,
          poll: async () => {
            captures++
            const now = clock.currentTimeMillisUnsafe()
            return {
              poll: {
                _tag: 'Published',
                snapshotHash: '4'.repeat(64),
                observedAt: new Date(now).toISOString(),
                nextPollNotBeforeMs: 0,
              },
              startedAtMs: now,
              completedAtMs: now,
            }
          },
        },
        [
          ({ request }) => ({
            interceptor: {
              handler: async (next) => {
                await next()
                if (request.target.handler === 'activate' && ++attempts === 1) {
                  clockOffsetMs = 60_000
                  throw new Error('Injected lost completion after journaled delayed send')
                }
              },
            },
          }),
        ],
        { currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + clockOffsetMs },
      ),
    )
    const bridge = alwaysReplay(
      restate.service({
        name: 'ObservationReplayBridge',
        handlers: {
          start: (ctx: restate.Context) =>
            ctx.genericCall({
              service: 'BaynBrokerObservations',
              method: 'activate',
              key: replayKey,
              parameter: { sourceRevision: config.sourceRevision },
              inputSerde: brokerObservationJsonSerde,
              outputSerde: brokerObservationJsonSerde,
            }),
        },
      }),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = createServer(
            restate.createEndpointHandler({ services: [observations, bridge, wakeReceiver()] }),
          )
          yield* acquireRestateHttp2Server(server, 0)
          const address = server.address()
          if (address === null || typeof address === 'string') throw new Error('Missing endpoint address')
          yield* json(`${admin}/deployments`, { uri: `http://host.docker.internal:${address.port}`, force: true })
          expect(yield* json(`${ingress}/ObservationReplayBridge/start`, {})).toMatchObject({
            lastSnapshotHash: '4'.repeat(64),
          })
          expect(attempts).toBeGreaterThanOrEqual(2)
          expect(captures).toBe(1)
        }),
      ),
    )
  }, 15_000)
})
