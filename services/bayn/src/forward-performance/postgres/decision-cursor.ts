import { Deferred, Effect, Fiber, Option, Schema } from 'effect'

import type { openSnapshotRows } from '../../db/snapshot-rows'
import { strictParseOptions } from '../../schemas'
import type { NativeAlphaDecisionEvidence } from '../alpha-decisions'
import type { ForwardPerformanceExecutionEvidence } from '../model'
import { ReportVerification, reportVerificationConcurrency, type ReportDecisionIndex } from '../verification'
import { AlphaDecisionJsonRow, verifyAlphaDecisionJson } from './alpha-decisions'
import { CycleDecisionJsonRow } from './model'
import { executionEvidenceFromRows, verifyPerformanceDecisionJson } from './projection'

const collectDecisionProjections = <Projection, ProjectionError, Captured, CaptureError, CaptureServices>(
  consumeRows: Effect.Success<ReturnType<typeof openSnapshotRows>>,
  project: (input: unknown) => Effect.Effect<Projection, ProjectionError>,
  accept: (projection: Projection) => void,
  finishCapture: Effect.Effect<Captured, CaptureError, CaptureServices>,
  asynchronous: boolean,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const failed = yield* Deferred.make<never, ProjectionError>()
      const pending: Fiber.Fiber<Projection, ProjectionError>[] = []
      const flush = () =>
        Effect.gen(function* () {
          const fiber = pending.shift()
          if (fiber !== undefined) accept(yield* Fiber.join(fiber))
        })
      const consume = Effect.gen(function* () {
        yield* consumeRows((input) =>
          Effect.gen(function* () {
            if (!asynchronous) {
              accept(yield* project(input))
              return
            }
            pending.push(
              yield* project(input).pipe(
                Effect.tapCause((cause) => Deferred.failCause(failed, cause)),
                Effect.forkScoped,
              ),
            )
            // Bound raw-document lookahead independently of the native pool. Join in cursor order.
            if (pending.length >= reportVerificationConcurrency * 4) yield* flush()
          }),
        )
        // Close the SQL cursor before remaining capture uses the same snapshot connection.
        const captured = yield* finishCapture
        while (pending.length > 0) yield* flush()
        return captured
      })
      // A later job failure must cancel an earlier stalled job rather than wait for its ordered join.
      return yield* Effect.raceFirst(consume, Deferred.await(failed))
    }),
  )

export const readPerformanceDecisionCursor = <Captured, CaptureError, CaptureServices>(
  consumeRows: Effect.Success<ReturnType<typeof openSnapshotRows>>,
  index: ReportDecisionIndex,
  finishCapture: Effect.Effect<Captured, CaptureError, CaptureServices>,
) =>
  Effect.gen(function* () {
    const verifier = yield* Effect.serviceOption(ReportVerification)
    const unverified = new Set<string>()
    const executionEvidence: ForwardPerformanceExecutionEvidence[] = []
    const captured = yield* collectDecisionProjections(
      consumeRows,
      (input) =>
        Schema.decodeUnknownEffect(
          CycleDecisionJsonRow,
          strictParseOptions,
        )(input).pipe(
          Effect.flatMap((row) =>
            Option.isSome(verifier)
              ? verifier.value.decision(row, index)
              : Effect.sync(() => {
                  const verified = verifyPerformanceDecisionJson(row)
                  return {
                    executionEvidence: executionEvidenceFromRows(verified.verifiedRows, index),
                    unverifiedDecisionHashes: verified.unverifiedDecisionHashes,
                  }
                }),
          ),
        ),
      (projection) => {
        for (const hash of projection.unverifiedDecisionHashes) unverified.add(hash)
        executionEvidence.push(...projection.executionEvidence)
      },
      finishCapture,
      Option.isSome(verifier),
    )
    return { executionEvidence, unverifiedDecisionHashes: [...unverified].sort(), captured }
  })

export const readPerformanceAlphaDecisionCursor = (consumeRows: Effect.Success<ReturnType<typeof openSnapshotRows>>) =>
  Effect.gen(function* () {
    const verifier = yield* Effect.serviceOption(ReportVerification)
    const unverified = new Set<string>()
    const alphaDecisions: NativeAlphaDecisionEvidence[] = []
    yield* collectDecisionProjections(
      consumeRows,
      (input) =>
        Schema.decodeUnknownEffect(
          AlphaDecisionJsonRow,
          strictParseOptions,
        )(input).pipe(
          Effect.flatMap((row) =>
            Option.isSome(verifier)
              ? verifier.value.alphaDecision(row)
              : Effect.sync(() => verifyAlphaDecisionJson(row)),
          ),
        ),
      (projection) => {
        for (const hash of projection.unverifiedAlphaDecisionHashes) unverified.add(hash)
        alphaDecisions.push(...projection.alphaDecisions)
      },
      Effect.void,
      Option.isSome(verifier),
    )
    return { alphaDecisions, unverifiedAlphaDecisionHashes: [...unverified].sort() }
  })
