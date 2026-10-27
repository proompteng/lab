import { EntryInferenceJournalLive } from '../db/entry-inference-postgres'
import { EntryInferenceJournal } from './entry-inference'
import { entryCompletionFixture, stagedCheckpointFixture } from './entry-inference.test-support'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Effect, FileSystem, Layer, Redacted, Schema } from 'effect'

import { JevBatchStoreLive } from '../db/jev-batch-postgres'
import { JevEvaluationStoreLive } from '../db/jev-evaluation-postgres'
import { PostgresClientLive } from '../db/postgres-client'
import { Sha256Schema } from '../schemas'
import { JevCandidatePlanStatus } from './batch'
import { JevBatchStore } from './batch-evaluation'
import { JevEvidenceError, JevOutcome, makeJevEvaluationReceipt } from './evidence'
import { JevEvaluationStore } from './evaluation'

const main = Effect.gen(function* () {
  const [mode, rawId, checkpointPath, resultPath] = process.argv.slice(2)
  if (!['claim', 'record', 'recover'].includes(mode ?? '') || checkpointPath === undefined || resultPath === undefined)
    return yield* new JevEvidenceError({ message: 'Invalid Jev batch worker arguments' })
  const batchId = yield* Schema.decodeUnknownEffect(Sha256Schema)(rawId)
  const url = yield* Config.Redacted('BAYN_TEST_POSTGRES_URL')
  const parsed = new URL(Redacted.value(url))
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
    return yield* new JevEvidenceError({ message: 'Jev batch worker requires a local _test database' })
  const stores = JevBatchStoreLive.pipe(
    Layer.provideMerge(Layer.mergeAll(JevEvaluationStoreLive, EntryInferenceJournalLive)),
    Layer.provide(PostgresClientLive({ operationTimeoutMs: 5000, postgres: { url, tls: false, caPath: '/unused' } })),
  )
  yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (mode === 'recover') {
      const recovered = yield* Effect.flatMap(JevBatchStore, (store) => store.finish(batchId))
      yield* fs.writeFileString(resultPath, JSON.stringify(recovered), { flag: 'wx' })
      return
    }
    const saved = yield* (yield* JevBatchStore).read(batchId)
    const candidate = saved?.plan.candidates.find((entry) => entry.status === JevCandidatePlanStatus.Requested)
    if (candidate === undefined)
      return yield* new JevEvidenceError({ message: 'Jev batch worker has no planned request' })
    const request = candidate.request
    const store = yield* JevEvaluationStore
    if ((yield* store.read(request.requestId)) === null)
      return yield* new JevEvidenceError({ message: 'Worker requires its committed batch claim' })
    if (mode === 'record') {
      const journal = yield* EntryInferenceJournal
      const checkpoint = stagedCheckpointFixture(request, request.observedAt)
      for (const claim of checkpoint.claims) {
        yield* journal.recordVisualClaim(claim)
        const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
        if (terminal !== undefined) yield* journal.recordVisualTerminal(terminal)
      }
      for (const skip of checkpoint.skips) yield* journal.recordBaseStartSkip(skip)
      yield* journal.recordHandoff(entryCompletionFixture(request, request.observedAt).handoff)
    }
    if (mode === 'record')
      yield* store.record(
        request,
        yield* Effect.fromResult(
          makeJevEvaluationReceipt(request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v3',
            requestId: request.requestId,
            startedAt: request.observedAt,
            completedAt: request.observedAt,
            outcome: {
              status: JevOutcome.Completed,
              completion: entryCompletionFixture(request, request.observedAt, 0.9),
            },
          }),
        ),
      )
    yield* fs.writeFileString(checkpointPath, 'committed', { flag: 'wx' })
    return yield* Effect.never
  }).pipe(Effect.provide(stores))
}).pipe(Effect.provide(NodeServices.layer))

NodeRuntime.runMain(main)
