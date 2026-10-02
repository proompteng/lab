import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Clock, Effect, FileSystem, Layer, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { canonicalHashV1 } from '../hash'
import { JevCandidatePlanStatus } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { decideJevManagement, JevManagementAction } from '../jev/decision'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { evaluateJevOnce, JevClaim, JevEvaluationStore } from '../jev/evaluation'
import { nativeJevInference } from '../jev/native.test-support'
import { JevResolutionStatus } from '../jev/resolution'
import { evaluateJevObservation } from '../jev/runtime'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { controlJevFixture } from './control-jev.test-support'
import { makeControlJevJournal } from './control-jev-journal'

const fixture = controlJevFixture()
const plan = fixture.prepared.batch
const candidate = plan.candidates[0]
if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected management request')
const request = candidate.request
const observation = fixture.prepared.observation
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = `${yield* fs.makeTempDirectoryScoped()}/journal`
  const journal = yield* makeControlJevJournal(directory, fixture.input.runId)
  yield* TestClock.setTime(fixture.atMs)
  return { fs, directory, journal }
})
const run = <A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem | import('effect').Scope.Scope | TestClock.TestClock>,
) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))))
const seed = (journal: Effect.Success<typeof setup>['journal']) =>
  Effect.gen(function* () {
    yield* journal.observations.record({ contentHash: canonicalHashV1(observation), payload: observation })
    yield* journal.batches.begin(plan)
  })
const receipt = () =>
  Result.getOrThrow(
    makeJevEvaluationReceipt(request, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v1',
      requestId: request.requestId,
      startedAt: observation.observedAt,
      completedAt: observation.observedAt,
      outcome: {
        status: JevOutcome.Received,
        inference: nativeJevInference(request.request, observation.observedAt, 'exit'),
      },
    }),
  )

test('native management commits source and request before inference, reproduces its result, and consumes its window once', () =>
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
            return nativeJevInference(input, new Date(yield* Clock.currentTimeMillis).toISOString(), 'exit')
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
      expect(Result.getOrThrow(decideJevManagement(evidence)).action).toBe(JevManagementAction.Exit)
      const repeated = yield* Effect.result(evaluation)
      expect(Result.isFailure(repeated) && repeated.failure._tag).toBe('JevAwaitingFreshWindow')
      expect(calls).toBe(1)
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
      expect((yield* journal.evaluations.begin(request)).status).toBe(JevClaim.Acquired)
      const duplicate = yield* Effect.result(
        evaluateJevOnce(request).pipe(
          Effect.provideService(JevEvaluationStore, journal.evaluations),
          Effect.provideService(JevClient, { evaluate: () => Effect.die('Duplicate provider call') }),
        ),
      )
      expect(Result.isFailure(duplicate) && duplicate.failure._tag).toBe('JevEvidenceError')
      expect((yield* journal.batches.finish(plan.batchId)).result).toBeNull()
      yield* TestClock.setTime(Date.parse(plan.expiresAt))
      const expired = yield* journal.batches.finish(plan.batchId)
      expect(expired.result).not.toBeNull()
      const late = yield* journal.evaluations.record(request, receipt())
      expect(late.status).toBe(JevResolutionStatus.Abandoned)
      expect((yield* journal.evaluations.read(request.requestId))?.receipt).toEqual(receipt())
      expect((yield* journal.batches.read(plan.batchId))?.result?.resultHash).toBe(expired.result?.resultHash)
      expect((yield* journal.evaluations.begin(request)).status).toBe(JevClaim.Abandoned)
    }),
  ))

test('terminal receipt and resolution are atomic, idempotent and reject conflicting evidence', () =>
  run(
    Effect.gen(function* () {
      const { journal } = yield* setup
      yield* seed(journal)
      yield* journal.evaluations.begin(request)
      const first = yield* journal.evaluations.record(request, receipt())
      expect(yield* journal.evaluations.record(request, receipt())).toEqual(first)
      expect((yield* journal.evaluations.begin(request)).status).toBe(JevClaim.Recorded)
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
      expect(Result.isFailure(yield* Effect.result(makeControlJevJournal(directory, fixture.input.runId)))).toBeTrue()
      yield* seed(journal)
      yield* journal.evaluations.begin(request)
      yield* journal.evaluations.record(request, receipt())
      yield* journal.batches.finish(plan.batchId)
      yield* fs.writeFileString(`${directory}/terminal-${request.requestId}.json`, '{}')
      expect(Result.isFailure(yield* Effect.result(journal.batches.read(plan.batchId)))).toBeTrue()
    }),
  ))
