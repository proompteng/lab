import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Clock, Config, ConfigProvider, Effect, Option, Result, Schedule } from 'effect'

import { decodeExecutionControllerState, executionControllerMaximumRecoveryWindow } from '../execution/controller'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { acquireRestateHttp2Server } from './restate-http2-server'
import { makeBaynBrokerObservations } from './restate-broker-observations'
import {
  restateExecutionActivationRequest,
  restateExecutionActivationTransportConfig,
} from './restate-execution-activate'
import {
  executionActivationAuthorizationHash,
  executionControllerAdvanceMaximumAttempts,
  executionControllerRecoveryTickDelayMs,
  makeBaynExecutionController,
} from './restate-execution-controller'
import { awaitRestateInvocation, RestateSendStatus, sendRestateInvocation } from './restate-invocation-client'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_ADMIN_URL'))).pipe(Option.getOrUndefined)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const describeRestate = admin === undefined || ingress === undefined ? describe.skip : describe

describeRestate('Real Restate execution deployment activation', () => {
  test('one durable activation recovers after dependency failure while restarted waiters reuse its coordinator', async () => {
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
    const brokerPollAttempts: Array<{
      readonly startedAtMs: number
      readonly nextPollNotBeforeMs: number
      readonly outcome: 'Failed' | 'QuotaWait' | 'Published'
    }> = []
    let controllerActivations = 0
    let warmupGate: Promise<void> | undefined
    let warmupEntered = () => {}
    const advanced: number[] = []
    const initialAdvanceAttempts: Array<{ readonly sequence: number; readonly issuedAt: string }> = []
    const controller = makeBaynExecutionController(config, {
      advance: async (command) => {
        if (initialAdvanceAttempts.length < 2) {
          initialAdvanceAttempts.push(command)
          if (initialAdvanceAttempts.length === 1) throw new Error('Injected first advance failure')
        }
        advanced.push(command.sequence)
        return {
          completedAt: command.issuedAt,
          observation: { result: 'SUCCESS', observedAt: command.issuedAt, outcome: 'WINDOW_CLOSED' },
          outcome: { _tag: ExecutionControllerOutcome.Waiting, receiptHash: 'd'.repeat(64), nextDelayMs: 500 },
        }
      },
      prepareActivation: async () => {
        warmupEntered()
        await warmupGate
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
          if (failedPollNotBeforeMs > now) {
            brokerPollAttempts.push({
              startedAtMs: now,
              nextPollNotBeforeMs: failedPollNotBeforeMs,
              outcome: 'QuotaWait',
            })
            return {
              poll: { _tag: 'QuotaWait', nextPollNotBeforeMs: failedPollNotBeforeMs },
              startedAtMs: now,
              completedAtMs: now,
            }
          }
          brokerPolls += 1
          if (!brokerReady) {
            failedPollNotBeforeMs = now + 5_000
            brokerPollAttempts.push({
              startedAtMs: now,
              nextPollNotBeforeMs: failedPollNotBeforeMs,
              outcome: 'Failed',
            })
            throw new Error('Broker observation dependency is temporarily unavailable')
          }
          brokerPollAttempts.push({
            startedAtMs: now,
            nextPollNotBeforeMs: failedPollNotBeforeMs,
            outcome: 'Published',
          })
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
    const activationJobUid = randomUUID()
    const deployment = {
      ...config,
      ...(await Effect.runPromise(loadAttempt(activationJobUid))),
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
          for (const method of ['activate', 'rotate', 'tick', 'deactivate', 'prepareActivation', 'status']) {
            const denied = yield* invoke(config.controllerKey, method, `Bearer ${token}`)
            expect(denied.status).toBe(400)
            expect(yield* Effect.promise(() => denied.text())).toContain('the invoked service is not public')
          }
          const url = `${ingress}${firstRequest.path}`
          const options = { timeoutMs: 5_000, headers: firstRequest.headers }
          const accepted = yield* sendRestateInvocation(url, body, options)
          const waiting = yield* Effect.flip(
            awaitRestateInvocation(ingress, accepted.invocationId, {
              maximumAttempts: 100,
              pollIntervalMs: 100,
              requestTimeoutMs: 5_000,
            }),
          )
          expect(waiting.message).toBe('Restate invocation remains incomplete after the bounded completion check')
          expect(controllerActivations).toBe(0)
          expect(brokerPollAttempts.some((attempt) => attempt.outcome === 'Failed')).toBe(true)
          expect(brokerPollAttempts.some((attempt) => attempt.outcome === 'QuotaWait')).toBe(true)
          brokerReady = true
          for (let restart = 0; restart < 2; restart += 1) {
            const restarted = restateExecutionActivationRequest(
              { ...config, ...(yield* loadAttempt(activationJobUid)) },
              token,
            )
            const resumed = yield* sendRestateInvocation(url, restarted.body, {
              ...options,
              headers: restarted.headers,
            })
            expect(resumed.invocationId).toBe(accepted.invocationId)
            expect(resumed.status).toBe(RestateSendStatus.PreviouslyAccepted)
          }
          // The waiter can reconnect after the retained deadline. Prove quota from actual
          // poll boundaries below, not from time remaining when the test resumes.
          const quotaWaitMs = Math.max(0, failedPollNotBeforeMs - (yield* Clock.currentTimeMillis))
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
          expect(initialAdvanceAttempts).toHaveLength(2)
          expect(initialAdvanceAttempts[1]).toEqual(initialAdvanceAttempts[0])
          expect(brokerPolls).toBeGreaterThanOrEqual(1)
          expect(brokerActivations).toBe(1)
          expect(controllerActivations).toBe(1)
          expect(brokerPollAttempts.some((attempt) => attempt.outcome === 'Published')).toBe(true)
          for (const [index, attempt] of brokerPollAttempts.entries()) {
            if (attempt.outcome === 'QuotaWait') {
              expect(attempt.startedAtMs).toBeLessThan(attempt.nextPollNotBeforeMs)
              expect(brokerPollAttempts[index + 1]?.startedAtMs).toBeGreaterThanOrEqual(attempt.nextPollNotBeforeMs)
            } else if (attempt.outcome === 'Published') {
              expect(attempt.startedAtMs).toBeGreaterThanOrEqual(attempt.nextPollNotBeforeMs)
            }
          }
          const journal = yield* Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(`${admin}/query`, {
                method: 'POST',
                body: JSON.stringify({
                  query: `SELECT COUNT(*) AS journal_entries,
                    (SELECT MIN(journal_size) FROM sys_invocation
                      WHERE target_service_name = 'BaynExecutionController'
                        AND target_service_key = '${config.controllerKey}' AND target_handler_name = 'tick'
                        AND status = 'completed' AND id IN (
                          SELECT id FROM sys_journal WHERE entry_type = 'Command: SetState')) AS minimum_tick_entries,
                    (SELECT MAX(journal_size) FROM sys_invocation
                      WHERE target_service_name = 'BaynExecutionController'
                        AND target_service_key = '${config.controllerKey}' AND target_handler_name = 'tick'
                        AND status = 'completed' AND id IN (
                          SELECT id FROM sys_journal WHERE entry_type = 'Command: SetState')) AS maximum_tick_entries,
                    (SELECT COUNT(*) FROM sys_journal WHERE entry_type = 'Command: GetLazyState'
                      AND id IN (SELECT id FROM sys_invocation
                        WHERE target_service_name = 'BaynExecutionController'
                          AND target_service_key = '${config.controllerKey}' AND target_handler_name = 'tick')) AS lazy_tick_state_reads
                    FROM sys_journal WHERE id = '${accepted.invocationId}'`,
                }),
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                signal,
              })
              if (!response.ok) throw new Error(`Local Restate journal query failed with HTTP ${response.status}`)
              return response.json() as Promise<unknown>
            },
            catch: (cause) => cause,
          })
          expect(journal).toMatchObject({
            rows: [{ journal_entries: 0, lazy_tick_state_reads: 0, minimum_tick_entries: 8, maximum_tick_entries: 8 }],
          })
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

          let releaseWarmup = () => {}
          warmupGate = new Promise<void>((resolve) => {
            releaseWarmup = resolve
          })
          const warmingEntered = new Promise<void>((resolve) => {
            warmupEntered = resolve
          })
          yield* Effect.addFinalizer(() => Effect.sync(releaseWarmup))
          const warmingRequest = restateExecutionActivationRequest(
            { ...config, ...(yield* loadAttempt(randomUUID())) },
            token,
          )
          const warmingReceipt = yield* sendRestateInvocation(url, warmingRequest.body, {
            timeoutMs: 5000,
            headers: warmingRequest.headers,
          })
          yield* Effect.promise(() => warmingEntered)
          const beforeWarm = advanced.length
          yield* Effect.sleep(1200)
          expect(advanced.length).toBeGreaterThan(beforeWarm)
          expect(controllerActivations).toBe(1)
          expect(brokerActivations).toBe(1)
          releaseWarmup()
          yield* awaitRestateInvocation(ingress, warmingReceipt.invocationId, {
            maximumAttempts: 100,
            pollIntervalMs: 100,
            requestTimeoutMs: 5000,
          })
          warmupGate = undefined

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
              prepareActivation: () => Promise.resolve(),
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
            expect(projected).toHaveLength(1)
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
              expect(allProjections).toEqual([
                [expect.objectContaining({ active: true, epoch: 2, sourceRevision: 'f'.repeat(40) })],
                [expect.objectContaining({ active: true, epoch: 3, sourceRevision: 'e'.repeat(40) })],
              ])
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

  test('a saturated recovery window retains one durable successor and its original issuedAt', async () => {
    if (admin === undefined || ingress === undefined) throw new Error('Missing local Restate URLs')
    for (const target of [admin, ingress]) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname))
        throw new Error('Restate integration targets must be local')
    }
    const config = {
      controllerKey: randomUUID().replaceAll('-', '').repeat(2),
      planHash: 'b'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      operationTimeoutMs: 5_000,
      activationAuthorizationHash: Result.getOrThrow(
        executionActivationAuthorizationHash(Buffer.alloc(32, 8).toString('base64url')),
      ),
    }
    const activation = {
      schemaVersion: 'bayn.execution-controller-activation.v1',
      controllerKey: config.controllerKey,
      epoch: 1,
      firstSequence: 0,
      planHash: config.planHash,
      sourceRevision: config.sourceRevision,
    }
    const deactivation = {
      schemaVersion: 'bayn.execution-controller-deactivation.v1',
      controllerKey: config.controllerKey,
      epoch: activation.epoch,
      planHash: config.planHash,
      sourceRevision: config.sourceRevision,
    }
    let dependencyReady = true
    const attempts: Array<{
      readonly epoch: number
      readonly sequence: number
      readonly issuedAt: string
      readonly startedAtMs: number
      readonly succeeded: boolean
    }> = []
    const recoveryWindows: Array<Readonly<Record<string, string | number | boolean>>> = []
    const controller = makeBaynExecutionController(config, {
      advance: async (command) => {
        const startedAtMs = Clock.Clock.defaultValue().currentTimeMillisUnsafe()
        attempts.push({ ...command, startedAtMs, succeeded: dependencyReady })
        if (!dependencyReady) throw new Error('Injected saturated-window dependency failure')
        // Completion time stays live while issuedAt remains the original command's receipt provenance.
        // The ordinary 60-second successor cannot satisfy the earlier 30-second recovery assertion.
        const completedAt = new Date(startedAtMs).toISOString()
        return {
          completedAt,
          outcome: { _tag: ExecutionControllerOutcome.Waiting, receiptHash: 'd'.repeat(64), nextDelayMs: 60_000 },
        }
      },
      prepareActivation: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
      log: async (_level, message, annotations) => {
        if (message === 'Bayn execution controller scheduled a recovery window') recoveryWindows.push(annotations)
      },
    })
    // This public bridge exists only in the local fixture. All state changes still pass through the real
    // controller's private, validated handlers; the test never writes Restate object state directly.
    const bridge = restate.service({
      name: 'ExecutionRecoveryTestBridge',
      handlers: {
        activate: (ctx: restate.Context) => ctx.objectClient(controller, config.controllerKey).activate(activation),
        status: (ctx: restate.Context) => ctx.objectClient(controller, config.controllerKey).status(undefined),
        tick: async (ctx: restate.Context, candidate: unknown) => {
          const client = ctx.objectClient(controller, config.controllerKey)
          await client.tick(candidate)
          return client.status(undefined)
        },
        deactivate: (ctx: restate.Context) =>
          ctx.objectClient(controller, config.controllerKey).deactivate(deactivation),
      },
    })
    const json = (url: string, body: unknown) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(url, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
          })
          if (!response.ok) throw new Error(`Local Restate returned ${response.status}: ${await response.text()}`)
          return response.json() as Promise<unknown>
        },
        catch: (cause) => cause,
      })
    const invoke = (method: string, body: unknown = {}) =>
      json(`${ingress}/ExecutionRecoveryTestBridge/${method}`, body)
    const stateAtSequence = (sequence: number, maximumAttempts: number) =>
      invoke('status').pipe(
        Effect.map((value) => Result.getOrThrow(decodeExecutionControllerState(value))),
        Effect.flatMap((state) =>
          state.nextSequence === sequence ? Effect.succeed(state) : Effect.fail('controller has not advanced'),
        ),
        Effect.retry({ schedule: Schedule.spaced('100 millis'), times: maximumAttempts }),
      )
    const completionOptions = { maximumAttempts: 100, pollIntervalMs: 100, requestTimeoutMs: 5_000 }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = createServer(restate.createEndpointHandler({ services: [controller, bridge] }))
          yield* acquireRestateHttp2Server(server, 0)
          const address = server.address()
          if (address === null || typeof address === 'string') throw new Error('Missing local endpoint address')
          yield* json(`${admin}/deployments`, { uri: `http://host.docker.internal:${address.port}` })
          yield* invoke('activate')
          // Deactivate before closing the endpoint even if an assertion fails while a delayed tick is pending.
          yield* Effect.addFinalizer(() => invoke('deactivate').pipe(Effect.ignore))
          const initial = yield* stateAtSequence(1, 100)
          expect(initial).toMatchObject({ active: true, epoch: 1, lastCompletion: { sequence: 0 }, nextSequence: 1 })
          expect(attempts).toHaveLength(1)

          const issuedAt = new Date((yield* Clock.currentTimeMillis) - 1_000).toISOString()
          const tick = {
            schemaVersion: 'bayn.execution-controller-tick.v1',
            epoch: initial.epoch,
            sequence: initial.nextSequence,
            attempt: executionControllerAdvanceMaximumAttempts(false) - 1,
            issuedAt,
            recoveryWindow: executionControllerMaximumRecoveryWindow,
            retryWindowHash: 'e'.repeat(64),
          }
          const url = `${ingress}/restate/send/ExecutionRecoveryTestBridge/tick`
          const options = { timeoutMs: 5_000, headers: { 'idempotency-key': randomUUID() } }
          dependencyReady = false
          const receipt = yield* sendRestateInvocation(url, tick, options)
          const pending = yield* awaitRestateInvocation(ingress, receipt.invocationId, completionOptions)
          expect(pending).toEqual(initial)
          expect(attempts).toHaveLength(2)
          expect(attempts[1]).toMatchObject({ epoch: tick.epoch, sequence: tick.sequence, issuedAt, succeeded: false })
          expect(recoveryWindows).toEqual([
            expect.objectContaining({
              recoveryWindow: executionControllerMaximumRecoveryWindow,
              recoveryDelayMs: executionControllerRecoveryTickDelayMs,
              sequence: tick.sequence,
            }),
          ])

          const replay = yield* sendRestateInvocation(url, tick, options)
          expect(replay.invocationId).toBe(receipt.invocationId)
          expect(replay.status).toBe(RestateSendStatus.PreviouslyAccepted)
          expect(yield* awaitRestateInvocation(ingress, replay.invocationId, completionOptions)).toEqual(pending)
          expect(attempts).toHaveLength(2)
          expect(recoveryWindows).toHaveLength(1)

          dependencyReady = true
          const recovered = yield* stateAtSequence(2, 450)
          expect(recovered).toMatchObject({
            active: true,
            epoch: tick.epoch,
            nextSequence: tick.sequence + 1,
            lastCompletion: { sequence: tick.sequence, receiptHash: 'd'.repeat(64) },
          })
          expect(attempts).toHaveLength(3)
          expect(attempts[2]).toMatchObject({ epoch: tick.epoch, sequence: tick.sequence, issuedAt, succeeded: true })
          expect(attempts[2]!.startedAtMs - attempts[1]!.startedAtMs).toBeGreaterThanOrEqual(
            executionControllerRecoveryTickDelayMs,
          )
          expect(attempts.filter((attempt) => attempt.succeeded).map((attempt) => attempt.sequence)).toEqual([0, 1])
          expect(recoveryWindows).toHaveLength(1)

          // A retained replay returns its original response; a fresh stale delivery reads the advanced sequence.
          const completedReplay = yield* sendRestateInvocation(url, tick, options)
          expect(completedReplay.invocationId).toBe(receipt.invocationId)
          expect(yield* awaitRestateInvocation(ingress, completedReplay.invocationId, completionOptions)).toEqual(
            pending,
          )
          expect(yield* invoke('tick', tick)).toEqual(recovered)
          expect(attempts).toHaveLength(3)
          const inactive = yield* invoke('deactivate')
          expect(inactive).toMatchObject({ active: false, epoch: tick.epoch + 1, nextSequence: tick.sequence + 1 })
          expect(yield* invoke('tick', { ...tick, sequence: tick.sequence + 1, attempt: 0 })).toEqual(inactive)
          expect(attempts).toHaveLength(3)
        }),
      ),
    )
  }, 75_000)
})
