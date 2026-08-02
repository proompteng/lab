export * from './candidate-development-command/contracts'
export * from './candidate-development-command/failures'
export * from './candidate-development-command/evaluation'
export * from './candidate-development-command/runtime-policy'
export * from './candidate-development-command/source-git'
export * from './candidate-development-command/artifact-policy'
export * from './candidate-development-command/plan-evaluation'
export * from './candidate-development-command/sandbox'
export * from './candidate-development-command/orchestration'

import { writeSync } from 'node:fs'
import { isMainThread } from 'node:worker_threads'

import { NodeRuntime } from '@effect/platform-node'
import { Cause, Config, Data, Effect, Option } from 'effect'

import {
  evaluateCandidateDevelopmentArtifact,
  loadCandidateDevelopmentRuntimeMarketDataFile,
} from './candidate-development-command/sandbox'
import {
  loadAuthorizedCandidateDevelopmentExecutableProgram,
  loadCandidateDevelopmentExecutableProgram,
  runCandidateDevelopmentCommand,
  type CandidateDevelopmentLoadedExecutableProgram,
} from './candidate-development-command/orchestration'
import {
  renderCandidateDevelopmentCommandDefect,
  renderCandidateDevelopmentCommandFailure,
} from './candidate-development-command/failures'
import { sourceVerificationFailure } from './candidate-development-command/evaluation'
import { verifyCandidateDevelopmentSourceFiles } from './candidate-development-command/source-git'
import { GitSourceRevisionSchema } from './schemas'
import type {
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentCommandReport,
} from './candidate-development-command/contracts'

const modulePath = process.argv.at(2)
const sourceManifestPath = process.argv.at(3)
const runtimeMarketDataPath = process.argv.at(4)

const expectedSourceRevisionConfig = Config.option(
  Config.schema(GitSourceRevisionSchema, 'BAYN_CANDIDATE_DEVELOPMENT_EXPECTED_SOURCE_REVISION'),
).pipe(Config.map(Option.getOrUndefined))

export const loadCandidateDevelopmentExpectedSourceRevision = expectedSourceRevisionConfig.pipe(
  Effect.mapError(() =>
    sourceVerificationFailure('verify-head', {
      field: 'expectedSourceRevision',
      expected: 'lowercase 40-character Git revision when configured',
      observed: 'invalid configuration',
    }),
  ),
)

const executeLoadedCandidateDevelopmentProgram = (
  loaded: CandidateDevelopmentLoadedExecutableProgram,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure> =>
  runCandidateDevelopmentCommand(loaded.program, loaded.verifiedSource).pipe(
    Effect.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
        cause,
      }),
    ),
  )

const main = Effect.gen(function* () {
  const expectedSourceRevision = yield* loadCandidateDevelopmentExpectedSourceRevision
  return modulePath === undefined
    ? yield* Effect.fail<CandidateDevelopmentCommandFailure>({ _tag: 'CandidateDevelopmentCommandModulePathMissing' })
    : sourceManifestPath === undefined
      ? yield* Effect.fail<CandidateDevelopmentCommandFailure>({
          _tag: 'CandidateDevelopmentCommandSourceManifestPathMissing',
        })
      : runtimeMarketDataPath === undefined
        ? yield* Effect.fail<CandidateDevelopmentCommandFailure>(
            sourceVerificationFailure('verify-runtime-market-data', {
              field: 'runtimeMarketDataPath',
              expected: 'path to a typed content-verified runtime market-data witness',
              observed: null,
            }),
          )
        : yield* loadAuthorizedCandidateDevelopmentExecutableProgram(
            modulePath,
            sourceManifestPath,
            (module, manifest) =>
              loadCandidateDevelopmentExecutableProgram(
                module,
                manifest,
                evaluateCandidateDevelopmentArtifact,
                (sourceModulePath, sourceManifest, sourceGit) =>
                  verifyCandidateDevelopmentSourceFiles(
                    sourceModulePath,
                    sourceManifest,
                    sourceGit,
                    expectedSourceRevision,
                  ),
                loadCandidateDevelopmentRuntimeMarketDataFile(runtimeMarketDataPath),
              ),
          ).pipe(Effect.flatMap(executeLoadedCandidateDevelopmentProgram))
}).pipe(Effect.annotateLogs({ operation: 'candidate-development-command' }))

export class CandidateDevelopmentCommandError extends Data.TaggedError('CandidateDevelopmentCommandError')<{
  readonly failure: CandidateDevelopmentCommandFailure
}> {}

export type CandidateDevelopmentCommandFailureWriter = (renderedFailure: string) => Effect.Effect<void, never>

const writeCandidateDevelopmentCommandFailureToStderr: CandidateDevelopmentCommandFailureWriter = (renderedFailure) =>
  Effect.sync(() => {
    writeSync(process.stderr.fd, renderedFailure)
  })

export const writeCandidateDevelopmentCommandFailure = (
  failure: CandidateDevelopmentCommandFailure,
  writer: CandidateDevelopmentCommandFailureWriter = writeCandidateDevelopmentCommandFailureToStderr,
): Effect.Effect<void, never> => Effect.suspend(() => writer(renderCandidateDevelopmentCommandFailure(failure)))

const renderCandidateDevelopmentCommandCause = (
  cause: Cause.Cause<CandidateDevelopmentCommandFailure>,
): string | undefined => {
  if (Cause.hasInterruptsOnly(cause)) return undefined
  const [reason] = cause.reasons
  return cause.reasons.length === 1 && reason !== undefined && Cause.isFailReason(reason)
    ? renderCandidateDevelopmentCommandFailure(reason.error)
    : renderCandidateDevelopmentCommandDefect()
}

const reportCandidateDevelopmentCommandCause = (
  cause: Cause.Cause<CandidateDevelopmentCommandFailure>,
  writer: CandidateDevelopmentCommandFailureWriter,
): Effect.Effect<void, never> => {
  const rendered = renderCandidateDevelopmentCommandCause(cause)
  if (rendered === undefined) return Effect.void
  return Effect.suspend(() => writer(rendered)).pipe(
    Effect.catchCause(() =>
      writeCandidateDevelopmentCommandFailureToStderr(renderCandidateDevelopmentCommandDefect()).pipe(
        Effect.catchCause(() => Effect.void),
      ),
    ),
  )
}

export const runCandidateDevelopmentCommandMain = <A>(
  command: Effect.Effect<A, CandidateDevelopmentCommandFailure>,
  writer: CandidateDevelopmentCommandFailureWriter = writeCandidateDevelopmentCommandFailureToStderr,
): void =>
  NodeRuntime.runMain(
    command.pipe(
      Effect.tapCause((cause) => reportCandidateDevelopmentCommandCause(cause, writer)),
      Effect.mapError((failure) => new CandidateDevelopmentCommandError({ failure })),
    ),
    { disableErrorReporting: true },
  )

if (import.meta.main && isMainThread) {
  runCandidateDevelopmentCommandMain(main)
}
