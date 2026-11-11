import { createServer } from 'node:http2'
import { randomBytes } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { NodeHttpClient } from '@effect/platform-node'
import { Config, Data, Effect, Exit, Option, Schedule, Schema, Scope } from 'effect'

import { acquireRestateHttp2Server } from '../src/restate/restate-http2-server'
import { retireBrokerPolls } from './retire-broker-polls'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_BROKER_POLL_RESTATE_ADMIN_URL'))).pipe(
  Option.getOrUndefined,
)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_BROKER_POLL_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const describeLocal = admin === undefined || ingress === undefined ? describe.skip : describe
class LocalRetirementTestError extends Data.TaggedError('LocalRetirementTestError')<{ readonly cause: unknown }> {}
const jsonSerde = restate.serde.json.schema<unknown>({})
const key = randomBytes(32).toString('hex'),
  otherKey = randomBytes(32).toString('hex'),
  sourceRevision = 'b'.repeat(40),
  oldSourceRevision = 'c'.repeat(40)
const json = (url: string, body?: unknown) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        signal,
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error(`Local Restate HTTP ${response.status}`)
      return response.json() as Promise<unknown>
    },
    catch: (cause) => new LocalRetirementTestError({ cause }),
  })
const RowsSchema = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      target_service_name: Schema.String,
      target_service_key: Schema.optionalKey(Schema.String),
      target_handler_name: Schema.String,
      status: Schema.String,
    }),
  ),
})
const query = (origin: string, sql: string) =>
  json(`${origin}/query`, { query: sql }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RowsSchema)))
const waitFor = <E>(check: () => Effect.Effect<boolean, E>) =>
  Effect.suspend(check).pipe(
    Effect.flatMap((done) => (done ? Effect.void : Effect.fail('local cutover has not progressed'))),
    Effect.retry({ schedule: Schedule.spaced('100 millis'), times: 100 }),
  )
const options = {
  ingressPrivate: false,
  enableLazyState: false,
  inactivityTimeout: 0,
  retryPolicy: { maxAttempts: 3, onMaxAttempts: 'pause', initialInterval: 100, maxInterval: 200 },
} as const
const privateVoid = restate.handlers.object.exclusive(
  { ingressPrivate: true },
  async (_ctx: restate.ObjectContext, _candidate: unknown) => undefined,
)

describeLocal('real Restate obsolete broker poll retirement', () => {
  test('source-proved exact-ID retirement frees obsolete locks and preserves financial, inference, new capture and other account work', async () => {
    if (admin === undefined || ingress === undefined) throw new Error('Missing isolated local Restate URLs')
    for (const origin of [admin, ingress])
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
        throw new Error('Retirement integration target must be local')
    const old = restate.object({
      name: 'BaynBrokerObservations',
      handlers: {
        start: async (ctx: restate.ObjectContext) => {
          for (const sequence of [1, 2])
            ctx.genericSend({
              service: 'BaynBrokerObservations',
              method: 'poll',
              key: ctx.key,
              parameter: { sourceRevision: oldSourceRevision, epoch: 1, sequence },
              inputSerde: jsonSerde,
              delay: { milliseconds: sequence === 1 ? 0 : 60_000 },
              idempotencyKey: `broker-observations:${oldSourceRevision}:1:${sequence}`,
            })
        },
        poll: async (ctx: restate.ObjectContext, _candidate: unknown) => {
          await ctx.sleep({ milliseconds: 1200 })
        },
      },
      options,
    })
    const current = restate.object({
      name: 'BaynBrokerObservations',
      metadata: { 'bayn.source-revision': sourceRevision, 'bayn.broker-identity-hash': key },
      handlers: {
        notify: restate.handlers.object.shared(
          { ingressPrivate: false },
          async (_ctx: restate.ObjectSharedContext, _candidate: unknown) => undefined,
        ),
        accept: privateVoid,
        activate: privateVoid,
        freshness: privateVoid,
        capture: restate.handlers.object.exclusive(
          { ingressPrivate: true },
          async (ctx: restate.ObjectContext, _candidate: unknown) => {
            await ctx.sleep({ milliseconds: 60_000 })
          },
        ),
        status: restate.handlers.object.shared(
          { ingressPrivate: true },
          async (_ctx: restate.ObjectSharedContext, _candidate: unknown) => undefined,
        ),
      },
      options,
    })
    const controller = restate.object({
      name: 'BaynExecutionController',
      handlers: {
        tick: async (ctx: restate.ObjectContext, _candidate: unknown) => {
          await ctx.sleep({ milliseconds: 60_000 })
        },
      },
      options,
    })
    const inference = restate.service({
      name: 'BaynEntryInference',
      handlers: {
        evaluate: async (ctx: restate.Context, _candidate: unknown) => {
          await ctx.sleep({ milliseconds: 60_000 })
        },
      },
      options: { inactivityTimeout: 0 },
    })
    const bridge = restate.service({
      name: 'RetirementTestBridge',
      handlers: {
        queue: async (ctx: restate.Context) => {
          for (const method of ['activate', 'capture'])
            ctx.genericSend({
              service: 'BaynBrokerObservations',
              method,
              key,
              parameter: {},
              inputSerde: jsonSerde,
            })
        },
      },
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const legacyScope = yield* Scope.fork(yield* Effect.scope)
          const server = createServer(restate.createEndpointHandler({ services: [old, controller, inference, bridge] }))
          yield* acquireRestateHttp2Server(server, 0).pipe(Effect.provideService(Scope.Scope, legacyScope))
          const address = server.address()
          if (address === null || typeof address === 'string') throw new Error('Missing test endpoint address')
          const uri = `http://host.docker.internal:${address.port}`
          yield* json(`${admin}/deployments`, { uri, force: true })
          for (const account of [key, otherKey]) yield* json(`${ingress}/BaynBrokerObservations/${account}/start`, {})
          yield* json(`${ingress}/BaynExecutionController/${key}/tick/send`, {})
          yield* json(`${ingress}/BaynEntryInference/evaluate/send`, {})
          yield* waitFor(() =>
            query(
              admin,
              `SELECT id,target_service_name,target_service_key,target_handler_name,status FROM sys_invocation WHERE target_service_name='BaynBrokerObservations' AND target_service_key='${key}' AND target_handler_name='poll' AND status='suspended'`,
            ).pipe(Effect.map((rows) => rows.rows.length === 1)),
          )
          yield* Scope.close(legacyScope, Exit.succeed(undefined))
          const replacement = createServer(
            restate.createEndpointHandler({ services: [current, controller, inference, bridge] }),
          )
          yield* acquireRestateHttp2Server(replacement, address.port)
          yield* json(`${admin}/deployments`, { uri, force: true })
          expect(yield* json(`${admin}/services/BaynBrokerObservations`)).toMatchObject({ inactivity_timeout: '0s' })
          yield* json(`${ingress}/RetirementTestBridge/queue`, {})
          yield* waitFor(() =>
            query(
              admin,
              `SELECT id,target_service_name,target_service_key,target_handler_name,status FROM sys_invocation WHERE target_service_name='BaynBrokerObservations' AND target_service_key='${key}' AND target_handler_name='poll' AND status='paused'`,
            ).pipe(Effect.map((rows) => rows.rows.length === 1)),
          )
          const before = yield* query(
            admin,
            'SELECT id,target_service_name,target_service_key,target_handler_name,status FROM sys_invocation WHERE completed_at IS NULL',
          )
          const preview = yield* retireBrokerPolls({
            adminUrl: admin,
            controllerKey: key,
            sourceRevision,
            obsoleteSourceRevisions: [oldSourceRevision],
            apply: false,
          })
          expect(preview.candidates).toHaveLength(2)
          expect(preview.candidates.map((candidate) => candidate.sequence).sort((a, b) => a - b)).toEqual([1, 2])
          expect(preview.retired).toEqual([])
          expect(preview.candidates.map((candidate) => candidate.sourceEvidence)).toEqual([
            'invocation-input',
            'invocation-input',
          ])
          const protectedIds = before.rows
            .filter(
              (row) =>
                !(
                  row.target_service_name === 'BaynBrokerObservations' &&
                  row.target_service_key === key &&
                  row.target_handler_name === 'poll'
                ),
            )
            .map((row) => row.id)
          expect(protectedIds.length).toBeGreaterThanOrEqual(5)
          const receipt = yield* retireBrokerPolls({
            adminUrl: admin,
            controllerKey: key,
            sourceRevision,
            obsoleteSourceRevisions: [oldSourceRevision],
            apply: true,
          })
          expect(new Set(receipt.retired)).toEqual(new Set(preview.candidates.map((candidate) => candidate.id)))
          yield* waitFor(() =>
            query(
              admin,
              `SELECT id,target_service_name,target_service_key,target_handler_name,status FROM sys_invocation WHERE target_service_name='BaynBrokerObservations' AND target_service_key='${key}' AND target_handler_name='activate'`,
            ).pipe(Effect.map((rows) => rows.rows.length === 1 && rows.rows[0]?.status === 'completed')),
          )
          const after = yield* query(
            admin,
            'SELECT id,target_service_name,target_service_key,target_handler_name,status FROM sys_invocation',
          )
          for (const id of protectedIds) {
            const row = after.rows.find((row) => row.id === id)
            expect(row).toBeDefined()
            if (row?.target_handler_name !== 'activate') expect(row?.status).not.toBe('completed')
          }
          const second = yield* retireBrokerPolls({
            adminUrl: admin,
            controllerKey: key,
            sourceRevision,
            obsoleteSourceRevisions: [oldSourceRevision],
            apply: true,
          })
          expect(second.candidates).toEqual([])
          expect(second.retired).toEqual([])
        }).pipe(
          // @effect-diagnostics-next-line strictEffectProvide:off -- this test owns the local Admin HTTP client
          Effect.provide(NodeHttpClient.layerNodeHttp),
        ),
      ),
    )
  }, 30_000)
})
