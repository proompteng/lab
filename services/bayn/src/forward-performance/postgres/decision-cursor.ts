import { Deferred, Effect, Fiber, Option, Schema } from 'effect'

import type { openSnapshotRows } from '../../db/snapshot-rows'
import { strictParseOptions } from '../../schemas'
import type { ForwardPerformanceExecutionEvidence } from '../model'
import {
  ReportVerification,
  reportVerificationConcurrency,
  type ReportDecisionIndex,
  type ReportDecisionProjection,
  type ReportVerificationError,
} from '../verification'
import { CycleDecisionRow } from './model'
import { executionEvidenceFromRows, verifyPerformanceDecisions } from './projection'

export const readPerformanceDecisionCursor = (
  consumeRows: Effect.Success<ReturnType<typeof openSnapshotRows>>,
  index: ReportDecisionIndex,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const verifier = yield* Effect.serviceOption(ReportVerification)
      const failed = yield* Deferred.make<never, ReportVerificationError>()
      const pending: Fiber.Fiber<ReportDecisionProjection, ReportVerificationError>[] = []
      const unverified = new Set<string>()
      const executionEvidence: ForwardPerformanceExecutionEvidence[] = []
      const accept = (projection: ReportDecisionProjection) => {
        for (const hash of projection.unverifiedDecisionHashes) unverified.add(hash)
        executionEvidence.push(...projection.executionEvidence)
      }
      const flush = () =>
        Effect.gen(function* () {
          const fiber = pending.shift()
          if (fiber !== undefined) accept(yield* Fiber.join(fiber))
        })
      const consume = Effect.gen(function* () {
        yield* consumeRows((input) =>
          Effect.gen(function* () {
            const row = yield* Schema.decodeUnknownEffect(CycleDecisionRow, strictParseOptions)(input)
            if (Option.isNone(verifier)) {
              const verified = verifyPerformanceDecisions([row])
              accept({
                executionEvidence: executionEvidenceFromRows(verified.verifiedRows, index),
                unverifiedDecisionHashes: verified.unverifiedDecisionHashes,
              })
              return
            }
            pending.push(
              yield* verifier.value.decision(row, index).pipe(
                Effect.tapCause((cause) => Deferred.failCause(failed, cause)),
                Effect.forkScoped,
              ),
            )
            // Bound raw-document lookahead independently of the native pool. Join in cursor order.
            if (pending.length >= reportVerificationConcurrency * 4) yield* flush()
          }),
        )
        while (pending.length > 0) yield* flush()
        return { executionEvidence, unverifiedDecisionHashes: [...unverified].sort() }
      })
      // A later job failure must cancel an earlier stalled job rather than wait for its ordered join.
      return yield* Effect.raceFirst(consume, Deferred.await(failed))
    }),
  )
