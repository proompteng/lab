import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Clock, Effect, FileSystem, Layer, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { canonicalHashV1Result } from '../hash'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
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
    planVersion: JevBatchPlanVersion.V6,
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
      schemaVersion: 'bayn.jev-evaluation-receipt.v1',
      requestId: evaluationRequest.requestId,
      startedAt: observation.observedAt,
      completedAt: observation.observedAt,
      outcome: {
        status: JevOutcome.Received,
        inference: nativeJevInference(evaluationRequest.request, observation.observedAt, 'enter'),
      },
    }),
  )

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
            return nativeJevInference(input, new Date(yield* Clock.currentTimeMillis).toISOString(), 'enter')
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
      )
      const evidence = yield* evaluation
      expect(Result.getOrThrow(decideJevEntry(evidence)).selectedSymbols).toEqual(['AAPL'])
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
      expect((yield* journal.batches.begin(plan, observation)).dispatches).toEqual([])
      expect((yield* journal.batches.finish(plan.batchId)).result).toBeNull()
      yield* TestClock.setTime(Date.parse(plan.expiresAt))
      const expired = yield* journal.batches.finish(plan.batchId)
      expect(expired.result).not.toBeNull()
      const late = yield* journal.evaluations.record(request, receipt())
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
      const first = yield* journal.evaluations.record(request, receipt())
      expect(yield* journal.evaluations.record(request, receipt())).toEqual(first)
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
      yield* journal.evaluations.record(request, receipt())
      for (const candidate of plan.candidates) {
        if (candidate.status !== JevCandidatePlanStatus.Requested || candidate.request.requestId === request.requestId)
          continue
        yield* journal.evaluations.record(candidate.request, receipt(candidate.request))
      }
      yield* journal.batches.finish(plan.batchId)
      yield* fs.writeFileString(`${directory}/terminal-${request.requestId}.json`, '{}')
      expect(Result.isFailure(yield* Effect.result(journal.batches.read(plan.batchId)))).toBeTrue()
    }),
  ))
