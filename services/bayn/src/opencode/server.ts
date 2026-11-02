import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import { NodeHttpServer } from '@effect/platform-node'
import {
  ByteSize,
  Clock,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Result,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from 'effect'
import {
  HttpClient,
  HttpClientRequest,
  HttpIncomingMessage,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { sha256 } from '../hash'
import { makeResearchStreamDecoder } from '../research-inference/client'
import {
  decodeResearchRun,
  hashResearch,
  maximumResearchStreamBytes,
  ResearchError,
  researchServingIdentity,
  type ResearchRun,
} from '../research-inference/contract'
import { strictParseOptions } from '../schemas'
import { admitOpenCodeCall, nativeProviderHeaders, type OpenCodeAttempt } from './gateway'
import { makeOpenCodeConfiguration, openCodeDirectory, openCodeModel, openCodeVersion } from './configuration'

const ProposalSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.opencode-proposal.v1'),
  registration: Schema.Unknown,
})
const SessionMappingSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(/^ses_[A-Za-z0-9]+$/)),
})
const InfoSchema = Schema.Struct({ version: Schema.Literal(openCodeVersion) })
const UserMessagesSchema = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, type: Schema.Literal('user') })),
})
const SessionSchema = Schema.Struct({
  data: Schema.Struct({
    id: Schema.String,
    agent: Schema.Literal('build'),
    model: Schema.Struct({ id: Schema.Literal(openCodeModel), providerID: Schema.Literal('opencode') }),
    cost: Schema.Literal(0),
    permissions: Schema.Array(Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.String })),
    outcome: Schema.optionalKey(Schema.String),
    metadata: Schema.Struct({
      studyHash: Schema.String,
      sourceRevision: Schema.String,
      configurationHash: Schema.String,
    }),
    time: Schema.Struct({ idle: Schema.optionalKey(Schema.Finite) }),
  }),
})

const captureProviderStream = <E>(incoming: { readonly stream: Stream.Stream<Uint8Array, E> }, run: ResearchRun) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = []
    const decoder = makeResearchStreamDecoder(run)
    let invalid: ResearchError | undefined
    let length = 0
    yield* incoming.stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          length += chunk.byteLength
          if (length > maximumResearchStreamBytes)
            return yield* new ResearchError({ message: 'OpenCode response exceeds its byte limit' })
          chunks.push(chunk)
          if (invalid === undefined) {
            const parsed = decoder.push(chunk, yield* Clock.currentTimeMillis)
            if (Result.isFailure(parsed)) invalid = parsed.failure
          }
        }),
      ),
    )
    return {
      bytes: Buffer.concat(chunks),
      firstTokenAtMs: decoder.snapshot().firstTokenAtMs,
      validation: invalid === undefined ? decoder.complete() : Result.fail(invalid),
    }
  })

interface ActiveAttempt extends OpenCodeAttempt {
  readonly cancelled: Deferred.Deferred<never, ResearchError>
  readonly evidenceBase: string
  readonly run: ResearchRun
  providerRequest: Buffer | undefined
  response: { readonly bytes: Buffer; readonly status: number; readonly firstTokenAtMs: number | null } | undefined
}

export const serveOpenCode = (
  config: { readonly sourceRevision: string; readonly proxy: string; readonly binary: string },
  upstream: HttpClient.HttpClient,
  locations = { directory: openCodeDirectory, nativePort: 4097, relayPort: 4098 },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const http = yield* HttpClient.HttpClient
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const directory = locations.directory
    const nativeOrigin = `http://127.0.0.1:${locations.nativePort}`
    const configuration = makeOpenCodeConfiguration(directory, `http://127.0.0.1:${locations.relayPort}`)
    const configurationHash = yield* Effect.fromResult(hashResearch(configuration))
    const password = randomBytes(32).toString('hex')
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    for (const dir of ['config/opencode', 'data', 'cache', 'state', 'workspace', 'attempts', 'studies'])
      yield* fs.makeDirectory(`${directory}/${dir}`, { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(`${directory}/config/opencode/opencode.json`, JSON.stringify(configuration), {
      mode: 0o600,
    })
    const env = {
      PATH: '/bin:/usr/bin',
      HOME: directory,
      XDG_CONFIG_HOME: `${directory}/config`,
      XDG_DATA_HOME: `${directory}/data`,
      XDG_CACHE_HOME: `${directory}/cache`,
      XDG_STATE_HOME: `${directory}/state`,
      OPENCODE_SERVER_PASSWORD: password,
      HTTPS_PROXY: config.proxy,
      HTTP_PROXY: config.proxy,
      NO_PROXY: '127.0.0.1,localhost',
    }
    const version = yield* spawner.string(
      ChildProcess.make(config.binary, ['--version'], { env, stdin: 'ignore', stderr: 'ignore' }),
    )
    if (version.trim() !== `opencode v${openCodeVersion}`)
      return yield* new ResearchError({ message: 'OpenCode binary differs from the pinned harness version' })
    const child = yield* spawner.spawn(
      ChildProcess.make(
        config.binary,
        ['serve', '--hostname', '127.0.0.1', '--port', String(locations.nativePort), '--log-level', 'none'],
        {
          env,
          cwd: `${directory}/workspace`,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        },
      ),
    )
    const native = (method: 'GET' | 'POST', path: string, body?: unknown) => {
      let request = HttpClientRequest.make(method)(`${nativeOrigin}${path}`).pipe(
        HttpClientRequest.setHeader('authorization', auth),
      )
      if (body !== undefined)
        request = request.pipe(HttpClientRequest.bodyText(JSON.stringify(body), 'application/json'))
      return http.execute(request)
    }
    const info = Effect.gen(function* () {
      const response = yield* native('GET', '/api/info')
      if (response.status !== 200) return yield* new ResearchError({ message: 'OpenCode native server is unavailable' })
      yield* Schema.decodeUnknownEffect(InfoSchema)(yield* response.json)
    })
    yield* info.pipe(
      Effect.retry({ schedule: Schedule.spaced('200 millis'), times: 100 }),
      Effect.timeout('25 seconds'),
    )
    const mutex = yield* Semaphore.make(1)
    let active: ActiveAttempt | undefined
    const relay = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = yield* request.text.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(32)),
      )
      const current = active
      yield* Effect.fromResult(
        admitOpenCodeCall(
          current,
          { body, sessionId: request.headers['x-opencode-session-id'] },
          yield* Clock.currentTimeMillis,
        ),
      )
      if (current === undefined) return yield* new ResearchError({ message: 'OpenCode active attempt disappeared' })
      const headers = nativeProviderHeaders(request.headers)
      current.providerRequest = Buffer.from(body)
      yield* fs.writeFileString(`${current.evidenceBase}.provider-request.json`, body, { flag: 'wx', mode: 0o600 })
      const forward = Effect.gen(function* () {
        const response = yield* upstream.execute(
          HttpClientRequest.post('https://opencode.ai/inference/openai/v1/chat/completions').pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyText(body, 'application/json'),
          ),
        )
        const capture = yield* captureProviderStream(response, current.run)
        const { bytes } = capture
        current.response = { status: response.status, bytes, firstTokenAtMs: capture.firstTokenAtMs }
        yield* fs.writeFile(`${current.evidenceBase}.response.sse`, bytes, { flag: 'wx', mode: 0o600 })
        if (response.status === 200) yield* Effect.fromResult(capture.validation)
        return HttpServerResponse.uint8Array(bytes, {
          status: response.status,
          contentType: response.status === 200 ? 'text/event-stream' : 'application/json',
        })
      }).pipe(Effect.scoped)
      return yield* Effect.raceFirst(forward, Deferred.await(current.cancelled))
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning('OpenCode relay rejected a call').pipe(
          Effect.annotateLogs({ failure: error instanceof ResearchError ? error.message : error._tag }),
        ),
      ),
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 403 })),
    )
    const relayHttpServer = Context.get(
      yield* Layer.build(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: locations.relayPort })),
      HttpServer.HttpServer,
    )
    const relayServer = Effect.gen(function* () {
      const router = yield* HttpRouter.make
      yield* router.add('POST', '/provider/v1/chat/completions', relay)
      yield* HttpServer.serveEffect(
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- router erases route errors; normalize them before serving.
        router.asHttpEffect().pipe(
          Effect.mapError((cause) => new ResearchError({ message: 'OpenCode HTTP route failed', cause })),
          Effect.orDie,
        ),
      )
      return yield* Effect.never
    }).pipe(Effect.provideService(HttpServer.HttpServer, relayHttpServer))
    yield* relayServer.pipe(Effect.forkScoped)
    const proposal = Effect.gen(function* () {
      if (active !== undefined) return HttpServerResponse.empty({ status: 409 })
      const input = yield* HttpServerRequest.schemaBodyJson(ProposalSchema, strictParseOptions).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(256)),
      )
      const run = yield* Effect.fromResult(decodeResearchRun(input.registration))
      if (!('harness' in run.policy) || run.policy.configurationHash !== configurationHash)
        return yield* new ResearchError({
          message: 'OpenCode registration differs from the deployed configuration',
        })
      const runId = yield* Effect.fromResult(hashResearch(run))
      const now = yield* Clock.currentTimeMillis
      const remaining = Date.parse(run.deadlineAt) - now
      if (now < Date.parse(run.featureCutoff) || remaining <= 0)
        return yield* new ResearchError({ message: 'OpenCode registration is outside its approved window' })
      const base = `${directory}/attempts/${runId}`
      // A retained claim without a complete response stays ambiguous after a crash.
      yield* fs.writeFileString(`${base}.claim.json`, JSON.stringify(run), { flag: 'wx', mode: 0o600 })
      const studyDirectory = `${directory}/workspace/${run.studyHash}`
      yield* fs.makeDirectory(studyDirectory, { recursive: true, mode: 0o700 })
      const permissions = [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: `${studyDirectory}/*`, effect: 'allow' },
      ]
      const metadata = { studyHash: run.studyHash, sourceRevision: run.sourceRevision, configurationHash }
      const execute = Effect.gen(function* () {
        const mappingPath = `${directory}/studies/${run.studyHash}.json`
        let sessionId: string
        if (yield* fs.exists(mappingPath)) {
          if ((yield* fs.stat(mappingPath)).size > 4096n)
            return yield* new ResearchError({ message: 'OpenCode study mapping exceeds its bound' })
          const mapping = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(SessionMappingSchema),
            strictParseOptions,
          )(yield* fs.readFileString(mappingPath))
          sessionId = mapping.sessionId
        } else {
          // An unknown session-creation outcome cannot create a second session for the study.
          yield* fs.writeFileString(`${directory}/studies/${run.studyHash}.claim.json`, JSON.stringify(metadata), {
            flag: 'wx',
            mode: 0o600,
          })
          const created = yield* native('POST', '/api/session', {
            title: `Bayn GEPA ${run.studyHash}`,
            agent: 'build',
            model: { id: openCodeModel, providerID: 'opencode' },
            metadata,
            permissions,
          })
          if (created.status !== 200)
            return yield* new ResearchError({ message: 'OpenCode native study session creation failed' })
          const info = yield* Schema.decodeUnknownEffect(SessionSchema)(yield* created.json)
          const mapping = yield* Schema.decodeUnknownEffect(SessionMappingSchema)({ sessionId: info.data.id })
          yield* fs.writeFileString(mappingPath, JSON.stringify(mapping), { flag: 'wx', mode: 0o600 })
          sessionId = mapping.sessionId
        }
        const sessionPath = `/api/session/${sessionId}`
        const interrupt = native('POST', `${sessionPath}/interrupt?resume=false`, {}).pipe(
          Effect.asVoid,
          Effect.timeout('2 seconds'),
          Effect.ignore,
        )
        const session = yield* native('GET', sessionPath)
        if (session.status !== 200)
          return yield* new ResearchError({ message: 'OpenCode study session could not be acquired' })
        const sessionValue = yield* session.json
        const retained = yield* Schema.decodeUnknownEffect(SessionSchema)(sessionValue)
        if (
          retained.data.id !== sessionId ||
          (yield* Effect.fromResult(hashResearch(retained.data.permissions))) !==
            (yield* Effect.fromResult(hashResearch(permissions))) ||
          (yield* Effect.fromResult(hashResearch(retained.data.metadata))) !==
            (yield* Effect.fromResult(hashResearch(metadata)))
        )
          return yield* new ResearchError({ message: 'OpenCode session belongs to a different frozen study' })
        const userMessages = Effect.gen(function* () {
          const response = yield* native('GET', `${sessionPath}/message?order=asc&type=user&limit=1`)
          if (response.status !== 200)
            return yield* new ResearchError({ message: 'OpenCode study context could not be inspected' })
          return yield* Schema.decodeUnknownEffect(UserMessagesSchema)(yield* response.json)
        })
        const previous = (yield* userMessages).data[0]
        if (previous !== undefined) {
          // Attempt inputs and outputs are retained separately; inference sees only the current frozen feedback.
          const staged = yield* native('POST', `${sessionPath}/revert/stage`, { messageID: previous.id, files: false })
          if (staged.status !== 200)
            return yield* new ResearchError({ message: 'OpenCode previous proposal context could not be staged' })
          const committed = yield* native('POST', `${sessionPath}/revert/commit`, {})
          if (committed.status !== 204 || (yield* userMessages).data.length !== 0)
            return yield* new ResearchError({ message: 'OpenCode previous proposal context was not cleared' })
        }
        const cancelled = yield* Deferred.make<never, ResearchError>()
        const attempt: ActiveAttempt = {
          sessionId,
          deadlineAtMs: Date.parse(run.deadlineAt),
          calls: 0,
          cancelled,
          evidenceBase: base,
          run,
          providerRequest: undefined,
          response: undefined,
        }
        return yield* Effect.acquireRelease(
          Effect.sync(() => {
            active = attempt
            return attempt
          }),
          () =>
            Effect.gen(function* () {
              active = undefined
              yield* Deferred.fail(cancelled, new ResearchError({ message: 'OpenCode attempt scope ended' }))
              yield* interrupt
            }),
        ).pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              const prompt = yield* native('POST', `${sessionPath}/prompt`, {
                id: `msg_bayn_${runId}`,
                text: `Bayn research attempt ${runId}\n${run.promptTemplate}\n\n${run.context.memory.text}\n\nAll feedback is supplied above. Do not use tools. Jev is a typed System One decision model, not a text-generating LLM. Change only its actual-entry complete-plan entry question, maximum 2000 characters. Code owns all arithmetic, position sizing, risk gates and execution. Return only the complete instruction JSON object with exactly one entry string. No markdown, notes, paths or external references in the entry. Your one model-call budget cannot be retried.`,
              })
              if (prompt.status !== 200)
                return yield* new ResearchError({ message: 'OpenCode native prompt was not accepted' })
              const wait = yield* native('POST', `/api/experimental/session/${sessionId}/wait`, {})
              if (wait.status !== 204)
                return yield* new ResearchError({ message: 'OpenCode session did not reach idle' })
              const final = yield* native('GET', sessionPath)
              const completed = yield* Schema.decodeUnknownEffect(SessionSchema)(yield* final.json)
              if (
                completed.data.outcome !== 'succeeded' ||
                completed.data.time.idle === undefined ||
                attempt.calls !== 1 ||
                attempt.response === undefined ||
                attempt.providerRequest === undefined
              )
                return yield* new ResearchError({
                  message: 'OpenCode attempt lacks one successful, free native model call',
                })
              const response = attempt.response
              yield* fs.writeFileString(`${base}.session.json`, JSON.stringify(completed), { flag: 'wx', mode: 0o600 })
              if (response.status !== 200)
                return HttpServerResponse.uint8Array(response.bytes, { status: 503, contentType: 'application/json' })
              if (response.firstTokenAtMs === null)
                return yield* new ResearchError({ message: 'OpenCode lacks a provider first-token observation' })
              const decoder = makeResearchStreamDecoder(run)
              yield* Effect.fromResult(decoder.push(response.bytes, yield* Clock.currentTimeMillis))
              yield* Effect.fromResult(decoder.complete())
              yield* fs.writeFileString(
                `${base}.complete.json`,
                JSON.stringify({
                  runId,
                  sessionId,
                  configurationHash,
                  sourceRevision: config.sourceRevision,
                  responseHash: sha256(response.bytes),
                  modelCalls: attempt.calls,
                  providerCostUsd: completed.data.cost,
                }),
                { flag: 'wx', mode: 0o600 },
              )
              return yield* HttpServerResponse.json(
                {
                  schemaVersion: 'bayn.opencode-response.v1',
                  harnessEvidence: {
                    firstTokenAtMs: response.firstTokenAtMs,
                    serverSourceRevision: config.sourceRevision,
                    studyHash: run.studyHash,
                    sessionId,
                    configurationHash,
                    modelCalls: 1,
                    providerCostUsd: 0,
                    providerRequestHash: sha256(attempt.providerRequest),
                    providerRequestBase64: attempt.providerRequest.toString('base64'),
                  },
                  providerResponseBase64: response.bytes.toString('base64'),
                },
                {
                  headers: {
                    'x-model-serving-identity': JSON.stringify(researchServingIdentity(run.policy)),
                    'x-bayn-source-revision': config.sourceRevision,
                  },
                },
              )
            }),
          ),
        )
      }).pipe(Effect.scoped, Effect.timeout(`${remaining} millis`))
      return yield* execute
    }).pipe(
      mutex.withPermits(1),
      Effect.tapError((error) =>
        Effect.logWarning('OpenCode proposal failed').pipe(
          Effect.annotateLogs({ failure: error instanceof ResearchError ? error.message : error._tag }),
        ),
      ),
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 })),
    )
    const router = yield* HttpRouter.make
    yield* router.add('POST', '/proposal', proposal)
    yield* router.add(
      'GET',
      '/readyz',
      info.pipe(
        Effect.as(HttpServerResponse.empty({ status: 200 })),
        Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 })),
      ),
    )
    yield* HttpServer.serveEffect(
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- router erases route errors; normalize them before serving.
      router.asHttpEffect().pipe(
        Effect.mapError((cause) => new ResearchError({ message: 'OpenCode HTTP route failed', cause })),
        Effect.orDie,
      ),
    )
    yield* Effect.logInfo('Bayn OpenCode free proposer is listening').pipe(
      Effect.annotateLogs({
        sourceRevision: config.sourceRevision,
        harnessVersion: openCodeVersion,
        configurationHash,
      }),
    )
    yield* child.exitCode
    return yield* new ResearchError({ message: 'OpenCode native server exited' })
  }).pipe(Effect.scoped)
