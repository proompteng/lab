import { Clock, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { decideJevManagement } from '../jev/decision'
import { JevEvaluationStore } from '../jev/evaluation'
import { evaluateJevObservation } from '../jev/runtime'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { ReplayBrokerFailure } from './broker'
import { type ControlJevJournal } from './control-jev-journal'
import { applyControlManagementDecision, makeControlManagementBatch } from './control-management'
import { type ControlPortfolio, ControlStudyFailure } from './control-portfolio'
import { makeReplayJevTiming } from './jev-timing'

export interface ControlJevBinding {
  readonly provider: JevClient['Service']
  readonly providerClock: Clock.Clock
  readonly journal: ControlJevJournal
}

export const makeControlJevManagement = (
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
    const evaluate = (input: Parameters<typeof makeControlManagementBatch>[0], portfolio: ControlPortfolio) =>
      timing
        .run(
          Effect.gen(function* () {
            const prepared = yield* Effect.fromResult(makeControlManagementBatch(input))
            const { observation } = prepared
            const evidence = yield* evaluateJevObservation({
              cycleId: observation.cycleId,
              authorityGenerationHash: observation.authorityGenerationHash,
              protocol: observation.protocol,
              portfolio: observation.portfolio,
              snapshot: input.snapshot,
            })
            const decidedAt = yield* timing.currentUtcInstant
            if (decidedAt >= prepared.batch.expiresAt)
              return { status: 'UNAVAILABLE' as const, cause: 'Management evidence expired during persistence' }
            const decision = yield* Effect.fromResult(decideJevManagement({ ...evidence, decidedAt }))
            const committedAtMs = Date.parse(yield* timing.currentUtcInstant)
            if (committedAtMs >= Date.parse(prepared.batch.expiresAt))
              return { status: 'UNAVAILABLE' as const, cause: 'Management decision expired before commitment' }
            const applied = yield* Effect.fromResult(
              applyControlManagementDecision({
                portfolio,
                expectedBatchId: prepared.batch.batchId,
                decision,
                committedAtMs,
              }),
            )
            return { status: 'DECIDED' as const, applied, committedAtMs }
          }).pipe(
            Effect.provideService(CandidateObservationStore, binding.journal.observations),
            Effect.provideService(JevBatchStore, binding.journal.batches),
            Effect.provideService(JevEvaluationStore, binding.journal.evaluations),
            Effect.provideService(JevClient, timing.client),
            Effect.catchTags({
              JevAwaitingFreshWindow: (cause) => Effect.succeed({ status: 'ALREADY_OBSERVED' as const, cause }),
              JevAwaitingEvidence: (cause) => Effect.succeed({ status: 'UNAVAILABLE' as const, cause }),
            }),
          ),
        )
        .pipe(
          Effect.onExit(() => marketClock.currentTimeMillis.pipe(Effect.flatMap(advanceTo))),
          Effect.mapError((cause) => new ControlStudyFailure({ message: 'Native control management failed', cause })),
        )
    return { evaluate }
  }).pipe(
    Effect.mapError((cause) => new ControlStudyFailure({ message: 'Cannot bind native control management', cause })),
  )
