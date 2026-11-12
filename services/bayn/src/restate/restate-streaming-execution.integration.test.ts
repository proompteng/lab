import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Config, Effect, Fiber, Option, Redacted, Result, Schedule, Schema } from 'effect'

import { decodeExecutionControllerState } from '../execution/controller'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { sha256 } from '../hash'
import { MarketChangeReason, marketChangedEventId, type MarketChangedWakeup } from '../execution/events'
import { makeMarketHints } from '../market-data/streaming/readiness'
import { makeBaynEntryInference } from './restate-entry-inference'
import { acquireRestateHttp2Server } from './restate-http2-server'
import { brokerObservationJsonSerde } from './restate-broker-observations'
import { executionActivationAuthorizationHash, makeBaynExecutionController } from './restate-execution-controller'
import { publishMarketChange } from './restate-execution-server'

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

const localRestateTargets = () => {
  if (admin === undefined || ingress === undefined) throw new Error('Missing local Restate URLs')
  for (const target of [admin, ingress])
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname))
      throw new Error('Restate integration targets must be local')
  return { admin, ingress }
}

const register = (services: Parameters<typeof restate.createEndpointHandler>[0]['services']) =>
  Effect.gen(function* () {
    const targets = localRestateTargets()
    const server = createServer(restate.createEndpointHandler({ services }))
    yield* acquireRestateHttp2Server(server, 0)
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing local endpoint address')
    yield* json(`${targets.admin}/deployments`, { uri: `http://host.docker.internal:${address.port}`, force: true })
  })

const queueFixture = () => {
  const targets = localRestateTargets()
  const controllerKey = sha256(randomUUID())
  const token = Buffer.alloc(32, 7).toString('base64url')
  const config = {
    controllerKey,
    planHash: 'b'.repeat(64),
    sourceRevision: 'c'.repeat(40),
    operationTimeoutMs: 5_000,
    activationAuthorizationHash: Result.getOrThrow(executionActivationAuthorizationHash(token)),
  }
  let releaseInitial: () => void = () => undefined
  let releaseProtection: () => void = () => undefined
  const initialGate = new Promise<void>((resolve) => {
    releaseInitial = resolve
  })
  const protectionGate = new Promise<void>((resolve) => {
    releaseProtection = resolve
  })
  let version = 0
  const snapshots: Array<{ sequence: number; version: number }> = []
  const brokerSnapshotHash = sha256(`${controllerKey}:broker-sentinel`)
  const brokerSentinelKey = `market-queue-broker-${controllerKey}`
  const protectionSentinelKey = `market-queue-protection-${controllerKey}`
  const controller = alwaysReplay(
    makeBaynExecutionController(config, {
      prepareActivation: async () => undefined,
      projectState: async () => undefined,
      log: async () => undefined,
      advance: async (command) => {
        // This is the owner's source read. Hint metadata never supplies the observed version.
        snapshots.push({ sequence: command.sequence, version })
        if (command.sequence === 0) await initialGate
        if (command.sequence === 1) await protectionGate
        return {
          completedAt: new Date().toISOString(),
          outcome: {
            _tag: ExecutionControllerOutcome.Waiting,
            receiptHash: sha256(`${controllerKey}:${command.sequence}`),
            nextDelayMs: 1,
          },
        }
      },
    }),
  )
  const call = (ctx: restate.Context, method: string, parameter: unknown, idempotencyKey?: string) =>
    ctx.genericCall({
      service: 'BaynExecutionController',
      method,
      key: controllerKey,
      parameter,
      inputSerde: brokerObservationJsonSerde,
      outputSerde: brokerObservationJsonSerde,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    })
  const bridge = alwaysReplay(
    restate.service({
      name: 'MarketCompletionTestBridge',
      handlers: {
        start: (ctx: restate.Context) =>
          call(ctx, 'activate', {
            schemaVersion: 'bayn.execution-controller-activation.v1',
            controllerKey,
            epoch: 1,
            firstSequence: 0,
            planHash: config.planHash,
            sourceRevision: config.sourceRevision,
          }),
        status: (ctx: restate.Context) => call(ctx, 'status', {}),
        broker: (ctx: restate.Context) =>
          call(
            ctx,
            'wake',
            {
              schemaVersion: 'bayn.execution-wakeup.v1',
              _tag: 'BrokerObservation',
              sourceRevision: config.sourceRevision,
              eventId: brokerSnapshotHash,
              snapshotHash: brokerSnapshotHash,
              observedAt: '2026-11-11T18:00:00.000Z',
            },
            brokerSentinelKey,
          ),
        protection: (ctx: restate.Context) =>
          call(
            ctx,
            'tick',
            {
              schemaVersion: 'bayn.execution-controller-tick.v1',
              epoch: 1,
              sequence: 1,
            },
            protectionSentinelKey,
          ),
      },
    }),
  )
  const invoke = (method: string) => json(`${targets.ingress}/MarketCompletionTestBridge/${method}`, {})
  const count = (where: string) =>
    json(
      `${targets.admin}/query`,
      {
        query: `SELECT COUNT(*) AS total FROM sys_invocation WHERE target LIKE 'BaynExecutionController/${controllerKey}/%' AND (${where})`,
      },
      { accept: 'application/json' },
    ).pipe(
      Effect.map((candidate) => {
        const [row] = Schema.decodeUnknownSync(
          Schema.Struct({ rows: Schema.Array(Schema.Struct({ total: Schema.Number })) }),
        )(candidate).rows
        if (row === undefined) throw new Error('Missing Restate inventory count')
        return row.total
      }),
    )
  const pendingMarket = count(
    "target LIKE '%/wake' AND idempotency_key LIKE 'bayn-market-change-%' AND status != 'completed'",
  )
  return {
    config,
    controller,
    bridge,
    snapshots,
    brokerSnapshotHash,
    brokerSentinelKey,
    protectionSentinelKey,
    changed: () => {
      version += 1
    },
    releaseInitial,
    releaseProtection,
    release: () => {
      releaseInitial()
      releaseProtection()
    },
    invoke,
    count,
    pendingMarket,
    status: invoke('status').pipe(
      Effect.map((candidate) => Result.getOrThrow(decodeExecutionControllerState(candidate))),
    ),
    publish: (event: MarketChangedWakeup) => publishMarketChange(targets.ingress, config, event, Redacted.make(token)),
  }
}

describeRestate('Real always-replay streaming execution', () => {
  test('successful event turns replace one original deadline while failed probes retain its owner', async () => {
    const targets = localRestateTargets()
    const controllerKey = sha256(randomUUID())
    const token = Buffer.alloc(32, 7).toString('base64url')
    const config = {
      controllerKey,
      planHash: 'b'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      operationTimeoutMs: 5_000,
      activationAuthorizationHash: Result.getOrThrow(executionActivationAuthorizationHash(token)),
    }
    const activation = {
      schemaVersion: 'bayn.execution-controller-activation.v1',
      controllerKey,
      epoch: 1,
      firstSequence: 0,
      planHash: config.planHash,
      sourceRevision: config.sourceRevision,
    }
    const deadlineMs = Date.now() + 35_000
    const deadline = new Date(deadlineMs).toISOString()
    let failuresLeft = 0
    let failedAttempts = 0
    const passes: Array<{ readonly sequence: number; readonly at: number }> = []
    const runtime = {
      prepareActivation: async () => undefined,
      projectState: async () => undefined,
      log: async () => undefined,
      advance: async (command: { readonly sequence: number }) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1
          failedAttempts += 1
          throw new Error('Controlled advance failure before completion')
        }
        const at = Date.now()
        passes.push({ sequence: command.sequence, at })
        return {
          completedAt: new Date(at).toISOString(),
          outcome: {
            _tag: ExecutionControllerOutcome.Waiting,
            receiptHash: sha256(`${controllerKey}:${command.sequence}`),
            nextDelayMs: 1,
            ...(at < deadlineMs ? { nextWakeAt: deadline } : {}),
          },
        }
      },
    }
    const controller = () => alwaysReplay(makeBaynExecutionController(config, runtime))
    const bridge = alwaysReplay(
      restate.service({
        name: 'DeadlineReplacementTestBridge',
        handlers: {
          activate: (ctx: restate.Context) =>
            ctx.genericCall({
              service: 'BaynExecutionController',
              method: 'activate',
              key: controllerKey,
              parameter: activation,
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
        },
      }),
    )
    const invoke = (method: string) => json(`${targets.ingress}/DeadlineReplacementTestBridge/${method}`, {})
    const status = invoke('status').pipe(
      Effect.map((value) => Result.getOrThrow(decodeExecutionControllerState(value))),
    )
    const inventory = (condition: string) =>
      json(
        `${targets.admin}/query`,
        {
          query: `SELECT COUNT(*) AS total FROM sys_invocation WHERE target = 'BaynExecutionController/${controllerKey}/tick' AND (${condition})`,
        },
        { accept: 'application/json' },
      ).pipe(
        Effect.map((value) => {
          const [row] = Schema.decodeUnknownSync(
            Schema.Struct({ rows: Schema.Array(Schema.Struct({ total: Schema.Number })) }),
          )(value).rows
          if (row === undefined) throw new Error('Missing deadline inventory')
          return row.total
        }),
      )
    const scheduled = inventory("status = 'scheduled'")
    const busy = inventory("status NOT IN ('completed', 'scheduled')")
    const producerId = randomUUID()
    const event = (sequence: number): MarketChangedWakeup => ({
      schemaVersion: 'bayn.execution-wakeup.v1',
      _tag: 'MarketChanged',
      sourceRevision: config.sourceRevision,
      producerId,
      sequence,
      reason: MarketChangeReason.Data,
      eventId: marketChangedEventId(producerId, sequence),
    })
    const publish = (sequence: number) =>
      publishMarketChange(targets.ingress, config, event(sequence), Redacted.make(token))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register([controller(), bridge])
          yield* invoke('activate')
          yield* waitFor(() => status.pipe(Effect.map((value) => value.nextSequence === 1)))
          for (let sequence = 1; sequence <= 25; sequence++) {
            if (sequence === 13) yield* register([controller(), bridge])
            yield* publish(sequence)
            yield* waitFor(() => status.pipe(Effect.map((value) => value.nextSequence === sequence + 1)))
          }
          yield* waitFor(() => busy.pipe(Effect.map((value) => value === 0)))
          expect(Date.now()).toBeLessThan(deadlineMs)
          expect(yield* scheduled).toBe(1)
          expect((yield* status).nextDueAt).toBe(deadline)
          expect(passes).toHaveLength(26)
          // A lost public acknowledgement must reuse the private event and preserve the one existing deadline.
          yield* publish(25)
          expect(passes).toHaveLength(26)
          expect(yield* scheduled).toBe(1)

          // An accelerated ordinary failure transfers to its retry; success retires the previous deadline.
          failuresLeft = 1
          yield* publish(26)
          yield* waitFor(() => status.pipe(Effect.map((value) => value.nextSequence === 27)))
          yield* waitFor(() => busy.pipe(Effect.map((value) => value === 0)))
          expect(failedAttempts).toBe(1)
          expect(yield* scheduled).toBe(1)
          expect((yield* status).nextDueAt).toBe(deadline)

          // Explicit catch-up probes deliberately stop after exhaustion. They must not cancel the established owner.
          failuresLeft = 3
          yield* invoke('activate')
          yield* waitFor(() => Effect.sync(() => failedAttempts === 4))
          yield* waitFor(() => busy.pipe(Effect.map((value) => value === 0)))
          expect(yield* scheduled).toBe(1)
          expect((yield* status).nextSequence).toBe(27)
          expect((yield* status).nextDueAt).toBe(deadline)

          // No further hints arrive: the original deadline, not a renewed window, must still execute.
          yield* Effect.sleep(Math.max(0, deadlineMs - Date.now()))
          yield* waitFor(() => status.pipe(Effect.map((value) => value.nextDueAt === undefined)))
          expect(passes).toHaveLength(28)
          expect(passes.at(-1)?.sequence).toBe(27)
          expect(passes.at(-1)?.at).toBeGreaterThanOrEqual(deadlineMs)
          yield* waitFor(() => busy.pipe(Effect.map((value) => value === 0)))
          expect(yield* scheduled).toBe(0)
        }),
      ),
    )
  }, 50_000)

  test('source handover retries the same immutable hint and a repeated acknowledgement joins its original private wake', async () => {
    const fixture = queueFixture()
    const producerId = randomUUID()
    const event = {
      schemaVersion: 'bayn.execution-wakeup.v1' as const,
      _tag: 'MarketChanged' as const,
      sourceRevision: fixture.config.sourceRevision,
      producerId,
      sequence: 1,
      reason: MarketChangeReason.Recovery,
      eventId: marketChangedEventId(producerId, 1),
    }
    const retained = fixture.publish(event)
    const predecessor = alwaysReplay(
      makeBaynExecutionController(
        { ...fixture.config, sourceRevision: 'd'.repeat(40) },
        {
          prepareActivation: async () => undefined,
          projectState: async () => undefined,
          log: async () => undefined,
          advance: async () => {
            throw new Error('a rejected source cannot enter financial work')
          },
        },
      ),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register([predecessor])
          expect(yield* Effect.result(retained)).toMatchObject({
            _tag: 'Failure',
            failure: { message: 'market change registration returned HTTP 412' },
          })
          yield* register([fixture.controller, fixture.bridge])
          yield* retained.pipe(Effect.retry({ schedule: Schedule.spaced('50 millis'), times: 20 }))
          // A successful response may have been lost. The fresh public retry joins the completed private identity.
          yield* retained
          expect(yield* fixture.count(`idempotency_key = 'bayn-market-change-${event.eventId}'`)).toBe(1)
          expect(fixture.snapshots).toEqual([])
        }),
      ).pipe(Effect.ensuring(Effect.sync(fixture.release))),
    )
  }, 30_000)

  test.each([1, 3])(
    '%s active producers conflate bursts behind the owner while broker and protection work retain progress',
    async (producerCount) => {
      const fixture = queueFixture()
      const sent: MarketChangedWakeup[] = []
      const acknowledged = new Set<string>()
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* register([fixture.controller, fixture.bridge])
            expect(yield* json(`${localRestateTargets().admin}/services/BaynExecutionController`)).toMatchObject({
              inactivity_timeout: '0s',
            })
            yield* fixture.invoke('start')
            yield* waitFor(() => Effect.sync(() => fixture.snapshots.length === 1))
            const producers: Array<{
              readonly producerId: string
              readonly hints: Effect.Success<ReturnType<typeof makeMarketHints>>
            }> = []
            for (let index = 0; index < producerCount; index++) {
              const producerId = randomUUID()
              const hints = yield* makeMarketHints(fixture.config.sourceRevision, producerId)
              yield* hints
                .serve((event) =>
                  Effect.gen(function* () {
                    sent.push(event)
                    yield* fixture.publish(event)
                    acknowledged.add(event.eventId)
                  }),
                )
                .pipe(Effect.forkScoped)
              producers.push({ producerId, hints })
              yield* hints.changed(MarketChangeReason.Startup)
            }
            yield* waitFor(() => fixture.pendingMarket.pipe(Effect.map((count) => count === producerCount)))
            for (const { hints } of producers)
              for (let index = 0; index < 1_000; index++) {
                fixture.changed()
                yield* hints.changed(MarketChangeReason.Data)
              }
            expect(fixture.snapshots).toEqual([{ sequence: 0, version: 0 }])
            expect(acknowledged.size).toBe(0)
            expect(new Set(sent.map((event) => event.eventId)).size).toBe(producerCount)
            expect(yield* fixture.pendingMarket).toBe(producerCount)
            const broker = yield* fixture.invoke('broker').pipe(Effect.forkScoped)
            yield* waitFor(() =>
              fixture
                .count(`idempotency_key = '${fixture.brokerSentinelKey}'`)
                .pipe(Effect.map((count) => count === 1)),
            )
            const protection = yield* fixture.invoke('protection').pipe(Effect.forkScoped)
            yield* waitFor(() =>
              fixture
                .count(`idempotency_key IN ('${fixture.brokerSentinelKey}', '${fixture.protectionSentinelKey}')`)
                .pipe(Effect.map((count) => count === 2)),
            )
            // The sentinels have at most one distinct market wake per active producer ahead of them, not the burst size.
            expect(yield* fixture.pendingMarket).toBe(producerCount)
            fixture.releaseInitial()
            yield* Fiber.join(broker)
            yield* waitFor(() => Effect.sync(() => fixture.snapshots.some((snapshot) => snapshot.sequence === 1)))
            expect(fixture.snapshots.find((snapshot) => snapshot.sequence === 1)?.version).toBe(producerCount * 1_000)
            expect((yield* fixture.status).lastBrokerSnapshotHash).toBe(fixture.brokerSnapshotHash)
            yield* waitFor(() =>
              Effect.sync(() =>
                producers.every(({ producerId }) =>
                  sent.some((event) => event.producerId === producerId && event.sequence === 1_001),
                ),
              ),
            )
            yield* waitFor(() => fixture.pendingMarket.pipe(Effect.map((count) => count === producerCount)))
            expect(acknowledged.size).toBe(producerCount)
            const first = producers[0]
            if (first === undefined) throw new Error('Missing active producer')
            // This change occurs after the owner's source read. No later Kafka input is supplied to rescue it.
            fixture.changed()
            yield* first.hints.changed(MarketChangeReason.Data)
            expect(yield* fixture.pendingMarket).toBe(producerCount)
            fixture.releaseProtection()
            yield* Fiber.join(protection)
            yield* waitFor(() =>
              Effect.sync(() =>
                fixture.snapshots.some(
                  (snapshot) => snapshot.sequence > 1 && snapshot.version === producerCount * 1_000 + 1,
                ),
              ),
            )
            yield* waitFor(() =>
              Effect.sync(
                () =>
                  acknowledged.has(marketChangedEventId(first.producerId, 1_002)) &&
                  producers
                    .slice(1)
                    .every(({ producerId }) => acknowledged.has(marketChangedEventId(producerId, 1_001))),
              ),
            )
            yield* waitFor(() => fixture.pendingMarket.pipe(Effect.map((count) => count === 0)))
            expect(yield* fixture.count("idempotency_key LIKE 'bayn-market-change-%'")).toBe(producerCount * 2 + 1)
            expect(new Set(fixture.snapshots.map((snapshot) => snapshot.sequence)).size).toBe(fixture.snapshots.length)
            expect((yield* fixture.status).nextDueAt).toBeUndefined()
          }),
        ).pipe(Effect.ensuring(Effect.sync(fixture.release))),
      )
    },
    30_000,
  )

  test('abandoned publisher incarnations retain their queued wakes beyond the active-producer bound', async () => {
    const fixture = queueFixture()
    const abandoned = 3
    const acknowledged = new Set<string>()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register([fixture.controller, fixture.bridge])
          yield* fixture.invoke('start')
          yield* waitFor(() => Effect.sync(() => fixture.snapshots.length === 1))
          for (let incarnation = 0; incarnation < abandoned; incarnation++) {
            const hints = yield* makeMarketHints(fixture.config.sourceRevision, randomUUID())
            const publisher = yield* hints.serve(fixture.publish).pipe(Effect.forkScoped)
            yield* hints.changed(MarketChangeReason.Startup)
            yield* waitFor(() => fixture.pendingMarket.pipe(Effect.map((count) => count === incarnation + 1)))
            yield* Fiber.interrupt(publisher)
          }
          expect(yield* fixture.pendingMarket).toBe(abandoned)
          const producerId = randomUUID()
          const active = yield* makeMarketHints(fixture.config.sourceRevision, producerId)
          yield* active
            .serve((event) =>
              fixture.publish(event).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    acknowledged.add(event.eventId)
                  }),
                ),
              ),
            )
            .pipe(Effect.forkScoped)
          yield* active.changed(MarketChangeReason.Startup)
          yield* waitFor(() => fixture.pendingMarket.pipe(Effect.map((count) => count === abandoned + 1)))
          for (let index = 0; index < 1_000; index++) yield* active.changed(MarketChangeReason.Data)
          // Cancelling a sender does not cancel a durable Restate invocation. This is explicitly not a global bound.
          expect(yield* fixture.pendingMarket).toBe(abandoned + 1)
          yield* Effect.logInfo('Bayn market wake incarnation inventory', {
            abandonedIncarnations: abandoned,
            activeProducers: 1,
            outstandingPrivateWakes: abandoned + 1,
          })
          fixture.release()
          yield* waitFor(() => Effect.sync(() => acknowledged.has(marketChangedEventId(producerId, 1_001))))
          yield* waitFor(() => fixture.pendingMarket.pipe(Effect.map((count) => count === 0)))
          expect(yield* fixture.count("idempotency_key LIKE 'bayn-market-change-%'")).toBe(abandoned + 2)
        }),
      ).pipe(Effect.ensuring(Effect.sync(fixture.release))),
    )
  }, 30_000)

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
          const producerId = randomUUID()
          const event = {
            schemaVersion: 'bayn.execution-wakeup.v1',
            _tag: 'MarketChanged',
            sourceRevision: config.sourceRevision,
            eventId: marketChangedEventId(producerId, 1),
            producerId,
            sequence: 1,
            reason: MarketChangeReason.Data,
          }
          const denied = yield* Effect.promise(() =>
            fetch(`${ingress}/BaynExecutionController/${controllerKey}/marketChanged`, {
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
              json(`${ingress}/BaynExecutionController/${controllerKey}/marketChanged`, event, {
                authorization: `Bearer ${token}`,
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
