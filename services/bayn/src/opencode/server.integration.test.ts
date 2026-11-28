import { expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { NodeHttpClient, NodeHttpServer, NodeServices } from '@effect/platform-node'
import { Clock, Deferred, Effect, Exit, FileSystem, Fiber, Layer, Schedule, Stream } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { ChildProcessSpawner } from 'effect/process'

import { observeNativeStartupFailure } from '../../tools/test-native-process-diagnostics'
import { sha256 } from '../hash'
import { inferResearch } from '../research-inference/client'
import { verifyResearchReceipt } from '../research-inference/store'
import { decodeResearchRun, hashResearch, researchRequest, ResearchOutcome } from '../research-inference/contract'
import { editorFixture, streamFixture } from '../research-inference/test-support'
import { makeOpenCodeConfiguration, openCodeModel } from './configuration'
import { serveOpenCode } from './server'

const binary = process.env['BAYN_TEST_OPENCODE_BINARY']
const nativeTest = binary === undefined ? test.skip : test

interface NativeStartupObservation {
  readonly elapsedMs: number
  readonly outcome: 'HTTP' | 'TRANSPORT_ERROR' | 'CLIENT_ERROR'
  readonly status: number | null
}

const startupDiagnostics = (phase: 'initial' | 'restart', startedAtMs: number) => ({
  phase,
  startedAtMs,
  child: undefined as ChildProcessSpawner.ChildProcessHandle | undefined,
  spawnRequestedElapsedMs: null as number | null,
  spawnAcquiredElapsedMs: null as number | null,
  nativeRequests: 0,
  nativeHttpResponses: 0,
  nativeStartingResponses: 0,
  nativeTransportErrors: 0,
  nativeRequestCancellations: 0,
  nativeOtherErrors: 0,
  firstNative: null as NativeStartupObservation | null,
  lastNative: null as NativeStartupObservation | null,
  gatewayAttempts: 0,
  lastGatewayStatus: null as number | null,
})

nativeTest(
  'pinned native harness reuses one study session, refuses replay and releases its process scope',
  async () => {
    if (binary === undefined) throw new Error('Explicit pinned OpenCode binary required')
    const handles: ChildProcessSpawner.ChildProcessHandle[] = []
    let providerCalls = 0
    let nativeSessionCreations = 0
    let firstAuthorization: string | undefined
    const testStartedAtMs = Date.now()
    // HTTP observations stop at response headers, before body consumption or validation.
    const nativeOperations: {
      phase: 'initial' | 'restart'
      operation: string
      elapsedMs: number
      requestSettledElapsedMs: number | null
      outcome: NativeStartupObservation['outcome'] | 'PENDING' | 'CANCELLED'
      status: number | null
    }[] = []
    const observeLifecycle = (phase: string, outcome?: ResearchOutcome) =>
      Effect.logInfo({
        event: 'bayn.opencode-native-lifecycle-test.v1',
        phase,
        elapsedMs: Date.now() - testStartedAtMs,
        providerCalls,
        nativeSessionCreations,
        ...(phase === 'assertions-passed' || phase === 'assertions-failed'
          ? { nativeOperations: nativeOperations.map((operation) => ({ ...operation })) }
          : { lastNativeOperation: nativeOperations.at(-1) }),
        ...(outcome === undefined ? {} : { outcome }),
      })
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-opencode-native-' })
        const locations = { directory, nativePort: 24097, relayPort: 24098 }
        const port = 24096
        const client = yield* HttpClient.HttpClient
        const originalSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const observationScope = yield* Effect.scope
        let startup = startupDiagnostics('initial', yield* Clock.currentTimeMillis)
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const phase = startup
            phase.spawnRequestedElapsedMs = (yield* Clock.currentTimeMillis) - phase.startedAtMs
            const handle = yield* originalSpawner.spawn(command)
            phase.spawnAcquiredElapsedMs = (yield* Clock.currentTimeMillis) - phase.startedAtMs
            phase.child = handle
            handles.push(handle)
            yield* handle.exitCode.pipe(
              Effect.tap(() => observeLifecycle(`${phase.phase}-child-exited`)),
              Effect.tapError(() => observeLifecycle(`${phase.phase}-child-exit-error`)),
              Effect.ignore,
              Effect.forkIn(observationScope),
            )
            return handle
          }),
        )
        const cancelled = yield* Deferred.make<void>()
        const upstream = HttpClient.make((request) =>
          Effect.suspend(() => {
            providerCalls += 1
            if (providerCalls === 3)
              return Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)))
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  Stream.toReadableStream(
                    Stream.concat(
                      Stream.make(
                        new TextEncoder().encode(
                          streamFixture(
                            '{"entry":"Assess the complete net-payoff plan from available evidence."}',
                            openCodeModel,
                          ),
                        ),
                      ),
                      Stream.fromEffect(Effect.sleep('200 millis')).pipe(Stream.drain),
                    ),
                  ),
                  { headers: { 'content-type': 'text/event-stream' } },
                ),
              ),
            )
          }),
        )
        const nativeClient = HttpClient.make((request) =>
          Effect.gen(function* () {
            const phase = startup
            const info = request.url === `http://127.0.0.1:${locations.nativePort}/api/info`
            if (info) {
              phase.nativeRequests += 1
              if (firstAuthorization === undefined) firstAuthorization = request.headers['authorization']
            }
            if (request.method === 'POST' && request.url === `http://127.0.0.1:${locations.nativePort}/api/session`)
              nativeSessionCreations += 1
            const path = new URL(request.url).pathname
            const operation = info
              ? undefined
              : {
                  phase: phase.phase,
                  operation:
                    path === '/api/session'
                      ? 'create-session'
                      : path.endsWith('/message')
                        ? 'read-messages'
                        : path.endsWith('/revert/stage')
                          ? 'stage-context'
                          : path.endsWith('/revert/commit')
                            ? 'clear-context'
                            : path.endsWith('/prompt')
                              ? 'prompt'
                              : path.endsWith('/wait')
                                ? 'wait-idle'
                                : path.endsWith('/interrupt')
                                  ? 'interrupt-session'
                                  : 'read-session',
                  elapsedMs: Date.now() - testStartedAtMs,
                  requestSettledElapsedMs: null as number | null,
                  outcome: 'PENDING' as NativeStartupObservation['outcome'] | 'PENDING' | 'CANCELLED',
                  status: null as number | null,
                }
            if (operation !== undefined && nativeOperations.length < 32) nativeOperations.push(operation)
            const observe = (outcome: NativeStartupObservation['outcome'], status: number | null) =>
              Effect.gen(function* () {
                if (operation !== undefined) {
                  operation.requestSettledElapsedMs = Date.now() - testStartedAtMs
                  operation.outcome = outcome
                  operation.status = status
                  return
                }
                const observation = { elapsedMs: (yield* Clock.currentTimeMillis) - phase.startedAtMs, outcome, status }
                phase.firstNative ??= observation
                phase.lastNative = observation
                if (outcome === 'HTTP') {
                  phase.nativeHttpResponses += 1
                  if (status === 503) phase.nativeStartingResponses += 1
                } else if (outcome === 'TRANSPORT_ERROR') phase.nativeTransportErrors += 1
                else phase.nativeOtherErrors += 1
              })
            return yield* client.execute(request).pipe(
              Effect.tap((response) => observe('HTTP', response.status)),
              Effect.tapError((error) =>
                observe(error.reason._tag === 'TransportError' ? 'TRANSPORT_ERROR' : 'CLIENT_ERROR', null),
              ),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  if (info) phase.nativeRequestCancellations += 1
                  if (operation !== undefined) {
                    operation.requestSettledElapsedMs = Date.now() - testStartedAtMs
                    operation.outcome = 'CANCELLED'
                  }
                }),
              ),
            )
          }),
        )
        const sourceRevision = 'a'.repeat(40)
        const server = serveOpenCode({ sourceRevision, proxy: 'http://127.0.0.1:9', binary }, upstream, locations).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, nativeClient),
          Effect.provide(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port })),
        )
        let fiber = yield* server.pipe(Effect.forkScoped)
        const waitReady = () => {
          const phase = startup
          const currentFiber = fiber
          return Effect.gen(function* () {
            const waitStartedAtMs = yield* Clock.currentTimeMillis
            yield* Effect.gen(function* () {
              phase.gatewayAttempts += 1
              const response = yield* client.get(`http://127.0.0.1:${port}/readyz`).pipe(Effect.timeout('1 second'))
              phase.lastGatewayStatus = response.status
              if (response.status !== 200)
                return yield* Effect.fail(new Error(`Native harness not ready: HTTP ${response.status}`))
            }).pipe(
              Effect.retry({ schedule: Schedule.spaced('100 millis'), times: 200 }),
              Effect.timeout('25 seconds'),
              Effect.raceFirst(Fiber.join(currentFiber)),
              // Emit once per start, before the outer scope waits for child cleanup. Never include native request data.
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis
                  const { startedAtMs, child, ...observations } = phase
                  yield* Effect.logInfo({
                    event: 'bayn.opencode-native-startup-test.v1',
                    ...observations,
                    readiness: Exit.isSuccess(exit) ? 'READY' : 'FAILED',
                    readinessElapsedMs: now - waitStartedAtMs,
                    phaseElapsedMs: now - startedAtMs,
                  })
                  yield* observeNativeStartupFailure(exit, phase.phase, child)
                }).pipe(Effect.catchCause((cause) => (Exit.isFailure(exit) ? Effect.void : Effect.failCause(cause)))),
              ),
            )
          })
        }
        yield* waitReady()
        expect(handles.length).toBe(1)
        const unauthenticated = yield* client.get(`http://127.0.0.1:${locations.nativePort}/api/info`)
        expect(unauthenticated.status).toBe(401)
        const configurationHash = yield* Effect.fromResult(
          hashResearch(makeOpenCodeConfiguration(directory, `http://127.0.0.1:${locations.relayPort}`)),
        )
        const now = yield* Clock.currentTimeMillis
        const base = editorFixture()
        const firstFeedback = `first-proposal-only ${'a'.repeat(14000)}`
        const run = yield* Effect.fromResult(
          decodeResearchRun({
            ...base,
            context: { memory: { ...base.context.memory, text: firstFeedback, sha256: sha256(firstFeedback) } },
            sourceRevision: 'b'.repeat(40),
            featureCutoff: new Date(now).toISOString(),
            registeredAt: new Date(now).toISOString(),
            deadlineAt: new Date(now + 60000).toISOString(),
            costBasis: null,
            policy: {
              harness: 'opencode',
              harnessVersion: '2.1.3',
              model: openCodeModel,
              configurationHash,
              maximumModelCalls: 1,
              maximumInputBytes: 32768,
              temperature: 0.6,
              max_tokens: 4096,
            },
          }),
        )
        const post = (input: typeof run) =>
          client.execute(
            HttpClientRequest.post(`http://127.0.0.1:${port}/proposal`).pipe(
              HttpClientRequest.bodyText(JSON.stringify(researchRequest(input)), 'application/json'),
            ),
          )
        const infer = (input: typeof run) =>
          Effect.gen(function* () {
            const id = yield* Effect.fromResult(hashResearch(input))
            return yield* inferResearch(input, id, `http://127.0.0.1:${port}/proposal`, {}, sourceRevision)
          })
        const first = yield* infer(run)
        yield* observeLifecycle('first-inference', first.outcome)
        expect(first.outcome).toBe(ResearchOutcome.Complete)
        expect(first.completedAtMs - (first.firstTokenAtMs ?? first.completedAtMs)).toBeGreaterThanOrEqual(150)
        yield* Effect.fromResult(verifyResearchReceipt(run, first))
        const firstId = yield* Effect.fromResult(hashResearch(run))
        expect(yield* fs.exists(`${directory}/attempts/${firstId}.complete.json`)).toBe(true)
        expect(providerCalls).toBe(1)
        const replay = yield* post(run)
        expect(replay.status).toBe(503)
        expect(providerCalls).toBe(1)
        yield* observeLifecycle('first-shutdown-start')
        yield* Fiber.interrupt(fiber)
        yield* observeLifecycle('first-shutdown-complete')
        startup = startupDiagnostics('restart', yield* Clock.currentTimeMillis)
        fiber = yield* server.pipe(Effect.forkScoped)
        yield* waitReady()
        if (firstAuthorization === undefined) return yield* Effect.fail(new Error('Native authentication missing'))
        const staleAuthorization = yield* client.execute(
          HttpClientRequest.get(`http://127.0.0.1:${locations.nativePort}/api/info`).pipe(
            HttpClientRequest.setHeader('authorization', firstAuthorization),
          ),
        )
        expect(staleAuthorization.status).toBe(401)
        const secondFeedback = `second-proposal-only ${'b'.repeat(14000)}`
        const secondRun = {
          ...run,
          attempt: 1,
          context: { memory: { ...run.context.memory, text: secondFeedback, sha256: sha256(secondFeedback) } },
        }
        yield* observeLifecycle('second-inference-start')
        const second = yield* infer(secondRun)
        yield* observeLifecycle('second-inference', second.outcome)
        expect(second.outcome).toBe(ResearchOutcome.Complete)
        yield* Effect.fromResult(verifyResearchReceipt(secondRun, second))
        yield* observeLifecycle('second-receipt-verified')
        expect(providerCalls).toBe(2)
        expect(nativeSessionCreations).toBe(1)
        const secondRequest = yield* fs.readFileString(
          `${directory}/attempts/${yield* Effect.fromResult(hashResearch(secondRun))}.provider-request.json`,
        )
        expect(Buffer.byteLength(secondRequest)).toBeLessThanOrEqual(32768)
        expect(secondRequest).toContain('second-proposal-only')
        expect(secondRequest).not.toContain('first-proposal-only')
        expect(JSON.parse(secondRequest).tool_choice).toBe('none')
        expect(JSON.parse(secondRequest).reasoning_effort).toBe('low')
        const ambiguousStudy = { ...run, studyHash: 'e'.repeat(64) }
        yield* fs.writeFileString(`${directory}/studies/${ambiguousStudy.studyHash}.claim.json`, '{}', { flag: 'wx' })
        const ambiguousCreation = yield* post(ambiguousStudy)
        expect(ambiguousCreation.status).toBe(503)
        expect(nativeSessionCreations).toBe(1)
        expect(providerCalls).toBe(2)
        const sessionId = first.harnessEvidence?.sessionId
        if (sessionId === undefined) return yield* Effect.fail(new Error('Native session identity missing'))
        for (const attempt of [run, secondRun]) {
          const id = yield* Effect.fromResult(hashResearch(attempt))
          const record = yield* fs.readFileString(`${directory}/attempts/${id}.session.json`)
          expect(record).toContain(sessionId)
        }
        expect(first.harnessEvidence?.sessionId).toBe(second.harnessEvidence?.sessionId)
        const cutoff = yield* Clock.currentTimeMillis
        const expiring = {
          ...run,
          attempt: 2,
          featureCutoff: new Date(cutoff).toISOString(),
          registeredAt: new Date(cutoff).toISOString(),
          deadlineAt: new Date(cutoff + 2000).toISOString(),
        }
        const expired = yield* infer(expiring)
        yield* observeLifecycle('expiring-inference', expired.outcome)
        expect(expired.outcome).toBe(ResearchOutcome.Expired)
        yield* Deferred.await(cancelled).pipe(Effect.timeout('3 seconds'))
        expect(providerCalls).toBe(3)
        const ambiguousReplay = yield* post(expiring)
        expect(ambiguousReplay.status).toBe(503)
        expect(providerCalls).toBe(3)
        yield* observeLifecycle('final-shutdown-start')
        yield* Fiber.interrupt(fiber)
        yield* observeLifecycle('final-shutdown-complete')
        expect(handles.length).toBe(2)
        for (const handle of handles) expect(yield* handle.isRunning).toBe(false)
      }).pipe(
        Effect.onExit((exit) => observeLifecycle(Exit.isSuccess(exit) ? 'assertions-passed' : 'assertions-failed')),
        Effect.scoped,
        Effect.onExit((exit) => observeLifecycle(Exit.isSuccess(exit) ? 'scope-released' : 'scope-failed')),
        Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
      ),
    )
  },
  90000,
)
