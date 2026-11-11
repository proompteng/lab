import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Config, Effect, Option, Result, Schedule } from 'effect'

import { decodeExecutionControllerState } from '../execution/controller'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { sha256 } from '../hash'
import { makeBaynEntryInference } from './restate-entry-inference'
import { acquireRestateHttp2Server } from './restate-http2-server'
import { brokerObservationJsonSerde } from './restate-broker-observations'
import { executionActivationAuthorizationHash, makeBaynExecutionController } from './restate-execution-controller'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_ADMIN_URL'))).pipe(Option.getOrUndefined)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const describeRestate = admin === undefined || ingress === undefined ? describe.skip : describe
const alwaysReplay = <A extends { name: string }>(service: A): A => {
  const definition = service as A & { options?: restate.ObjectOptions }
  definition.options = { ...definition.options, inactivityTimeout: 0 }
  return service
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
    Effect.flatMap((ready) =>
      ready ? Effect.void : Effect.fail('streaming owner has not reached the expected boundary'),
    ),
    Effect.retry({ schedule: Schedule.spaced('100 millis'), times: 100 }),
  )

describeRestate('Real always-replay streaming execution', () => {
  test('provider work releases the owner for burst and protection progress, then stale completion cannot reenter a new epoch', async () => {
    if (admin === undefined || ingress === undefined) throw new Error('Missing local Restate URLs')
    for (const target of [admin, ingress])
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname))
        throw new Error('Restate integration targets must be local')
    const controllerKey = sha256(randomUUID())
    const token = Buffer.alloc(32, 7).toString('base64url')
    const config = {
      controllerKey,
      planHash: 'b'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      operationTimeoutMs: 5_000,
      activationAuthorizationHash: Result.getOrThrow(executionActivationAuthorizationHash(token)),
    }
    const jobId = sha256(`${controllerKey}:job`)
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const passes: Array<{ epoch: number; sequence: number }> = []
    let providerCalls = 0
    let providerEntered = false
    let ignoredStale = false
    let releaseProvider: () => void = () => undefined
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    let prepared = false
    const controller = alwaysReplay(
      makeBaynExecutionController(config, {
        prepareActivation: async () => undefined,
        projectState: async () => undefined,
        log: async (_level, message) => {
          ignoredStale ||= message === 'Bayn ignored a stale inference completion'
        },
        advance: async (command) => {
          passes.push(command)
          const first = !prepared
          prepared = true
          const completedAt = new Date().toISOString()
          return {
            completedAt,
            outcome: {
              _tag: ExecutionControllerOutcome.Waiting,
              receiptHash: sha256(`${command.epoch}:${command.sequence}`),
              nextDelayMs: 1,
              ...(first
                ? { nextWakeAt: expiresAt }
                : passes.length === 2
                  ? { nextWakeAt: new Date(Date.now() + 100).toISOString() }
                  : {}),
            },
            ...(first
              ? {
                  inferenceJobs: [
                    {
                      schemaVersion: 'bayn.jev-inference-job.v1' as const,
                      jobId,
                      batchId: jobId,
                      cycleId: sha256(`${controllerKey}:cycle`),
                      authorityGenerationHash: 'f'.repeat(64),
                      expiresAt,
                      status: 'Prepared' as const,
                    },
                  ],
                }
              : {}),
          }
        },
      }),
    )
    const inference = alwaysReplay(
      makeBaynEntryInference(config, {
        executeInference: async () => {
          providerCalls += 1
          providerEntered = true
          await providerGate
          return {
            schemaVersion: 'bayn.jev-inference-completion.v1',
            jobId,
            batchId: jobId,
            cycleId: sha256(`${controllerKey}:cycle`),
            authorityGenerationHash: 'f'.repeat(64),
            expiresAt,
            completedAt: new Date().toISOString(),
            status: 'Completed',
            resultHash: '1'.repeat(64),
          }
        },
      }),
    )
    const bridge = alwaysReplay(
      restate.service({
        name: 'StreamingExecutionTestBridge',
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
          status: (ctx: restate.Context) =>
            ctx.genericCall({
              service: 'BaynExecutionController',
              method: 'status',
              key: controllerKey,
              parameter: {},
              inputSerde: brokerObservationJsonSerde,
              outputSerde: brokerObservationJsonSerde,
            }),
          rotate: (ctx: restate.Context) =>
            ctx.genericCall({
              service: 'BaynExecutionController',
              method: 'rotate',
              key: controllerKey,
              parameter: {
                schemaVersion: 'bayn.execution-controller-rotation.v1',
                deployment: {
                  schemaVersion: 'bayn.execution-deployment-activation.v2',
                  controllerKey,
                  planHash: config.planHash,
                  sourceRevision: config.sourceRevision,
                },
                predecessor: {
                  schemaVersion: 'bayn.execution-controller-deactivation.v1',
                  controllerKey,
                  epoch: 1,
                  planHash: config.planHash,
                  sourceRevision: config.sourceRevision,
                },
              },
              inputSerde: brokerObservationJsonSerde,
              outputSerde: brokerObservationJsonSerde,
            }),
        },
      }),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = createServer(restate.createEndpointHandler({ services: [controller, inference, bridge] }))
          yield* acquireRestateHttp2Server(server, 0)
          const address = server.address()
          if (address === null || typeof address === 'string') throw new Error('Missing endpoint address')
          yield* json(`${admin}/deployments`, { uri: `http://host.docker.internal:${address.port}`, force: true })
          expect(yield* json(`${admin}/services/BaynExecutionController`)).toMatchObject({ inactivity_timeout: '0s' })
          expect(yield* json(`${admin}/services/BaynEntryInference`)).toMatchObject({ inactivity_timeout: '0s' })
          const invoke = (method: string) => json(`${ingress}/StreamingExecutionTestBridge/${method}`, {})
          yield* invoke('start')
          yield* waitFor(() => Effect.sync(() => passes.length === 1 && providerEntered))
          expect(providerCalls).toBe(1)
          const readyAt = new Date().toISOString()
          const event = {
            schemaVersion: 'bayn.execution-wakeup.v1',
            _tag: 'MarketReady',
            sourceRevision: config.sourceRevision,
            eventId: sha256(`${controllerKey}:frontier`),
            captureId: sha256(`${controllerKey}:capture`),
            sourceEpoch: 'source-1',
            consumerSequence: 1,
            projectionSequence: 1,
            originalAvailableAt: readyAt,
            readyAt,
          }
          const denied = yield* Effect.promise(() =>
            fetch(`${ingress}/BaynExecutionController/${controllerKey}/marketReady`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(event),
            }),
          )
          expect(denied.status).toBe(403)
          yield* Effect.promise(async () => {
            await denied.body?.cancel()
          })
          yield* Effect.all(
            Array.from({ length: 100 }, () =>
              json(`${ingress}/BaynExecutionController/${controllerKey}/marketReady`, event, {
                authorization: `Bearer ${token}`,
                'idempotency-key': event.eventId,
              }),
            ),
            { concurrency: 20 },
          )
          yield* waitFor(() => Effect.sync(() => passes.length >= 3))
          expect(passes.map(({ epoch, sequence }) => ({ epoch, sequence }))).toEqual([
            { epoch: 1, sequence: 0 },
            { epoch: 1, sequence: 1 },
            { epoch: 1, sequence: 2 },
          ])
          expect(providerCalls).toBe(1)
          expect(ignoredStale).toBe(false)
          yield* invoke('rotate')
          yield* waitFor(() => Effect.sync(() => passes.some((pass) => pass.epoch === 2)))
          const beforeCompletion = passes.length
          releaseProvider()
          yield* waitFor(() => Effect.sync(() => ignoredStale))
          expect(passes).toHaveLength(beforeCompletion)
          const state = Result.getOrThrow(decodeExecutionControllerState(yield* invoke('status')))
          expect(state).toMatchObject({ active: true, epoch: 2, nextSequence: beforeCompletion })
          expect(state.nextDueAt).toBeUndefined()
          expect(providerCalls).toBe(1)
        }),
      ),
    )
  }, 30_000)
})
