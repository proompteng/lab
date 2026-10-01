import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Config, Effect, Exit, Option, Schedule, Scope } from 'effect'

import { acquireRestateHttp2Server } from './restate-http2-server'
import { brokerObservationJsonSerde, makeBaynBrokerObservations } from './restate-broker-observations'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_ADMIN_URL'))).pipe(Option.getOrUndefined)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const describeRestate = admin === undefined || ingress === undefined ? describe.skip : describe
const config = {
  controllerKey: randomUUID().replaceAll('-', '').repeat(2),
  sourceRevision: '2'.repeat(40),
  pollIntervalMs: 1000,
  operationTimeoutMs: 5000,
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

describeRestate('Real Restate broker observation journal', () => {
  test('private RPC, delayed polls, duplicate invocation and endpoint restart retain one owner', async () => {
    if (admin === undefined || ingress === undefined) throw new Error('Missing local Restate URLs')
    for (const target of [admin, ingress]) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname))
        throw new Error('Restate integration targets must be local')
    }
    let activations = 0
    let polls = 0
    let fail = false
    const makeObserved = () =>
      makeBaynBrokerObservations(config, {
        nextPollNotBeforeMs: async () => 0,
        activate: async () => {
          activations += 1
        },
        poll: async () => {
          polls += 1
          return fail
            ? { _tag: 'Unavailable', nextPollNotBeforeMs: 0 }
            : { _tag: 'Published', snapshotHash: '3'.repeat(64), nextPollNotBeforeMs: 0 }
        },
      })
    const bridge = restate.service({
      name: 'ObservationTestBridge',
      handlers: {
        start: async (ctx: restate.Context) =>
          ctx.genericCall({
            service: 'BaynBrokerObservations',
            method: 'activate',
            key: config.controllerKey,
            parameter: { sourceRevision: config.sourceRevision },
            inputSerde: brokerObservationJsonSerde,
            outputSerde: brokerObservationJsonSerde,
          }),
        status: async (ctx: restate.Context) =>
          ctx.genericCall({
            service: 'BaynBrokerObservations',
            method: 'status',
            key: config.controllerKey,
            parameter: undefined,
            inputSerde: brokerObservationJsonSerde,
            outputSerde: brokerObservationJsonSerde,
          }),
      },
    })
    const handler = restate.createEndpointHandler({ services: [makeObserved(), bridge] })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = createServer(handler)
          const endpointScope = yield* Scope.fork(yield* Effect.scope)
          yield* acquireRestateHttp2Server(server, 0).pipe(Effect.provideService(Scope.Scope, endpointScope))
          const address = server.address()
          if (address === null || typeof address === 'string') throw new Error('Missing local endpoint address')
          yield* json(`${admin}/deployments`, { uri: `http://host.docker.internal:${address.port}`, force: true })
          const invoke = (method: string, id?: string) =>
            json(
              `${ingress}/ObservationTestBridge/${method}`,
              {},
              id === undefined ? undefined : { 'idempotency-key': id },
            )
          const activationId = randomUUID()
          const result = yield* invoke('start', activationId)
          expect(result).toMatchObject({
            sourceRevision: config.sourceRevision,
            epoch: 1,
            sequence: 1,
            lastSnapshotHash: '3'.repeat(64),
          })
          expect(activations).toBe(1)
          expect(polls).toBe(1)
          expect(yield* invoke('start', activationId)).toEqual(result)
          expect(polls).toBe(1)
          const denied = yield* Effect.promise(() =>
            fetch(`${ingress}/BaynBrokerObservations/${config.controllerKey}/activate`, {
              method: 'POST',
              body: JSON.stringify({ sourceRevision: config.sourceRevision }),
              headers: { 'content-type': 'application/json' },
            }),
          )
          expect(denied.status).toBe(400)
          expect(yield* Effect.promise(() => denied.json())).toEqual({
            code: 400,
            message: 'the invoked service is not public',
            source: 'ingress',
          })
          yield* waitFor(() =>
            invoke('status').pipe(
              Effect.map(
                (value) =>
                  typeof value === 'object' && value !== null && 'sequence' in value && Number(value.sequence) >= 2,
              ),
            ),
          )
          expect(polls).toBeGreaterThanOrEqual(2)
          fail = true
          yield* waitFor(() =>
            invoke('status').pipe(
              Effect.map((value) => typeof value === 'object' && value !== null && !('lastSnapshotHash' in value)),
            ),
          )
          fail = false
          yield* waitFor(() =>
            invoke('status').pipe(
              Effect.map((value) => typeof value === 'object' && value !== null && 'lastSnapshotHash' in value),
            ),
          )
          expect(activations).toBe(1)
          const beforeRestart = polls
          yield* Scope.close(endpointScope, Exit.succeed(undefined))
          yield* Effect.sleep('1200 millis')
          const restarted = createServer(restate.createEndpointHandler({ services: [makeObserved(), bridge] }))
          yield* acquireRestateHttp2Server(restarted, address.port)
          yield* waitFor(() => invoke('status').pipe(Effect.map(() => polls > beforeRestart)))
          expect(activations).toBe(1)
          expect(polls).toBeGreaterThan(beforeRestart)
        }),
      ),
    )
  }, 30_000)
})
