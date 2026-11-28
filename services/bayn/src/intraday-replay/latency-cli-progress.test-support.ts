import { Clock, Effect, Exit } from 'effect'

type LatencyCliPhase =
  | 'compile'
  | 'worker'
  | 'replay-child'
  | 'report-validation'
  | 'execution-evidence'
  | 'cost-binding'
  | 'economics'
  | 'tamper-validation'
  | 'acceptance-write'

// Test-only, closed labels: never include the effect's value, error, SQL or source payload.
// A start record survives even when the outer Bun timeout kills the worker before finalizers run.
export const withLatencyCliPhase =
  (phase: LatencyCliPhase) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      yield* Effect.logInfo('Latency CLI acceptance phase').pipe(
        Effect.annotateLogs({ phase, status: 'started', elapsedMs: 0 }),
      )
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const finishedAt = yield* Clock.currentTimeMillis
            yield* Effect.logInfo('Latency CLI acceptance phase').pipe(
              Effect.annotateLogs({
                phase,
                status: Exit.isSuccess(exit) ? 'completed' : Exit.hasInterrupts(exit) ? 'interrupted' : 'failed',
                elapsedMs: finishedAt - startedAt,
              }),
            )
          }),
        ),
      )
    })
