import { resourceUsage } from 'node:process'
import { Clock, Config, Data, Effect, Exit, Logger } from 'effect'

export const reportingLogger = Logger.layer([Logger.withConsoleError(Logger.formatJson)])

export class ReportingRuntimeForbidden extends Data.TaggedError('ReportingRuntimeForbidden')<{
  readonly message: string
}> {}

/** A pod-level operational guard, not a credential or trading-authority boundary. */
export const requireReportingRuntime = Effect.gen(function* () {
  const allowed = yield* Config.Boolean('BAYN_REPORTING_ALLOWED').pipe(Config.withDefault(true))
  if (!allowed)
    return yield* new ReportingRuntimeForbidden({
      message:
        'Reporting is disabled in this workload; use an isolated reporting or API pod, never an execution controller',
    })
})

/** Native maxRSS is a process-lifetime high-water mark in KiB, not a sampled current heap or a general bound. */
export const withReportResourceMeasurement = <A, E, R>(command: string, report: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    return yield* report.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const completedAt = yield* Clock.currentTimeMillis
          const usage = yield* Effect.sync(resourceUsage)
          yield* Effect.logInfo('Bayn report process resource measurement').pipe(
            Effect.annotateLogs({
              command,
              outcome: Exit.isSuccess(exit) ? 'SUCCESS' : 'FAILURE_OR_INTERRUPTION',
              elapsedMs: completedAt - startedAt,
              peakResidentSetKiB: usage.maxRSS,
              peakScope: 'PROCESS_LIFETIME',
            }),
          )
        }),
      ),
    )
  })
