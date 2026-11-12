import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http2'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { PgClient } from '@effect/sql-pg'
import { Config, Effect, ManagedRuntime, Option, Redacted, Result, Schema } from 'effect'
import type { SqlError } from 'effect/sql/SqlError'

import { sha256 } from '../hash'
import { JevInferenceCompletionSchema } from '../jev/inference-work'
import { brokerObservationJsonSerde } from './restate-broker-observations'
import { makeBaynEntryInference, InferenceDispatchSchema } from './restate-entry-inference'
import { acquireRestateHttp2Server } from './restate-http2-server'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_ADMIN_URL'))).pipe(Option.getOrUndefined)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const postgres = Effect.runSync(Config.option(Config.String('BAYN_TEST_POSTGRES_URL'))).pipe(Option.getOrUndefined)
const describeRestate =
  admin === undefined || ingress === undefined || postgres === undefined ? describe.skip : describe
const alwaysReplay = <A extends { name: string }>(service: A): A => {
  const definition = service as A & { options?: restate.ObjectOptions }
  definition.options = {
    ...definition.options,
    inactivityTimeout: 0,
    // A run retry must survive even a shorter invocation-level failure limit.
    retryPolicy: { ...definition.options?.retryPolicy, maxAttempts: 3, onMaxAttempts: 'pause' },
  }
  return service
}
const json = async (url: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json' },
  })
  if (!response.ok) throw new Error(`Local Restate returned ${response.status}: ${await response.text()}`)
  return response.json() as Promise<unknown>
}
const config = {
  controllerKey: sha256(randomUUID()),
  planHash: 'b'.repeat(64),
  sourceRevision: 'c'.repeat(40),
  operationTimeoutMs: 5_000,
}

describeRestate('Real always-replay admitted inference retry', () => {
  let database: ManagedRuntime.ManagedRuntime<PgClient.PgClient, SqlError>
  beforeAll(async () => {
    if (admin === undefined || ingress === undefined || postgres === undefined)
      throw new Error('Missing local integration targets')
    for (const target of [admin, ingress, postgres])
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname))
        throw new Error('Inference retry integration targets must be local')
    if (!new URL(postgres).pathname.endsWith('_test'))
      throw new Error('Inference retry requires an isolated _test database')
    database = ManagedRuntime.make(
      PgClient.layer({ url: Redacted.make(postgres), maxConnections: 3, transformJson: false }),
    )
    await database.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE TABLE IF NOT EXISTS restate_inference_retry_fixture (
        job_id text PRIMARY KEY, expires_at timestamptz NOT NULL, failures_left integer NOT NULL,
        crash_after_claim boolean NOT NULL, claimed boolean NOT NULL DEFAULT false,
        attempts integer NOT NULL DEFAULT 0, provider_calls integer NOT NULL DEFAULT 0, result_hash text
      )`
      }),
    )
  })
  afterAll(async () => {
    await database?.dispose()
  })

  test.each([
    { name: 'transient failures before the claim', failures: 4, crash: false, lifetimeMs: 15_000, providerCalls: 1 },
    {
      name: 'a lost outcome after the irreversible claim',
      failures: 0,
      crash: true,
      lifetimeMs: 1_500,
      providerCalls: 1,
    },
    { name: 'recovery after the original expiry', failures: 4, crash: false, lifetimeMs: 100, providerCalls: 0 },
  ])(
    '$name uses the same production idempotency key without duplicate paid work',
    async ({ failures, crash, lifetimeMs, providerCalls }) => {
      if (admin === undefined || ingress === undefined) throw new Error('Missing local Restate URLs')
      const jobId = sha256(randomUUID())
      const expiresAt = new Date(Date.now() + lifetimeMs).toISOString()
      const command = {
        schemaVersion: 'bayn.inference-dispatch.v1',
        controllerKey: config.controllerKey,
        sourceRevision: config.sourceRevision,
        epoch: 1,
        jobId,
      }
      const identity = {
        schemaVersion: 'bayn.jev-inference-completion.v1' as const,
        jobId,
        batchId: jobId,
        cycleId: sha256(`${jobId}:cycle`),
        authorityGenerationHash: 'f'.repeat(64),
        expiresAt,
      }
      await database.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`INSERT INTO restate_inference_retry_fixture(job_id, expires_at, failures_left, crash_after_claim)
        VALUES (${jobId}, ${expiresAt}::timestamptz, ${failures}, ${crash})`
        }),
      )
      const executeInference = (input: string, signal: AbortSignal) =>
        database.runPromise(
          Effect.gen(function* () {
            expect(input).toBe(jobId)
            const sql = yield* PgClient.PgClient
            const [attempt] = yield* sql<{ should_fail: boolean }>`WITH prior AS (
        SELECT job_id, failures_left > 0 AS should_fail FROM restate_inference_retry_fixture WHERE job_id=${jobId} FOR UPDATE
      ) UPDATE restate_inference_retry_fixture AS work
        SET attempts=attempts+1, failures_left=GREATEST(failures_left-1,0)
        FROM prior WHERE work.job_id=prior.job_id RETURNING prior.should_fail`
            if (attempt?.should_fail === true)
              return yield* Effect.fail(new Error('Injected transient database failure before claim'))
            const claim = yield* sql<{ crash_after_claim: boolean }>`UPDATE restate_inference_retry_fixture
        SET claimed=true WHERE job_id=${jobId} AND claimed=false AND expires_at>clock_timestamp()
        RETURNING crash_after_claim`
            if (claim.length === 1) {
              // Persist a simulated provider side effect independently of Restate's journaled run result.
              yield* sql`UPDATE restate_inference_retry_fixture SET provider_calls=provider_calls+1 WHERE job_id=${jobId}`
              if (claim[0]?.crash_after_claim === true)
                return yield* Effect.fail(new Error('Injected lost result after claim and provider side effect'))
              yield* sql`UPDATE restate_inference_retry_fixture SET result_hash=${sha256(`${jobId}:provider-result`)} WHERE job_id=${jobId}`
            }
            const [saved] = yield* sql<{
              result_hash: string | null
            }>`SELECT result_hash FROM restate_inference_retry_fixture WHERE job_id=${jobId}`
            return Result.getOrThrow(
              Schema.decodeUnknownResult(JevInferenceCompletionSchema)({
                ...identity,
                completedAt: new Date().toISOString(),
                ...(saved?.result_hash == null
                  ? { status: 'Pending' }
                  : { status: 'Completed', resultHash: saved.result_hash }),
              }),
            )
          }),
          { signal },
        )
      let wakes = 0
      let receivedExpiry: string | undefined
      let attemptsAfterFirstCall = 0
      const inference = alwaysReplay(makeBaynEntryInference(config, { executeInference }))
      const owner = alwaysReplay(
        restate.object({
          name: 'BaynExecutionController',
          handlers: {
            wake: restate.handlers.object.exclusive(
              { ingressPrivate: true },
              async (ctx: restate.ObjectContext, event: unknown) => {
                await ctx.run('retain inference wake', async () => {
                  const decoded = Schema.decodeUnknownSync(
                    Schema.Struct({
                      _tag: Schema.Literals(['InferenceCompleted', 'Barrier']),
                      expiresAt: Schema.String,
                    }),
                  )(event)
                  if (decoded._tag === 'InferenceCompleted') receivedExpiry = decoded.expiresAt
                  wakes += 1
                })
              },
            ),
          },
          options: { ingressPrivate: true, enableLazyState: false },
        }),
      )
      const bridge = alwaysReplay(
        restate.service({
          name: 'InferenceRetryTestBridge',
          handlers: {
            evaluate: async (ctx: restate.Context, candidate: unknown) => {
              const request = Schema.decodeUnknownSync(InferenceDispatchSchema)(candidate)
              await ctx.genericCall({
                service: 'BaynEntryInference',
                method: 'evaluate',
                parameter: request,
                inputSerde: brokerObservationJsonSerde,
                outputSerde: brokerObservationJsonSerde,
                idempotencyKey: `bayn-inference-${request.jobId}`,
              })
              await ctx.genericCall({
                service: 'BaynExecutionController',
                method: 'wake',
                key: config.controllerKey,
                parameter: { _tag: 'Barrier', expiresAt },
                inputSerde: brokerObservationJsonSerde,
                outputSerde: brokerObservationJsonSerde,
                idempotencyKey: `retry-test-barrier-${request.jobId}`,
              })
            },
          },
        }),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const server = createServer(restate.createEndpointHandler({ services: [inference, owner, bridge] }))
            yield* acquireRestateHttp2Server(server, 0)
            const address = server.address()
            if (address === null || typeof address === 'string') throw new Error('Missing local endpoint address')
            yield* Effect.promise(() =>
              json(`${admin}/deployments`, { uri: `http://host.docker.internal:${address.port}`, force: true }),
            )
            expect(yield* Effect.promise(() => json(`${admin}/services/BaynEntryInference`))).toMatchObject({
              inactivity_timeout: '0s',
              retry_policy: { max_attempts: 3, on_max_attempts: 'Pause' },
            })
            yield* Effect.promise(() => json(`${ingress}/InferenceRetryTestBridge/evaluate`, command))
            attemptsAfterFirstCall = yield* Effect.promise(() =>
              database.runPromise(
                Effect.gen(function* () {
                  const sql = yield* PgClient.PgClient
                  const [row] = yield* sql<{
                    attempts: number
                  }>`SELECT attempts FROM restate_inference_retry_fixture WHERE job_id=${jobId}`
                  if (row === undefined) throw new Error('Missing inference retry fixture')
                  return row.attempts
                }),
              ),
            )
            yield* Effect.promise(() => json(`${ingress}/InferenceRetryTestBridge/evaluate`, command))
          }),
        ),
      )
      const rows = await database.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql<{
            attempts: number
            provider_calls: number
            result_hash: string | null
          }>`SELECT attempts,provider_calls,result_hash FROM restate_inference_retry_fixture WHERE job_id=${jobId}`
        }),
      )
      expect(rows[0]?.provider_calls).toBe(providerCalls)
      expect(rows[0]?.attempts).toBe(attemptsAfterFirstCall)
      expect(rows[0]?.attempts).toBeGreaterThanOrEqual(crash ? 3 : failures + 1)
      expect(rows[0]?.result_hash === null).toBe(crash || providerCalls === 0)
      expect(receivedExpiry).toBe(expiresAt)
      expect(wakes).toBe(2)
    },
    30_000,
  )
})
