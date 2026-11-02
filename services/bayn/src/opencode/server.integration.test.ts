import { expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { NodeHttpClient, NodeHttpServer, NodeServices } from '@effect/platform-node'
import { Clock, Deferred, Effect, FileSystem, Fiber, Layer, Schedule, Stream } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { ChildProcessSpawner } from 'effect/process'

import { sha256 } from '../hash'
import { inferResearch } from '../research-inference/client'
import { verifyResearchReceipt } from '../research-inference/store'
import { decodeResearchRun, hashResearch, researchRequest, ResearchOutcome } from '../research-inference/contract'
import { editorFixture, streamFixture } from '../research-inference/test-support'
import { makeOpenCodeConfiguration, openCodeModel } from './configuration'
import { serveOpenCode } from './server'

const binary = process.env['BAYN_TEST_OPENCODE_BINARY']
const nativeTest = binary === undefined ? test.skip : test

nativeTest(
  'pinned native harness reuses one study session, refuses replay and releases its process scope',
  async () => {
    if (binary === undefined) throw new Error('Explicit pinned OpenCode binary required')
    const handles: ChildProcessSpawner.ChildProcessHandle[] = []
    let providerCalls = 0
    let nativeSessionCreations = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-opencode-native-' })
        const locations = { directory, nativePort: 24097, relayPort: 24098 }
        const port = 24096
        const client = yield* HttpClient.HttpClient
        const originalSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const spawner = ChildProcessSpawner.make((command) =>
          originalSpawner.spawn(command).pipe(
            Effect.tap((handle) =>
              Effect.sync(() => {
                handles.push(handle)
              }),
            ),
          ),
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
          Effect.suspend(() => {
            if (request.method === 'POST' && request.url === `http://127.0.0.1:${locations.nativePort}/api/session`)
              nativeSessionCreations += 1
            return client.execute(request)
          }),
        )
        const sourceRevision = 'a'.repeat(40)
        const server = serveOpenCode({ sourceRevision, proxy: 'http://127.0.0.1:9', binary }, upstream, locations).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, nativeClient),
          Effect.provide(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port })),
        )
        let fiber = yield* server.pipe(Effect.forkScoped)
        const ready = Effect.gen(function* () {
          const response = yield* client.get(`http://127.0.0.1:${port}/readyz`).pipe(Effect.timeout('1 second'))
          if (response.status !== 200)
            return yield* Effect.fail(new Error(`Native harness not ready: HTTP ${response.status}`))
        })
        yield* ready.pipe(
          Effect.retry({ schedule: Schedule.spaced('100 millis'), times: 200 }),
          Effect.timeout('25 seconds'),
        )
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
        expect(first.outcome).toBe(ResearchOutcome.Complete)
        expect(first.completedAtMs - (first.firstTokenAtMs ?? first.completedAtMs)).toBeGreaterThanOrEqual(150)
        yield* Effect.fromResult(verifyResearchReceipt(run, first))
        const firstId = yield* Effect.fromResult(hashResearch(run))
        expect(yield* fs.exists(`${directory}/attempts/${firstId}.complete.json`)).toBe(true)
        expect(providerCalls).toBe(1)
        const replay = yield* post(run)
        expect(replay.status).toBe(503)
        expect(providerCalls).toBe(1)
        yield* Fiber.interrupt(fiber)
        fiber = yield* server.pipe(Effect.forkScoped)
        yield* ready.pipe(
          Effect.retry({ schedule: Schedule.spaced('100 millis'), times: 200 }),
          Effect.timeout('25 seconds'),
        )
        const secondFeedback = `second-proposal-only ${'b'.repeat(14000)}`
        const secondRun = {
          ...run,
          attempt: 1,
          context: { memory: { ...run.context.memory, text: secondFeedback, sha256: sha256(secondFeedback) } },
        }
        const second = yield* infer(secondRun)
        expect(second.outcome).toBe(ResearchOutcome.Complete)
        yield* Effect.fromResult(verifyResearchReceipt(secondRun, second))
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
        expect(expired.outcome).toBe(ResearchOutcome.Expired)
        yield* Deferred.await(cancelled).pipe(Effect.timeout('3 seconds'))
        expect(providerCalls).toBe(3)
        const ambiguousReplay = yield* post(expiring)
        expect(ambiguousReplay.status).toBe(503)
        expect(providerCalls).toBe(3)
        yield* Fiber.interrupt(fiber)
        expect(handles.length).toBeGreaterThanOrEqual(2)
        for (const handle of handles) expect(yield* handle.isRunning).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    )
  },
  90000,
)
