import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Config, Effect, Option, Result } from 'effect'
import type { CaptureInvalidation, ResearchCaptureEvent } from '../research-capture/capture'

import { decodeExecutionControllerState } from '../execution/controller'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { acquireRestateHttp2Server } from './restate-http2-server'
import { makeBaynBrokerObservations } from './restate-broker-observations'
import { restateExecutionActivationRequest } from './restate-execution-activate'
import { executionActivationAuthorizationHash, makeBaynExecutionController } from './restate-execution-controller'
import { awaitRestateInvocation, sendRestateInvocation } from './restate-invocation-client'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_ADMIN_URL'))).pipe(Option.getOrUndefined)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const describeRestate = admin === undefined || ingress === undefined ? describe.skip : describe

describeRestate('Real Restate execution deployment activation', () => {
  test('new activation attempts recover after dependency failure while retained replay stays idempotent', async () => {
    if (admin === undefined || ingress === undefined) throw new Error('Missing local Restate URLs')
    for (const target of [admin, ingress]) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname))
        throw new Error('Restate integration targets must be local')
    }
    const token = Buffer.alloc(32, 7).toString('base64url')
    const config = {
      controllerKey: randomUUID().replaceAll('-', '').repeat(2),
      planHash: 'b'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      operationTimeoutMs: 5_000,
      activationAuthorizationHash: Result.getOrThrow(executionActivationAuthorizationHash(token)),
    }
    let brokerActivations = 0
    let brokerPolls = 0
    let brokerReady = false
    let controllerActivations = 0
    const advanced: number[] = []
    const issuedAtBySequence = new Map<number, string>()
    const captured: ResearchCaptureEvent[] = []
    const invalidations: CaptureInvalidation[] = []
    const controller = makeBaynExecutionController(config, {
      capture: {
        record: (event) => {
          captured.push(event)
        },
        invalidate: (reason) => {
          invalidations.push(reason)
        },
      },
      advance: async (command) => {
        advanced.push(command.sequence)
        issuedAtBySequence.set(command.sequence, command.issuedAt)
        return {
          completedAt: command.issuedAt,
          observation: { result: 'SUCCESS', observedAt: command.issuedAt, outcome: 'WINDOW_CLOSED' },
          outcome: { _tag: ExecutionControllerOutcome.Waiting, receiptHash: 'd'.repeat(64), nextDelayMs: 500 },
        }
      },
      projectState: async () => {
        controllerActivations += 1
      },
      log: () => Promise.resolve(),
    })
    const observations = makeBaynBrokerObservations(
      { ...config, pollIntervalMs: 1_000 },
      {
        nextPollNotBeforeMs: async () => 0,
        preparePoll: async () => 'test-capture',
        activate: async () => {
          brokerActivations += 1
        },
        poll: async () => {
          brokerPolls += 1
          if (!brokerReady) throw new Error('Broker observation dependency is temporarily unavailable')
          return { _tag: 'Published', snapshotHash: 'e'.repeat(64), nextPollNotBeforeMs: 0 }
        },
      },
    )
    const deployment = {
      ...config,
      activationAttemptId: randomUUID(),
      activationGeneration: '1'.repeat(64),
      ingressOrigin: ingress,
    }
    const firstRequest = restateExecutionActivationRequest(deployment, token)
    const body = firstRequest.body
    const invoke = (key: string, method: string, authorization?: string) =>
      Effect.tryPromise({
        try: (signal) =>
          fetch(`${ingress}/BaynExecutionController/${key}/${method}`, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) },
            signal,
          }),
        catch: (cause) => cause,
      })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const register = (server: ReturnType<typeof createServer>) =>
            Effect.gen(function* () {
              yield* acquireRestateHttp2Server(server, 0)
              const address = server.address()
              if (address === null || typeof address === 'string') throw new Error('Missing local endpoint address')
              yield* Effect.tryPromise({
                try: async (signal) => {
                  const response = await fetch(`${admin}/deployments`, {
                    method: 'POST',
                    body: JSON.stringify({ uri: `http://host.docker.internal:${address.port}` }),
                    headers: { 'content-type': 'application/json' },
                    signal,
                  })
                  if (!response.ok) throw new Error(`Local Restate registration failed: ${await response.text()}`)
                  await response.body?.cancel()
                },
                catch: (cause) => cause,
              })
            })
          const predecessor = restate.object({
            name: 'BaynExecutionController',
            handlers: {
              activate: (_ctx: restate.ObjectContext, candidate: unknown) => Promise.resolve(candidate),
              tick: () => Promise.resolve(),
              deactivate: (_ctx: restate.ObjectContext, candidate: unknown) => Promise.resolve(candidate),
              status: restate.handlers.object.shared(() => Promise.resolve(null)),
            },
            options: { ingressPrivate: true },
          })
          yield* register(createServer(restate.createEndpointHandler({ services: [predecessor, observations] })))
          yield* register(createServer(restate.createEndpointHandler({ services: [controller, observations] })))
          const unauthenticated = yield* invoke(config.controllerKey, 'activateDeployment')
          expect(unauthenticated.ok).toBe(false)
          expect(yield* Effect.promise(() => unauthenticated.text())).toContain(
            'deployment activation authorization failed',
          )
          const wrongKey = yield* invoke('f'.repeat(64), 'activateDeployment', `Bearer ${token}`)
          expect(wrongKey.ok).toBe(false)
          expect(yield* Effect.promise(() => wrongKey.text())).toContain('does not match this immutable deployment')
          expect(brokerActivations).toBe(0)
          expect(controllerActivations).toBe(0)
          for (const method of ['activate', 'tick', 'deactivate', 'status']) {
            const denied = yield* invoke(config.controllerKey, method, `Bearer ${token}`)
            expect(denied.status).toBe(400)
            expect(yield* Effect.promise(() => denied.text())).toContain('the invoked service is not public')
          }
          const url = `${ingress}${firstRequest.path}`
          const failedOptions = { timeoutMs: 5_000, headers: firstRequest.headers }
          const failed = yield* sendRestateInvocation(url, body, failedOptions)
          const failure = yield* Effect.flip(
            awaitRestateInvocation(ingress, failed.invocationId, {
              maximumAttempts: 100,
              pollIntervalMs: 100,
              requestTimeoutMs: 5_000,
            }),
          )
          expect(failure).toMatchObject({
            operation: 'await',
            cause: { message: 'Restate invocation output returned HTTP 400' },
          })
          expect(controllerActivations).toBe(0)
          brokerReady = true
          const failedReplay = yield* sendRestateInvocation(url, body, failedOptions)
          expect(failedReplay.invocationId).toBe(failed.invocationId)
          expect(
            yield* Effect.flip(
              awaitRestateInvocation(ingress, failedReplay.invocationId, {
                maximumAttempts: 1,
                pollIntervalMs: 100,
                requestTimeoutMs: 5_000,
              }),
            ),
          ).toMatchObject({ operation: 'await' })
          const retry = restateExecutionActivationRequest({ ...deployment, activationAttemptId: randomUUID() }, token)
          const options = {
            timeoutMs: 5_000,
            headers: retry.headers,
          }
          const accepted = yield* sendRestateInvocation(url, retry.body, options)
          expect(accepted.invocationId).not.toBe(failed.invocationId)
          const output = yield* awaitRestateInvocation(ingress, accepted.invocationId, {
            maximumAttempts: 100,
            pollIntervalMs: 100,
            requestTimeoutMs: 5_000,
          })
          const state = Result.getOrThrow(decodeExecutionControllerState(output))
          expect(state).toMatchObject({
            active: true,
            epoch: 1,
            planHash: config.planHash,
            sourceRevision: config.sourceRevision,
          })
          expect(state.lastCompletion?.sequence).toBeGreaterThan(state.initialSequence)
          expect(state.nextSequence).toBe((state.lastCompletion?.sequence ?? -1) + 1)
          expect(advanced.length).toBeGreaterThanOrEqual(2)
          expect(new Set(advanced).size).toBe(advanced.length)
          const starts = captured.filter((event) => event.kind === 'controller-pass' && event.phase === 'STARTED')
          expect(starts.map((event) => (event.kind === 'controller-pass' ? event.tick.sequence : undefined))).toEqual(
            advanced,
          )
          const completions = captured.filter(
            (event) => event.kind === 'controller-pass' && event.phase === 'COMPLETED',
          )
          expect(completions.length).toBeGreaterThanOrEqual(2)
          for (const event of completions) {
            if (event.kind !== 'controller-pass') throw new Error('Missing native controller receipt')
            expect(event.runtimeAttempted).toBe(true)
            expect(event.commandIssuedAt).toBe(issuedAtBySequence.get(event.tick.sequence))
            expect(event.sourceRevision).toBe(config.sourceRevision)
            expect(event.receiptHash).toBe('d'.repeat(64))
          }
          expect(
            captured.some(
              (event) =>
                event.kind === 'controller-pass' && event.phase === 'SCHEDULED' && event.idempotencyKey !== undefined,
            ),
          ).toBe(true)
          expect(invalidations).toEqual([])
          expect(brokerPolls).toBeGreaterThanOrEqual(1)
          expect(brokerActivations).toBe(1)
          expect(controllerActivations).toBe(1)
          const journal = yield* Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(`${admin}/query`, {
                method: 'POST',
                body: JSON.stringify({
                  query: `SELECT COUNT(*) AS journal_entries FROM sys_journal WHERE id IN ('${failed.invocationId}', '${accepted.invocationId}')`,
                }),
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                signal,
              })
              if (!response.ok) throw new Error(`Local Restate journal query failed with HTTP ${response.status}`)
              return response.json() as Promise<unknown>
            },
            catch: (cause) => cause,
          })
          expect(journal).toMatchObject({ rows: [{ journal_entries: 0 }] })
          const replay = yield* sendRestateInvocation(url, body, options)
          expect(replay.invocationId).toBe(accepted.invocationId)
          expect(
            yield* awaitRestateInvocation(ingress, replay.invocationId, {
              maximumAttempts: 1,
              pollIntervalMs: 100,
              requestTimeoutMs: 5_000,
            }),
          ).toEqual(output)
          expect(brokerActivations).toBe(1)
          expect(controllerActivations).toBe(1)
        }),
      ),
    )
  }, 30_000)
})
