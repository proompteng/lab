import { Clock, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { decideJevEntry } from '../jev/decision'
import { JevEvaluationStore } from '../jev/evaluation'
import { evaluateJevObservation } from '../jev/runtime'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { ReplayBrokerFailure } from './broker'
import { type ControlJevJournal } from './control-jev-journal'
import { ControlStudyFailure } from './control-portfolio'
import { makeReplayJevTiming } from './jev-timing'
import { makeControlEntryObservation } from './control-entry'

export interface ControlJevBinding {
  readonly provider: JevClient['Service']
  readonly providerClock: Clock.Clock
  readonly journal: ControlJevJournal
}

export const makeControlJev = (
  binding: ControlJevBinding,
  advanceTo: (atMs: number) => Effect.Effect<void, ControlStudyFailure>,
) =>
  Effect.gen(function* () {
    const marketClock = yield* TestClock.testClockWith(Effect.succeed)
    const timing = yield* makeReplayJevTiming({
      provider: binding.provider,
      providerClock: binding.providerClock,
      advanceTo: (atMs) => marketClock.setTime(atMs),
      advanceDeadlineTo: (atMs) => marketClock.setTime(atMs),
      excludedSourceMillis: Effect.succeed(0),
      retain: (call) =>
        binding.journal
          .retainCall(call)
          .pipe(
            Effect.mapError(
              (cause) => new ReplayBrokerFailure({ message: 'Cannot retain control provider response', cause }),
            ),
          ),
      measureDatabaseTime: (operation) => operation,
    })
    const evaluateEntry = (input: Parameters<typeof makeControlEntryObservation>[0]) =>
      timing
        .run(
          Effect.gen(function* () {
            if (!(yield* binding.journal.usable))
              return { status: 'UNAVAILABLE' as const, cause: 'Interrupted entry journal cannot be reused' }
            const prepared = yield* Effect.fromResult(makeControlEntryObservation(input))
            const observation = prepared.payload
            const deadlineMs = Date.parse(observation.observedAt) + observation.protocol.inferenceValidityMs
            const budgetMs = Math.max(0, deadlineMs - Date.parse(yield* timing.currentUtcInstant))
            if (budgetMs === 0)
              return { status: 'UNAVAILABLE' as const, cause: 'Entry deadline elapsed before evaluation' }
            return yield* Effect.gen(function* () {
              const evidence = yield* evaluateJevObservation({
                cycleId: observation.cycleId,
                authorityGenerationHash: observation.authorityGenerationHash,
                protocol: observation.protocol,
                portfolio: observation.portfolio,
                snapshot: input.snapshot,
              })
              const decidedAt = yield* timing.currentUtcInstant
              if (Date.parse(decidedAt) >= deadlineMs)
                return { status: 'UNAVAILABLE' as const, cause: 'Entry evidence expired during persistence' }
              const decision = yield* Effect.fromResult(decideJevEntry({ ...evidence, decidedAt }))
              const decisionHash = yield* binding.journal.retainEntryDecision(decision)
              const committedAtMs = Date.parse(yield* timing.currentUtcInstant)
              if (committedAtMs >= deadlineMs)
                return { status: 'UNAVAILABLE' as const, cause: 'Entry decision expired before commitment' }
              return {
                status: 'DECIDED' as const,
                symbol: decision.selectedSymbols[0] ?? null,
                decisionHash,
                committedAtMs,
                batchId: evidence.batchPlan.batchId,
                observationHash: evidence.batchPlan.observationHash,
              }
            }).pipe(
              Effect.raceFirst(
                Effect.sleep(budgetMs).pipe(
                  Effect.provideService(Clock.Clock, binding.providerClock),
                  Effect.as({
                    status: 'UNAVAILABLE' as const,
                    cause: 'Entry exhausted its inference validity deadline',
                  }),
                ),
              ),
            )
          }).pipe(
            Effect.provideService(CandidateObservationStore, binding.journal.observations),
            Effect.provideService(JevBatchStore, binding.journal.batches),
            Effect.provideService(JevEvaluationStore, binding.journal.evaluations),
            Effect.provideService(JevClient, timing.client),
            Effect.catchTags({
              JevAwaitingFreshWindow: (cause) => Effect.succeed({ status: 'ALREADY_OBSERVED' as const, cause }),
              JevAwaitingEvidence: (cause) => Effect.succeed({ status: 'UNAVAILABLE' as const, cause }),
              OperationalError: (cause) =>
                binding.journal.usable.pipe(
                  Effect.flatMap((usable) =>
                    usable
                      ? Effect.fail(cause)
                      : Effect.succeed({
                          status: 'UNAVAILABLE' as const,
                          cause: 'Entry journal was interrupted; this experiment remains incomplete',
                        }),
                  ),
                ),
            }),
          ),
        )
        .pipe(
          Effect.onExit(() => marketClock.currentTimeMillis.pipe(Effect.flatMap(advanceTo))),
          Effect.mapError((cause) => new ControlStudyFailure({ message: 'Native control entry failed', cause })),
        )
    return { evaluateEntry }
  }).pipe(Effect.mapError((cause) => new ControlStudyFailure({ message: 'Cannot bind native control entry', cause })))
