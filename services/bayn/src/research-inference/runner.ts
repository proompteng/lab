import { recordResearchMetrics, researchReplayCounter } from './telemetry'
import { Clock, Effect, Metric, Semaphore } from 'effect'

import {
  hashResearch,
  ResearchError,
  ResearchOutcome,
  researchRequest,
  sealResearchReceipt,
  type ResearchRun,
} from './contract'
import { inferResearch } from './client'
import { verifyResearchReceipt, type ResearchStore } from './store'

export const makeResearchRunner = (
  store: ResearchStore,
  endpoint: string,
  traceHeaders: () => Readonly<Record<string, string>> = () => ({}),
  workerSourceRevision: string | null = null,
) =>
  Effect.gen(function* () {
    const admission = yield* Semaphore.make(1)
    const run = Effect.fn('bayn.research.run')(function* (input: ResearchRun) {
      const runId = yield* Effect.fromResult(hashResearch(input))
      yield* Effect.annotateCurrentSpan({ runId, studyHash: input.studyHash, attempt: input.attempt })
      const span = yield* Effect.currentSpan.pipe(Effect.orDie)
      const previous = yield* store.read(runId)
      if (previous !== undefined) {
        yield* Metric.update(researchReplayCounter, 1)
        return yield* Effect.fromResult(verifyResearchReceipt(input, previous))
      }
      if (input.schemaVersion !== 'bayn.jev-editor.v1')
        return yield* new ResearchError({
          message: 'Retired research registrations are readable but cannot be executed',
        })
      if (!(yield* store.claim(runId, input))) {
        const now = yield* Clock.currentTimeMillis
        return yield* Effect.fromResult(
          sealResearchReceipt(input, {
            runId,
            workerSourceRevision,
            requestHash: yield* Effect.fromResult(hashResearch(researchRequest(input))),
            startedAtMs: now,
            completedAtMs: now,
            firstTokenAtMs: null,
            outcome: ResearchOutcome.Ambiguous,
            httpStatus: null,
            servingIdentity: null,
            serverRequestId: null,
            responseHash: null,
            responseText: '',
            responseBase64: '',
            usage: null,
            instructions: null,
          }),
        )
      }
      const receipt = yield* inferResearch(
        input,
        runId,
        'harness' in input.policy ? 'http://opencode-research.opencode.svc.cluster.local:4096/proposal' : endpoint,
        traceHeaders(),
        workerSourceRevision,
      )
      yield* store.finish(input, receipt)
      yield* recordResearchMetrics(receipt)
      yield* Effect.logInfo('Bayn research attempt completed').pipe(
        Effect.annotateLogs({
          runId,
          trace_id: span.traceId,
          span_id: span.spanId,
          requestHash: receipt.requestHash,
          receiptHash: receipt.receiptHash,
          outcome: receipt.outcome,
          elapsedMs: receipt.completedAtMs - receipt.startedAtMs,
          ttftMs: receipt.firstTokenAtMs === null ? -1 : receipt.firstTokenAtMs - receipt.startedAtMs,
          httpStatus: receipt.httpStatus ?? 0,
          costCoverage: receipt.costPicoUsd === null ? 'UNKNOWN' : 'ALLOCATED_ESTIMATE',
        }),
      )
      return receipt
    }, admission.withPermits(1))
    return { run }
  })
