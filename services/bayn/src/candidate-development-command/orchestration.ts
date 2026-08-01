import { Effect, pipe, Result } from 'effect'
import {
  candidateDevelopmentCalendarContract,
  runCandidateDevelopment,
  type CandidateDevelopmentEffects,
  type CandidateDevelopmentPreflightPass,
} from '../candidate-development'
import {
  deriveCandidateDevelopmentPriorTrialsHash,
  frozenCandidateDevelopmentTrialHistory,
} from '../candidate-development-trial-history'
import { canonicalHashV1Result } from '../hash'
import type {
  CandidateDevelopmentCommandEvaluation,
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentCommandReport,
  CandidateDevelopmentExecutableProgram,
  CandidateDevelopmentVerifiedSource,
} from './contracts'
import {
  authorizeCandidateDevelopmentAttempt,
  bindCandidateDevelopmentVerifiedSource,
  buildCandidateDevelopmentCommandReport,
  sourceVerificationFailure,
} from './evaluation'
import { validateCandidateDevelopmentExecutableProgram, recordOf } from './runtime-policy'
import { evaluateCandidateDevelopmentArtifact, missingCandidateDevelopmentRuntimeMarketData } from './sandbox'
import { verifyCandidateDevelopmentSourceFiles } from './source-git'
import type {
  CandidateDevelopmentModuleImporter,
  CandidateDevelopmentRuntimeMarketDataLoader,
  CandidateDevelopmentSourceVerifier,
} from './source-git'

const validateCandidateDevelopmentPreregisteredProtocol = (
  program: CandidateDevelopmentExecutableProgram<unknown, unknown, unknown, unknown>,
  preflight: CandidateDevelopmentPreflightPass,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  if (program.strategyProtocol.strategyIdentity === undefined) return Result.succeed(undefined)
  const preregistration = frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePreregistration
  const priorTrialsHash = pipe(
    deriveCandidateDevelopmentPriorTrialsHash(
      frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePriorTrials,
    ),
    Result.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandHashFailed',
        cause,
      }),
    ),
  )
  const strategyIdentityHash = pipe(
    canonicalHashV1Result(program.strategyProtocol.strategyIdentity),
    Result.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandHashFailed',
        cause,
      }),
    ),
  )
  const calendarHash = pipe(
    canonicalHashV1Result(candidateDevelopmentCalendarContract),
    Result.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandHashFailed',
        cause,
      }),
    ),
  )
  return pipe(
    Result.all({ strategyIdentityHash, calendarHash, priorTrialsHash }),
    Result.flatMap(
      ({
        strategyIdentityHash: observedStrategyIdentityHash,
        calendarHash: observedCalendarHash,
        priorTrialsHash: observedPriorTrialsHash,
      }) => {
        const bindings = [
          ['strategyIdentityHash', preregistration.strategyIdentityHash, observedStrategyIdentityHash],
          [
            'candidateDevelopmentProtocolHash',
            preregistration.candidateDevelopmentProtocolHash,
            preflight.protocolIdentity.candidateDevelopmentProtocolHash,
          ],
          ['calendarHash', preregistration.calendarHash, observedCalendarHash],
          ['priorTrialsHash', preregistration.priorTrialsHash, observedPriorTrialsHash],
          [
            'source.strategyIdentityHash',
            preregistration.strategyIdentityHash,
            verifiedSource.sourceManifest.strategyIdentityHash,
          ],
          [
            'source.candidateDevelopmentProtocolHash',
            preregistration.candidateDevelopmentProtocolHash,
            verifiedSource.sourceManifest.candidateDevelopmentProtocolHash,
          ],
          ['source.calendarHash', preregistration.calendarHash, verifiedSource.sourceManifest.calendarHash],
          ['source.priorTrialsHash', preregistration.priorTrialsHash, verifiedSource.sourceManifest.priorTrialsHash],
        ] as const
        for (const [field, expected, observed] of bindings) {
          if (expected !== observed) {
            return Result.fail(
              sourceVerificationFailure('verify-program-binding', {
                field: `trialHistory.latestReviewedCandidatePreregistration.${field}`,
                expected,
                observed,
              }),
            )
          }
        }
        return Result.succeed(undefined)
      },
    ),
  )
}

export const executeCandidateDevelopmentProgram = <Registration, DevelopmentData, Error, Requirements>(
  program: CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements>,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure | Error, Requirements> => {
  let evaluation: CandidateDevelopmentCommandEvaluation | undefined
  const effects: CandidateDevelopmentEffects<
    Registration,
    DevelopmentData,
    CandidateDevelopmentCommandFailure | Error,
    Requirements
  > = {
    ...program.effects,
    preregisterCandidate: (preflight) =>
      Effect.fromResult(
        validateCandidateDevelopmentPreregisteredProtocol(
          program as CandidateDevelopmentExecutableProgram<unknown, unknown, unknown, unknown>,
          preflight,
          verifiedSource,
        ),
      ).pipe(Effect.flatMap(() => program.effects.preregisterCandidate(preflight))),
    evaluateDevelopment: (data, preflight) =>
      program.effects.evaluateDevelopment(data, preflight, verifiedSource).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            evaluation = value
          }),
        ),
      ),
  }
  return runCandidateDevelopment(program.input, effects).pipe(
    Effect.flatMap((report) =>
      evaluation === undefined
        ? Effect.fail<CandidateDevelopmentCommandFailure>({ _tag: 'CandidateDevelopmentCommandEvaluationMissing' })
        : Effect.fromResult(
            buildCandidateDevelopmentCommandReport(
              report,
              evaluation,
              program.strategyProtocol,
              program.input.officialSessions,
              verifiedSource,
            ),
          ),
    ),
  )
}

export const renderCandidateDevelopmentCommandReport = (report: CandidateDevelopmentCommandReport): string =>
  `${JSON.stringify(report)}\n`

export type CandidateDevelopmentCommandReportWriter = (
  renderedReport: string,
) => Effect.Effect<void, CandidateDevelopmentCommandFailure>

export interface CandidateDevelopmentCommandOutput {
  readonly write: (renderedReport: string, callback: (error?: Error | null) => void) => unknown
  readonly destroy: (error?: Error) => void
}

export const makeCandidateDevelopmentCommandReportWriter =
  (output: CandidateDevelopmentCommandOutput): CandidateDevelopmentCommandReportWriter =>
  (renderedReport) =>
    Effect.callback<void, CandidateDevelopmentCommandFailure>((resume) => {
      let pending = true
      const complete = (error?: Error | null) => {
        if (!pending) return
        pending = false
        resume(
          error === null || error === undefined
            ? Effect.succeed(undefined)
            : Effect.fail({ _tag: 'CandidateDevelopmentCommandOutputFailed', cause: error }),
        )
      }
      try {
        output.write(renderedReport, complete)
      } catch (cause) {
        pending = false
        resume(Effect.fail({ _tag: 'CandidateDevelopmentCommandOutputFailed', cause }))
      }
      return Effect.sync(() => {
        if (!pending) return
        pending = false
        output.destroy(new Error('candidate development report output interrupted'))
      })
    })

const writeCandidateDevelopmentCommandReportToStdout = makeCandidateDevelopmentCommandReportWriter(process.stdout)

export const writeCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentCommandReport,
  writer: CandidateDevelopmentCommandReportWriter = writeCandidateDevelopmentCommandReportToStdout,
): Effect.Effect<void, CandidateDevelopmentCommandFailure> => writer(renderCandidateDevelopmentCommandReport(report))

export const runCandidateDevelopmentCommand = <Registration, DevelopmentData, Error, Requirements>(
  program: CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements>,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure | Error, Requirements> =>
  executeCandidateDevelopmentProgram(program, verifiedSource).pipe(Effect.tap(writeCandidateDevelopmentCommandReport))

type ExecutableProgram = CandidateDevelopmentExecutableProgram<
  unknown,
  unknown,
  CandidateDevelopmentCommandFailure,
  never
>

export interface CandidateDevelopmentLoadedExecutableProgram {
  readonly program: ExecutableProgram
  readonly verifiedSource: CandidateDevelopmentVerifiedSource
}

const importCandidateDevelopmentModule: CandidateDevelopmentModuleImporter = evaluateCandidateDevelopmentArtifact

export const loadCandidateDevelopmentExecutableProgram = (
  modulePath: string,
  sourceManifestPath: string,
  importer: CandidateDevelopmentModuleImporter = importCandidateDevelopmentModule,
  sourceVerifier: CandidateDevelopmentSourceVerifier = verifyCandidateDevelopmentSourceFiles,
  runtimeMarketDataLoader: CandidateDevelopmentRuntimeMarketDataLoader = missingCandidateDevelopmentRuntimeMarketData,
): Effect.Effect<CandidateDevelopmentLoadedExecutableProgram, CandidateDevelopmentCommandFailure> =>
  Effect.gen(function* () {
    const before = yield* sourceVerifier(modulePath, sourceManifestPath)
    const module = yield* importer(before.moduleUrl, before.files, runtimeMarketDataLoader)
    const after = yield* sourceVerifier(modulePath, sourceManifestPath)
    const beforeHash = yield* Effect.fromResult(
      canonicalHashV1Result(before).pipe(
        Result.mapError((cause) => sourceVerificationFailure('verify-post-import', cause)),
      ),
    )
    const afterHash = yield* Effect.fromResult(
      canonicalHashV1Result(after).pipe(
        Result.mapError((cause) => sourceVerificationFailure('verify-post-import', cause)),
      ),
    )
    if (beforeHash !== afterHash) {
      return yield* Effect.fail(
        sourceVerificationFailure('verify-post-import', {
          expected: beforeHash,
          observed: afterHash,
        }),
      )
    }
    const program = yield* Effect.fromResult(
      validateCandidateDevelopmentExecutableProgram(recordOf(module)?.candidateDevelopmentProgram),
    )
    const verifiedSource = yield* Effect.fromResult(bindCandidateDevelopmentVerifiedSource(before.files, program.input))
    return { program, verifiedSource }
  })

type CandidateDevelopmentProgramLoader = (
  modulePath: string,
  sourceManifestPath: string,
) => Effect.Effect<CandidateDevelopmentLoadedExecutableProgram, CandidateDevelopmentCommandFailure>

export const loadAuthorizedCandidateDevelopmentExecutableProgram = (
  modulePath: string,
  sourceManifestPath: string,
  loader: CandidateDevelopmentProgramLoader = loadCandidateDevelopmentExecutableProgram,
): Effect.Effect<CandidateDevelopmentLoadedExecutableProgram, CandidateDevelopmentCommandFailure> =>
  Effect.fromResult(authorizeCandidateDevelopmentAttempt()).pipe(
    Effect.flatMap(() => loader(modulePath, sourceManifestPath)),
  )
