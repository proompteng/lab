import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Effect, FileSystem, Layer, Redacted, Schema } from 'effect'

import { JevEvaluationStoreLive } from '../db/jev-evaluation-postgres'
import { PostgresClientLive } from '../db/postgres-client'
import { Sha256Schema } from '../schemas'
import { decodeJevEvaluationRequest, JevEvidenceError, JevOutcome, makeJevEvaluationReceipt } from './evidence'
import { JevEvaluationStore, recoverExpiredJevEvaluation } from './evaluation'
import { inferenceFixture } from './test-support'

const main = Effect.gen(function* () {
  const [mode, rawRequestId, requestPath, checkpointPath, resultPath] = process.argv.slice(2)
  if (
    !['claim', 'record', 'recover'].includes(mode ?? '') ||
    requestPath === undefined ||
    checkpointPath === undefined ||
    resultPath === undefined
  )
    return yield* new JevEvidenceError({ message: 'Invalid Jev restart worker arguments' })
  const requestId = yield* Schema.decodeUnknownEffect(Sha256Schema)(rawRequestId)
  const postgresUrl = yield* Config.redacted('BAYN_TEST_POSTGRES_URL')
  const parsed = new URL(Redacted.value(postgresUrl))
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
    return yield* new JevEvidenceError({ message: 'Jev restart worker requires a local _test database' })
  const storeLayer = JevEvaluationStoreLive.pipe(
    Layer.provide(
      PostgresClientLive({
        operationTimeoutMs: 5000,
        postgres: { url: postgresUrl, tls: false, caPath: '/unused' },
      }),
    ),
  )
  yield* Effect.gen(function* () {
    const store = yield* JevEvaluationStore
    const fs = yield* FileSystem.FileSystem
    if (mode === 'recover') {
      const saved = yield* store.read(requestId)
      if (saved === null) return yield* new JevEvidenceError({ message: 'Recovery cannot find committed request' })
      const recovered = yield* recoverExpiredJevEvaluation(saved.request)
      yield* fs.writeFileString(resultPath, JSON.stringify(recovered.resolution), { flag: 'wx' })
      return
    }
    const request = yield* fs.readFileString(requestPath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
      Effect.flatMap((value) => Effect.fromResult(decodeJevEvaluationRequest(value))),
    )
    yield* store.begin(request)
    if (mode === 'record')
      yield* store.record(
        request,
        yield* Effect.fromResult(
          makeJevEvaluationReceipt(request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v1',
            requestId: request.requestId,
            startedAt: request.observedAt,
            completedAt: request.observedAt,
            outcome: { status: JevOutcome.Received, inference: inferenceFixture() },
          }),
        ),
      )
    yield* fs.writeFileString(checkpointPath, 'committed', { flag: 'wx' })
    return yield* Effect.never
  }).pipe(Effect.provide(storeLayer))
}).pipe(Effect.provide(NodeServices.layer))

NodeRuntime.runMain(main)
