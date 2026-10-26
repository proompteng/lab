import { makeNativeChartEvidence } from '../jev/chart-evidence'
import { makeChartDecisionsRequest } from '../jev/chart-questions'
import type { ReplayInferenceCall } from './inference-timing'
import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Clock, Effect, FileSystem, Layer, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { canonicalHashV1Result } from '../hash'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { DecisionsClient, prepareDecisionsRequest } from '../jev/decisions'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { chartInferenceFixture, entryCompletionFixture } from '../jev/entry-inference.test-support'
import { SymbolSchema } from '../schemas'
import { decideJevEntry } from '../jev/decision'
import { makeJevObservation } from '../jev/observation'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { JevEvaluationStore } from '../jev/evaluation'
import { nativeJevFixture, nativeJevInference } from '../jev/native.test-support'
import { JevResolutionStatus } from '../jev/resolution'
import { evaluateJevObservation } from '../jev/runtime'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { makeControlJevJournal } from './control-jev-journal'

const runId = '3'.repeat(64)
const originalFixture = nativeJevFixture(undefined, undefined, `research-control-${runId}`, undefined, undefined, {
  AAPL: 0.02,
})
const fixture = {
  ...originalFixture,
  observation: Result.getOrThrow(
    makeJevObservation({
      cycleId: Result.getOrThrow(
        canonicalHashV1Result({ runId, sessionDate: originalFixture.snapshot.manifest.sessionDate }),
      ),
      authorityGenerationHash: Result.getOrThrow(
        canonicalHashV1Result({
          runId,
          scope: 'SIMULATED_CONTROL',
          protocol: originalFixture.protocol,
        }),
      ),
      protocol: originalFixture.protocol,
      portfolio: originalFixture.portfolio,
      snapshot: originalFixture.snapshot,
    }),
  ),
}
const plan = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: fixture.observation.payload,
    expiresAt: new Date(
      Date.parse(fixture.observation.payload.observedAt) + fixture.protocol.inferenceValidityMs,
    ).toISOString(),
    planVersion: JevBatchPlanVersion.V7,
  }),
)
const candidate = plan.candidates[0]
if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected entry request')
const request = candidate.request
const observation = fixture.observation.payload
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = `${yield* fs.makeTempDirectoryScoped()}/journal`
  const journal = yield* makeControlJevJournal(directory, '3'.repeat(64))
  yield* TestClock.setTime(Date.parse(observation.observedAt))
  return { fs, directory, journal }
})
const run = <A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem | import('effect').Scope.Scope | TestClock.TestClock>,
) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))))
const seed = (journal: Effect.Success<typeof setup>['journal']) =>
  journal.batches.begin(plan, observation).pipe(Effect.asVoid)
const receipt = (evaluationRequest = request) =>
  Result.getOrThrow(
    makeJevEvaluationReceipt(evaluationRequest, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v2',
      requestId: evaluationRequest.requestId,
      startedAt: observation.observedAt,
      completedAt: observation.observedAt,
      outcome: {
        status: JevOutcome.Completed,
        completion: entryCompletionFixture(evaluationRequest, observation.observedAt),
      },
    }),
  )
const record = (journal: Effect.Success<typeof setup>['journal'], value = request) =>
  Effect.gen(function* () {
    yield* journal.handoffs.recordHandoff(entryCompletionFixture(value, observation.observedAt).handoff)
    return yield* journal.evaluations.record(value, receipt(value))
  })

test('native entry commits source and request before inference, reproduces its result, and consumes its window once', () =>
  run(
    Effect.gen(function* () {
      const { fs, directory, journal } = yield* setup
      let calls = 0
      const client: JevClient['Service'] = {
        evaluate: (input) =>
          Effect.gen(function* () {
            calls++
            expect(yield* fs.exists(`${directory}/request-${request.requestId}.json`).pipe(Effect.orDie)).toBeTrue()
            expect(yield* fs.exists(`${directory}/batch-${plan.batchId}.json`).pipe(Effect.orDie)).toBeTrue()
            expect(yield* fs.exists(`${directory}/handoff-${request.requestId}.json`).pipe(Effect.orDie)).toBeTrue()
            return nativeJevInference(input, new Date(yield* Clock.currentTimeMillis).toISOString(), true)
          }),
      }
      const evaluation = evaluateJevObservation({
        cycleId: observation.cycleId,
        authorityGenerationHash: observation.authorityGenerationHash,
        protocol: fixture.protocol,
        portfolio: observation.portfolio,
        snapshot: fixture.snapshot,
      }).pipe(
        Effect.provideService(CandidateObservationStore, journal.observations),
        Effect.provideService(JevBatchStore, journal.batches),
        Effect.provideService(JevEvaluationStore, journal.evaluations),
        Effect.provideService(JevClient, client),
        Effect.provideService(EntryInferenceJournal, journal.handoffs),
        Effect.provideService(DecisionsClient, {
          evaluate: (raw) =>
            Effect.gen(function* () {
              const prepared = Result.getOrThrow(prepareDecisionsRequest(raw))
              const { symbol } = yield* Schema.decodeUnknownEffect(Schema.Struct({ symbol: SymbolSchema }))(
                prepared.request.input[0].content[2].data,
              ).pipe(Effect.orDie)
              const candidate = plan.candidates.find((value) => value.symbol === symbol)
              if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing chart source')
              const inferred = chartInferenceFixture(
                candidate.request.request,
                new Date(yield* Clock.currentTimeMillis).toISOString(),
              )
              expect(inferred.requestHash).toBe(prepared.requestHash)
              return inferred
            }),
        }),
      )
      const evidence = yield* evaluation
      expect(Result.getOrThrow(decideJevEntry(evidence)).selectedSymbols).toHaveLength(1)
      const repeated = yield* Effect.result(evaluation)
      expect(Result.isFailure(repeated) && repeated.failure._tag).toBe('JevAwaitingFreshWindow')
      expect(calls).toBe(
        plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested).length,
      )
      expect((yield* journal.batches.read(plan.batchId))?.result?.resultHash).toBe(evidence.batchResult.resultHash)
      expect(
        Option.getOrNull(
          yield* journal.observations.latestJevWindowEnd({
            cycleId: observation.cycleId,
            purpose: observation.portfolio.purpose,
          }),
        ),
      ).toBe(fixture.snapshot.manifest.rangeEndAt)
    }),
  ))

test('a durable pending claim forbids another call, expires once, and preserves a later paid receipt as abandoned', () =>
  run(
    Effect.gen(function* () {
      const { journal } = yield* setup
      yield* seed(journal)
      yield* journal.handoffs.recordHandoff(entryCompletionFixture(request, observation.observedAt).handoff)
      expect((yield* journal.batches.begin(plan, observation)).dispatches).toEqual([])
      expect((yield* journal.batches.finish(plan.batchId)).result).toBeNull()
      yield* TestClock.setTime(Date.parse(plan.expiresAt))
      const expired = yield* journal.batches.finish(plan.batchId)
      expect(expired.result).not.toBeNull()
      const late = yield* record(journal)
      expect(late.status).toBe(JevResolutionStatus.Abandoned)
      expect((yield* journal.evaluations.read(request.requestId))?.receipt).toEqual(receipt())
      expect((yield* journal.batches.read(plan.batchId))?.result?.resultHash).toBe(expired.result?.resultHash)
      expect((yield* journal.evaluations.read(request.requestId))?.resolution?.status).toBe(
        JevResolutionStatus.Abandoned,
      )
    }),
  ))

test('terminal receipt and resolution are atomic, idempotent and reject conflicting evidence', () =>
  run(
    Effect.gen(function* () {
      const { journal } = yield* setup
      yield* seed(journal)
      const first = yield* record(journal)
      expect(yield* record(journal)).toEqual(first)
      expect((yield* journal.evaluations.read(request.requestId))?.resolution?.status).toBe(
        JevResolutionStatus.Recorded,
      )
      const conflicting = { ...receipt(), receiptHash: 'a'.repeat(64) }
      expect(Result.isFailure(yield* Effect.result(journal.evaluations.record(request, conflicting)))).toBeTrue()
      yield* TestClock.setTime(Date.parse(request.expiresAt))
      expect(yield* journal.evaluations.abandon(request, request.expiresAt)).toEqual(first)
    }),
  ))

test('exclusive directories reject a restarted experiment and corrupted receipts cannot reproduce a batch', () =>
  run(
    Effect.gen(function* () {
      const { fs, directory, journal } = yield* setup
      expect(Result.isFailure(yield* Effect.result(makeControlJevJournal(directory, '3'.repeat(64))))).toBeTrue()
      yield* seed(journal)
      yield* record(journal)
      for (const candidate of plan.candidates) {
        if (candidate.status !== JevCandidatePlanStatus.Requested || candidate.request.requestId === request.requestId)
          continue
        yield* record(journal, candidate.request)
      }
      yield* journal.batches.finish(plan.batchId)
      yield* fs.writeFileString(`${directory}/terminal-${request.requestId}.json`, '{}')
      expect(Result.isFailure(yield* Effect.result(journal.batches.read(plan.batchId)))).toBeTrue()
    }),
  ))

test('raw chart and Jev provider calls bind their parent through the committed stage graph', () =>
  run(
    Effect.gen(function* () {
      const { journal } = yield* setup
      yield* seed(journal)
      const completion = entryCompletionFixture(request, observation.observedAt)
      const disposition = completion.handoff.disposition
      if (disposition.status !== 'READY' || completion.jev.status !== 'RECEIVED')
        throw Error('Fixture requires both provider stages')
      const visual = Result.getOrThrow(
        makeChartDecisionsRequest({
          chart: Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource)),
          protocol: request.request.protocol,
          funding: request.request.funding,
        }),
      )
      const common = {
        schemaVersion: 'bayn.replay-inference-call.v2' as const,
        budgetMs: 10_000,
        simulatedStartedAt: observation.observedAt,
        providerStartedAt: observation.observedAt,
        providerCompletedAt: observation.observedAt,
      }
      const chartCall: ReplayInferenceCall = {
        ...common,
        stage: 'CHART',
        request: visual.request,
        requestHash: visual.requestHash,
        outcome: { status: 'RECEIVED', inference: disposition.visual },
      }
      const jevCall: ReplayInferenceCall = {
        ...common,
        stage: 'JEV',
        request: disposition.jevRequest,
        requestHash: disposition.jevRequestHash,
        outcome: { status: 'RECEIVED', inference: completion.jev.inference },
      }
      expect(chartCall.requestHash).not.toBe(request.requestHash)
      expect(jevCall.requestHash).not.toBe(request.requestHash)
      yield* journal.retainCall(chartCall)
      expect(Result.isFailure(yield* journal.retainCall(jevCall).pipe(Effect.result))).toBe(true)
      expect(
        Result.isFailure(
          yield* journal.retainCall({ ...chartCall, requestHash: request.requestHash }).pipe(Effect.result),
        ),
      ).toBe(true)
      yield* journal.handoffs.recordHandoff(completion.handoff)
      yield* journal.retainCall(jevCall)
      expect((yield* journal.calls).map((call) => call.stage)).toEqual(['CHART', 'JEV'])
    }),
  ))
