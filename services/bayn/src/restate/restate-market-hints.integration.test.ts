import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Config, Effect, Option, Redacted, Result, Schedule, Schema } from 'effect'

import { ExecutionControllerOutcome } from '../execution/controller-status'
import { MarketChangeReason, marketChangedEventId, type MarketChangedWakeup } from '../execution/events'
import { sha256 } from '../hash'
import { makeMarketHints } from '../market-data/streaming/readiness'
import { brokerObservationJsonSerde } from './restate-broker-observations'
import { executionActivationAuthorizationHash, makeBaynExecutionController } from './restate-execution-controller'
import { publishMarketChange } from './restate-execution-server'
import { acquireRestateHttp2Server } from './restate-http2-server'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_ADMIN_URL'))).pipe(Option.getOrUndefined)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const describeRestate = admin === undefined || ingress === undefined ? describe.skip : describe
const json = (url: string, body?: unknown) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(url, {
      signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`Local Restate returned ${response.status}`)
    return response.json() as Promise<unknown>
  })
const waitFor = (check: () => Effect.Effect<boolean, unknown>) =>
  Effect.suspend(check).pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail('market hint boundary not reached'))),
    Effect.retry({ schedule: Schedule.spaced('20 millis'), times: 250 }),
  )
const fixture = () => {
  if (admin === undefined || ingress === undefined) throw new Error('Missing local Restate URLs')
  for (const target of [admin, ingress])
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname))
      throw new Error('Market hint integration targets must be local')
  const targets = { admin, ingress }
  const controllerKey = sha256(randomUUID())
  const token = Buffer.alloc(32, 7).toString('base64url')
  const config = {
    controllerKey,
    planHash: 'b'.repeat(64),
    sourceRevision: 'c'.repeat(40),
    operationTimeoutMs: 5_000,
    activationAuthorizationHash: Result.getOrThrow(executionActivationAuthorizationHash(token)),
  }
  let release: () => void = () => undefined
  let version = 0
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const snapshots: number[] = []
  const controller = (sourceRevision = config.sourceRevision) => {
    const definition = makeBaynExecutionController(
      { ...config, sourceRevision },
      {
        prepareActivation: async () => undefined,
        projectState: async () => undefined,
        log: async () => undefined,
        advance: async (command) => {
          snapshots.push(version)
          if (command.sequence === 0) await gate
          return {
            completedAt: new Date().toISOString(),
            outcome: {
              _tag: ExecutionControllerOutcome.Waiting,
              receiptHash: sha256(String(command.sequence)),
              nextDelayMs: 1,
            },
          }
        },
      },
    )
    const replay = definition as typeof definition & { options?: restate.ObjectOptions }
    replay.options = { ...replay.options, inactivityTimeout: 0 }
    return definition
  }
  const bridge = restate.service({
    name: 'PublicHintRetryTestBridge',
    handlers: {
      start: (ctx: restate.Context) =>
        ctx.genericCall({
          service: 'BaynExecutionController',
          method: 'activate',
          key: controllerKey,
          parameter: {
            schemaVersion: 'bayn.execution-controller-activation.v1',
            controllerKey,
            epoch: 1,
            firstSequence: 0,
            planHash: config.planHash,
            sourceRevision: config.sourceRevision,
          },
          inputSerde: brokerObservationJsonSerde,
          outputSerde: brokerObservationJsonSerde,
        }),
    },
  })
  const register = (sourceRevision = config.sourceRevision) =>
    Effect.gen(function* () {
      const server = createServer(restate.createEndpointHandler({ services: [controller(sourceRevision), bridge] }))
      yield* acquireRestateHttp2Server(server, 0)
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Missing local endpoint')
      yield* json(`${targets.admin}/deployments`, { uri: `http://host.docker.internal:${address.port}`, force: true })
    })
  const count = (where: string) =>
    json(`${targets.admin}/query`, {
      query: `SELECT COUNT(*) AS total FROM sys_invocation WHERE target LIKE 'BaynExecutionController/${controllerKey}/%' AND (${where})`,
    }).pipe(
      Effect.map(
        (value) =>
          Schema.decodeUnknownSync(Schema.Struct({ rows: Schema.Array(Schema.Struct({ total: Schema.Number })) }))(
            value,
          ).rows[0]?.total ?? -1,
      ),
    )
  const publish = (event: MarketChangedWakeup, operationTimeoutMs = config.operationTimeoutMs) =>
    publishMarketChange(targets.ingress, { ...config, operationTimeoutMs }, event, Redacted.make(token))
  return {
    config,
    targets,
    register,
    count,
    publish,
    snapshots,
    release: () => release(),
    changed: () => {
      version++
    },
  }
}

describeRestate('Real always-replay public market-hint admission', () => {
  test('HTTP retries keep one public waiter while the latest quiet change survives', async () => {
    const f = fixture()
    const deliveries: MarketChangedWakeup[] = []
    const acknowledged = new Set<string>()
    let transportFailures = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* f.register()
          expect(yield* json(`${f.targets.admin}/services/BaynExecutionController`)).toMatchObject({
            handlers: expect.arrayContaining([
              expect.objectContaining({ name: 'marketChanged', idempotency_retention: '0s', journal_retention: '0s' }),
              expect.objectContaining({ name: 'wake', idempotency_retention: '7d' }),
            ]),
          })
          yield* json(`${f.targets.ingress}/PublicHintRetryTestBridge/start`, {})
          yield* waitFor(() => Effect.sync(() => f.snapshots.length === 1))
          const hints = yield* makeMarketHints(f.config.sourceRevision, randomUUID())
          yield* hints.changed(MarketChangeReason.Startup)
          yield* Effect.forkScoped(
            hints.serve((event) => {
              deliveries.push(event)
              return f.publish(event, 100).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    acknowledged.add(event.eventId)
                  }),
                ),
                Effect.tapError(() =>
                  Effect.sync(() => {
                    transportFailures++
                  }),
                ),
              )
            }),
          )
          yield* waitFor(() =>
            f.count("target LIKE '%/marketChanged' AND status != 'completed'").pipe(Effect.map((count) => count === 1)),
          )
          const first = deliveries[0]
          if (first === undefined) throw new Error('Missing original immutable hint')
          for (let attempt = 0; attempt < 5; attempt++)
            expect(yield* Effect.result(f.publish(first, 100))).toMatchObject({ _tag: 'Failure' })
          expect(transportFailures).toBeGreaterThanOrEqual(1)
          for (let change = 0; change < 1_000; change++) {
            f.changed()
            yield* hints.changed(MarketChangeReason.Data)
          }
          expect(yield* f.count("target LIKE '%/marketChanged' AND status != 'completed'")).toBe(1)
          expect(yield* f.count("target LIKE '%/wake' AND status != 'completed'")).toBe(1)
          f.release()
          yield* waitFor(() => Effect.sync(() => acknowledged.size === 2 && f.snapshots.includes(1_000)))
          expect([...new Set(deliveries.map((event) => event.sequence))]).toEqual([1, 1_001])
          expect(yield* f.count("target LIKE '%/wake' AND idempotency_key LIKE 'bayn-market-change-%'")).toBe(2)
          expect(yield* f.count("target LIKE '%/marketChanged' AND status != 'completed'")).toBe(0)
          yield* waitFor(() => f.count("status != 'completed'").pipe(Effect.map((count) => count === 0)))
        }),
      ).pipe(Effect.ensuring(Effect.sync(f.release))),
    )
  }, 20_000)

  test('a rejected source and a completed lost acknowledgement do not poison the immutable public key', async () => {
    const f = fixture()
    const producerId = randomUUID()
    const event: MarketChangedWakeup = {
      schemaVersion: 'bayn.execution-wakeup.v1',
      _tag: 'MarketChanged',
      sourceRevision: f.config.sourceRevision,
      producerId,
      sequence: 1,
      reason: MarketChangeReason.Recovery,
      eventId: marketChangedEventId(producerId, 1),
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* f.register('d'.repeat(40))
          expect(yield* Effect.result(f.publish(event))).toMatchObject({
            _tag: 'Failure',
            failure: { message: 'market change registration returned HTTP 412' },
          })
          yield* f.register()
          yield* f.publish(event)
          yield* f.publish(event)
          expect(
            yield* f.count(`target LIKE '%/wake' AND idempotency_key = 'bayn-market-change-${event.eventId}'`),
          ).toBe(1)
        }),
      ).pipe(Effect.ensuring(Effect.sync(f.release))),
    )
  }, 20_000)
})
