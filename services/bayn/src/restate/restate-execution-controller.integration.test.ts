import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Clock, Config, ConfigProvider, Effect, Option, Result } from 'effect'

import { decodeExecutionControllerState } from '../execution/controller'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { acquireRestateHttp2Server } from './restate-http2-server'
import { makeBaynBrokerObservations } from './restate-broker-observations'
import {
  restateExecutionActivationRequest,
  restateExecutionActivationTransportConfig,
} from './restate-execution-activate'
import { executionActivationAuthorizationHash, makeBaynExecutionController } from './restate-execution-controller'
import { awaitRestateInvocation, RestateSendStatus, sendRestateInvocation } from './restate-invocation-client'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_ADMIN_URL'))).pipe(Option.getOrUndefined)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const describeRestate = admin === undefined || ingress === undefined ? describe.skip : describe

describeRestate('Real Restate execution deployment activation', () => {
  test('new Jobs recover after dependency failure while restarted waiters reuse one native coordinator', async () => {
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
    let failedPollNotBeforeMs = 0
    let controllerActivations = 0
    const advanced: number[] = []
    const controller = makeBaynExecutionController(config, {
      advance: async (command) => {
        advanced.push(command.sequence)
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
        activate: async () => {
          brokerActivations += 1
        },
        poll: async () => {
          const now = Clock.Clock.defaultValue().currentTimeMillisUnsafe()
          if (failedPollNotBeforeMs > now)
            return {
              poll: { _tag: 'QuotaWait', nextPollNotBeforeMs: failedPollNotBeforeMs },
              startedAtMs: now,
              completedAtMs: now,
            }
          brokerPolls += 1
          if (!brokerReady) {
            failedPollNotBeforeMs = now + 5_000
            throw new Error('Broker observation dependency is temporarily unavailable')
          }
          return {
            poll: { _tag: 'Published', snapshotHash: 'e'.repeat(64), nextPollNotBeforeMs: 0 },
            startedAtMs: now,
            completedAtMs: now,
          }
        },
      },
    )
    const loadAttempt = (jobUid: string) =>
      restateExecutionActivationTransportConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            BAYN_EXECUTION_ACTIVATION_ATTEMPT_ID: jobUid,
            BAYN_EXECUTION_ACTIVATION_GENERATION: '1'.repeat(64),
            BAYN_EXECUTION_ACTIVATION_TOKEN: token,
            RESTATE_INGRESS_ORIGIN: ingress,
          }),
        ),
      )
    const deployment = {
      ...config,
      ...(await Effect.runPromise(loadAttempt(randomUUID()))),
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
          for (const method of ['activate', 'tick', 'deactivate', 'prepareActivation', 'status']) {
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
          const replacementJobUid = randomUUID()
          const retry = restateExecutionActivationRequest(
            { ...config, ...(yield* loadAttempt(replacementJobUid)) },
            token,
          )
          const options = {
            timeoutMs: 5_000,
            headers: retry.headers,
          }
          const accepted = yield* sendRestateInvocation(url, retry.body, options)
          expect(accepted.invocationId).not.toBe(failed.invocationId)
          const waiting = yield* Effect.flip(
            awaitRestateInvocation(ingress, accepted.invocationId, {
              maximumAttempts: 1,
              pollIntervalMs: 100,
              requestTimeoutMs: 5_000,
            }),
          )
          expect(waiting.message).toBe('Restate invocation remains incomplete after the bounded completion check')
          for (let restart = 0; restart < 2; restart += 1) {
            const restarted = restateExecutionActivationRequest(
              { ...config, ...(yield* loadAttempt(replacementJobUid)) },
              token,
            )
            const resumed = yield* sendRestateInvocation(url, restarted.body, {
              ...options,
              headers: restarted.headers,
            })
            expect(resumed.invocationId).toBe(accepted.invocationId)
            expect(resumed.status).toBe(RestateSendStatus.PreviouslyAccepted)
          }
          const quotaWaitMs = Math.max(0, failedPollNotBeforeMs - (yield* Clock.currentTimeMillis))
          expect(quotaWaitMs).toBeGreaterThan(0)
          const output = yield* awaitRestateInvocation(ingress, accepted.invocationId, {
            maximumAttempts: Math.ceil((quotaWaitMs + 15_000) / 100) + 1,
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
          expect(brokerPolls).toBeGreaterThanOrEqual(1)
          expect(brokerActivations).toBe(1)
          expect(controllerActivations).toBe(1)
          const journal = yield* Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(`${admin}/query`, {
                method: 'POST',
                body: JSON.stringify({
                  query: `SELECT COUNT(*) AS journal_entries,
                    (SELECT COUNT(*) FROM sys_journal WHERE entry_type = 'Command: GetLazyState'
                      AND id IN (SELECT id FROM sys_invocation
                        WHERE target_service_name = 'BaynExecutionController'
                          AND target_service_key = '${config.controllerKey}' AND target_handler_name = 'tick')) AS lazy_tick_state_reads
                    FROM sys_journal WHERE id IN ('${failed.invocationId}', '${accepted.invocationId}')`,
                }),
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                signal,
              })
              if (!response.ok) throw new Error(`Local Restate journal query failed with HTTP ${response.status}`)
              return response.json() as Promise<unknown>
            },
            catch: (cause) => cause,
          })
          expect(journal).toMatchObject({ rows: [{ journal_entries: 0, lazy_tick_state_reads: 0 }] })
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

          let previousSource = config.sourceRevision
          let previousNextSequence = state.nextSequence
          const allReplacementAdvances: Array<Array<{ sequence: number }>> = []
          const allProjections: Array<Array<{ active: boolean; epoch: number; sourceRevision: string }>> = []
          let delayedActivation: { invocationId: string; release: () => void } | undefined
          for (const [expectedEpoch, replacementSourceRevision] of [
            [2, 'f'.repeat(40)],
            [3, 'e'.repeat(40)],
          ] as const) {
            const replacementConfig = {
              ...config,
              sourceRevision: replacementSourceRevision,
              planHash: '8'.repeat(64),
            }
            const replacementAdvances: Array<{ epoch: number; sequence: number; sourceRevision: string }> = []
            allReplacementAdvances.push(replacementAdvances)
            const projected: Array<{ active: boolean; epoch: number; sourceRevision: string }> = []
            allProjections.push(projected)
            const replacementController = makeBaynExecutionController(replacementConfig, {
              advance: async (command) => {
                replacementAdvances.push(command)
                return {
                  completedAt: command.issuedAt,
                  observation: { result: 'SUCCESS', observedAt: command.issuedAt, outcome: 'WINDOW_CLOSED' },
                  outcome: { _tag: ExecutionControllerOutcome.Waiting, receiptHash: 'f'.repeat(64), nextDelayMs: 500 },
                }
              },
              projectState: async (_key, next) => {
                projected.push(next)
              },
              log: () => Promise.resolve(),
            })
            const replacementObservations = makeBaynBrokerObservations(
              { ...replacementConfig, pollIntervalMs: 1_000 },
              {
                activate: () => Promise.resolve(),
                poll: async () => {
                  const now = Clock.Clock.defaultValue().currentTimeMillisUnsafe()
                  return {
                    poll: { _tag: 'Published', snapshotHash: 'f'.repeat(64), nextPollNotBeforeMs: 0 },
                    startedAtMs: now,
                    completedAtMs: now,
                  }
                },
              },
            )
            yield* register(
              createServer(
                restate.createEndpointHandler({ services: [replacementController, replacementObservations] }),
              ),
            )
            const rotation = restateExecutionActivationRequest(
              { ...replacementConfig, ...(yield* loadAttempt(randomUUID())) },
              token,
            )
            const rotationOptions = { timeoutMs: 5_000, headers: rotation.headers }
            const rotationReceipt = yield* sendRestateInvocation(url, rotation.body, rotationOptions)
            const rotatedOutput = yield* awaitRestateInvocation(ingress, rotationReceipt.invocationId, {
              maximumAttempts: 200,
              pollIntervalMs: 100,
              requestTimeoutMs: 5_000,
            })
            const rotated = Result.getOrThrow(decodeExecutionControllerState(rotatedOutput))
            expect(rotated).toMatchObject({
              active: true,
              epoch: expectedEpoch,
              planHash: replacementConfig.planHash,
              sourceRevision: replacementConfig.sourceRevision,
            })
            expect(rotated.initialSequence).toBeGreaterThanOrEqual(previousNextSequence)
            expect(rotated.lastCompletion?.sequence).toBeGreaterThan(rotated.initialSequence)
            expect(projected).toEqual([
              expect.objectContaining({ active: false, epoch: expectedEpoch, sourceRevision: previousSource }),
              expect.objectContaining({
                active: true,
                epoch: expectedEpoch,
                sourceRevision: replacementConfig.sourceRevision,
              }),
            ])
            expect(replacementAdvances.length).toBeGreaterThanOrEqual(2)
            expect(
              replacementAdvances.every(
                (command) =>
                  command.epoch === expectedEpoch && command.sourceRevision === replacementConfig.sourceRevision,
              ),
            ).toBe(true)
            const replayedRotation = yield* sendRestateInvocation(url, rotation.body, rotationOptions)
            expect(replayedRotation.invocationId).toBe(rotationReceipt.invocationId)
            expect(projected).toHaveLength(2)
            previousSource = replacementConfig.sourceRevision
            previousNextSequence = rotated.nextSequence
            if (expectedEpoch === 2) {
              let release = () => {}
              let received = () => {}
              const gate = new Promise<void>((resolve) => {
                release = resolve
              })
              const requestSeen = new Promise<void>((resolve) => {
                received = resolve
              })
              const endpoint = restate.createEndpointHandler({
                services: [replacementController, replacementObservations],
              })
              yield* register(
                createServer((request, response) => {
                  if (request.url.endsWith('/activateDeployment')) {
                    received()
                    void gate
                      .then(() => endpoint(request, response))
                      .catch((cause: unknown) => {
                        response.destroy(cause instanceof Error ? cause : new Error('Delayed fixture handler failed'))
                      })
                  } else endpoint(request, response)
                }),
              )
              yield* Effect.addFinalizer(() => Effect.sync(release))
              const stale = restateExecutionActivationRequest(
                { ...replacementConfig, ...(yield* loadAttempt(randomUUID())) },
                token,
              )
              const receipt = yield* sendRestateInvocation(url, stale.body, {
                timeoutMs: 5_000,
                headers: stale.headers,
              })
              yield* Effect.promise(() => requestSeen).pipe(Effect.timeout('5 seconds'))
              delayedActivation = { invocationId: receipt.invocationId, release }
            } else {
              if (delayedActivation === undefined) throw new Error('Missing pinned predecessor coordinator')
              delayedActivation.release()
              const staleFailure = yield* Effect.flip(
                awaitRestateInvocation(ingress, delayedActivation.invocationId, {
                  maximumAttempts: 200,
                  pollIntervalMs: 100,
                  requestTimeoutMs: 5_000,
                }),
              )
              expect(staleFailure).toMatchObject({
                operation: 'await',
                cause: { message: 'Restate invocation output returned HTTP 400' },
              })
              expect(allProjections.map((changes) => changes.length)).toEqual([2, 2])
            }
          }
          const allSequences = [
            ...advanced,
            ...allReplacementAdvances.flatMap((commands) => commands.map((command) => command.sequence)),
          ]
          expect(new Set(allSequences).size).toBe(allSequences.length)
        }),
      ),
    )
  }, 120_000)
})
