import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { randomUUID } from 'node:crypto'

import { NodeRuntime } from '@effect/platform-node'
import { Cause, Data, Effect, Exit } from 'effect'

import type {
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentCommandReport,
} from '../candidate-development-command/contracts'
import {
  evaluateCandidateDevelopmentArtifact,
  loadCandidateDevelopmentRuntimeMarketDataFile,
} from '../candidate-development-command/sandbox'
import {
  loadAuthorizedCandidateDevelopmentExecutableProgram,
  loadCandidateDevelopmentExecutableProgram,
  runCandidateDevelopmentCommand,
  type CandidateDevelopmentLoadedExecutableProgram,
} from '../candidate-development-command/orchestration'
import {
  renderCandidateDevelopmentCommandDefect,
  renderCandidateDevelopmentCommandFailure,
} from '../candidate-development-command/failures'
import { candidateDevelopmentSourceGit } from '../candidate-development-command/git-interpreter'
import { verifyCandidateDevelopmentSourceFiles } from '../candidate-development-command/source-provenance-policy'
import {
  bindCandidateDevelopmentLocalSource,
  CandidateDevelopmentLocalError,
  makeCandidateDevelopmentLocalReceipt,
  makeCandidateDevelopmentLocalTerminalReceipt,
  parseCandidateDevelopmentLocalArguments,
  serializeCandidateDevelopmentLocalReceipt,
  type CandidateDevelopmentLocalArguments,
  type CandidateDevelopmentLocalAttemptReceipt,
  type CandidateDevelopmentLocalSourceBinding,
  type CandidateDevelopmentLocalTerminalOutcome,
} from './domain'

const candidateDevelopmentEvaluatorSourcePath = 'services/bayn/src'
const legacyCandidateDevelopmentLocalReceiptName = 'bayn-candidate-development-local-receipt.json'

export interface PreparedCandidateDevelopmentLocalAttempt {
  readonly repositoryRoot: string
  readonly args: CandidateDevelopmentLocalArguments
  readonly receiptPath: string
  readonly legacyReceiptPath: string
  readonly source: CandidateDevelopmentLocalSourceBinding
}

export interface CandidateDevelopmentLocalAttemptPort {
  reserve: (
    path: string,
    receipt: CandidateDevelopmentLocalAttemptReceipt,
    legacyReceiptPath?: string,
  ) => Effect.Effect<void, CandidateDevelopmentLocalError>
  execute: (
    prepared: PreparedCandidateDevelopmentLocalAttempt,
  ) => Effect.Effect<
    CandidateDevelopmentCommandReport,
    CandidateDevelopmentLocalError | CandidateDevelopmentCommandFailure
  >
  finalize: (
    path: string,
    receipt: CandidateDevelopmentLocalAttemptReceipt,
  ) => Effect.Effect<void, CandidateDevelopmentLocalError>
}

export type CandidateDevelopmentLocalAttempt = (
  prepared: PreparedCandidateDevelopmentLocalAttempt,
) => Effect.Effect<
  CandidateDevelopmentLocalAttemptReceipt,
  CandidateDevelopmentLocalError | CandidateDevelopmentCommandFailure
>

export interface CandidateDevelopmentLocalDependencies {
  readonly prepare: (
    args: CandidateDevelopmentLocalArguments,
  ) => Effect.Effect<PreparedCandidateDevelopmentLocalAttempt, CandidateDevelopmentLocalError>
  readonly attempt: CandidateDevelopmentLocalAttempt
}

const localError = (
  code: ConstructorParameters<typeof CandidateDevelopmentLocalError>[0]['code'],
  message: string,
  cause?: unknown,
): CandidateDevelopmentLocalError =>
  new CandidateDevelopmentLocalError({ code, message, ...(cause === undefined ? {} : { cause }) })

const isFileSystemError = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code

export const resolveCandidateDevelopmentLocalArguments = (
  repositoryRoot: string,
  args: CandidateDevelopmentLocalArguments,
): CandidateDevelopmentLocalArguments => ({
  modulePath: resolve(repositoryRoot, args.modulePath),
  sourceManifestPath: resolve(repositoryRoot, args.sourceManifestPath),
  runtimeMarketDataPath: resolve(repositoryRoot, args.runtimeMarketDataPath),
})

const repositoryRelativePath = (repositoryRoot: string, absolutePath: string, label: string): string => {
  const path = relative(repositoryRoot, absolutePath)
  if (path.length === 0 || path === '..' || path.startsWith(`..${sep}`) || path.startsWith(sep)) {
    throw localError('SOURCE_BINDING_INVALID', `${label} must be inside the repository`)
  }
  return path.split(sep).join('/')
}

export const verifyCandidateDevelopmentLocalSourceTree = (
  repositoryRoot: string,
  paths: readonly string[],
  sourceGit = candidateDevelopmentSourceGit,
): Effect.Effect<void, CandidateDevelopmentLocalError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const tracked = await sourceGit.text(repositoryRoot, ['ls-files', '-v', '--', ...paths], signal)
      if (
        tracked
          .split('\n')
          .filter((entry) => entry.length > 0)
          .some((entry) => !entry.startsWith('H '))
      ) {
        throw new Error('tracked source has an index override')
      }
      const diff = await sourceGit.text(repositoryRoot, ['diff', '--name-only', 'HEAD', '--', ...paths], signal)
      if (diff.length > 0) throw new Error('source differs from reviewed HEAD')
      const status = await sourceGit.text(
        repositoryRoot,
        ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--', ...paths],
        signal,
      )
      if (status.length > 0) throw new Error('source working tree is not clean')
    },
    catch: (cause) =>
      localError(
        'SOURCE_BINDING_INVALID',
        'candidate module, source manifest, and evaluator source must match their exact reviewed HEAD blobs',
        cause,
      ),
  })

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

const executeCandidateDevelopmentCommand = (
  prepared: PreparedCandidateDevelopmentLocalAttempt,
): Effect.Effect<
  CandidateDevelopmentCommandReport,
  CandidateDevelopmentLocalError | CandidateDevelopmentCommandFailure
> => {
  const sourcePaths = [
    prepared.source.modulePath,
    prepared.source.sourceManifestPath,
    candidateDevelopmentEvaluatorSourcePath,
  ]
  const verifySourceTree = verifyCandidateDevelopmentLocalSourceTree(prepared.repositoryRoot, sourcePaths)
  return verifySourceTree.pipe(
    Effect.flatMap(() =>
      loadAuthorizedCandidateDevelopmentExecutableProgram(
        prepared.args.modulePath,
        prepared.args.sourceManifestPath,
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
                prepared.source.sourceRevision,
              ),
            loadCandidateDevelopmentRuntimeMarketDataFile(prepared.args.runtimeMarketDataPath),
          ),
      ),
    ),
    Effect.tap(() => verifyCandidateDevelopmentLocalSourceTree(prepared.repositoryRoot, sourcePaths)),
    Effect.flatMap(executeLoadedCandidateDevelopmentProgram),
    Effect.tap(() => verifyCandidateDevelopmentLocalSourceTree(prepared.repositoryRoot, sourcePaths)),
  )
}

const prepareCandidateDevelopmentLocalAttempt = (
  args: CandidateDevelopmentLocalArguments,
): Effect.Effect<PreparedCandidateDevelopmentLocalAttempt, CandidateDevelopmentLocalError> =>
  Effect.gen(function* () {
    const repositoryRoot = yield* Effect.tryPromise({
      try: async (signal) =>
        realpath(await candidateDevelopmentSourceGit.text(process.cwd(), ['rev-parse', '--show-toplevel'], signal)),
      catch: (cause) => localError('SOURCE_BINDING_INVALID', 'candidate repository root is unavailable', cause),
    })
    const normalizedArgs = resolveCandidateDevelopmentLocalArguments(repositoryRoot, args)
    const sourcePaths = yield* Effect.try({
      try: () => [
        repositoryRelativePath(repositoryRoot, normalizedArgs.modulePath, 'module'),
        repositoryRelativePath(repositoryRoot, normalizedArgs.sourceManifestPath, 'source manifest'),
        candidateDevelopmentEvaluatorSourcePath,
      ],
      catch: (cause) =>
        cause instanceof CandidateDevelopmentLocalError
          ? cause
          : localError('SOURCE_BINDING_INVALID', 'candidate source paths are invalid', cause),
    })
    yield* verifyCandidateDevelopmentLocalSourceTree(repositoryRoot, sourcePaths)
    const verified = yield* verifyCandidateDevelopmentSourceFiles(
      normalizedArgs.modulePath,
      normalizedArgs.sourceManifestPath,
    ).pipe(
      Effect.mapError((cause) => localError('SOURCE_BINDING_INVALID', 'candidate source binding is invalid', cause)),
    )
    const source = yield* Effect.fromResult(bindCandidateDevelopmentLocalSource(verified.files)).pipe(
      Effect.mapError((cause) => localError('SOURCE_BINDING_INVALID', 'candidate source binding is invalid', cause)),
    )
    const receiptPaths = yield* Effect.tryPromise({
      try: async (signal) => {
        const commonDirectoryValue = await candidateDevelopmentSourceGit.text(
          repositoryRoot,
          ['rev-parse', '--git-common-dir'],
          signal,
        )
        const commonDirectory = await realpath(resolve(repositoryRoot, commonDirectoryValue))
        const receiptDirectory = join(commonDirectory, 'bayn', 'candidate-development-attempts')
        await mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
        if ((await realpath(receiptDirectory)) !== receiptDirectory) {
          throw new Error('candidate receipt directory is not canonical')
        }
        const legacyReceiptPath = resolve(
          repositoryRoot,
          await candidateDevelopmentSourceGit.text(
            repositoryRoot,
            ['rev-parse', '--git-path', legacyCandidateDevelopmentLocalReceiptName],
            signal,
          ),
        )
        return {
          attempt: join(receiptDirectory, `ordinal-${source.candidateOrdinal}.json`),
          legacy: legacyReceiptPath,
        }
      },
      catch: (cause) => localError('RECEIPT_RESERVATION_FAILED', 'candidate receipt path is unavailable', cause),
    })
    return {
      repositoryRoot,
      args: normalizedArgs,
      receiptPath: receiptPaths.attempt,
      legacyReceiptPath: receiptPaths.legacy,
      source,
    }
  })

export const makeCandidateDevelopmentLocalAttempt =
  (port: CandidateDevelopmentLocalAttemptPort): CandidateDevelopmentLocalAttempt =>
  (prepared) => {
    return Effect.gen(function* () {
      yield* port.reserve(
        prepared.receiptPath,
        makeCandidateDevelopmentLocalReceipt(prepared.source, 'RESERVED'),
        prepared.legacyReceiptPath,
      )
      return yield* port.execute(prepared).pipe(
        Effect.onExit((exit) =>
          port.finalize(
            prepared.receiptPath,
            makeCandidateDevelopmentLocalTerminalReceipt(
              prepared.source,
              Exit.isSuccess(exit)
                ? {
                    status: exit.value.decision.status,
                    terminalReportHash: exit.value.contentHash,
                  }
                : ({ status: 'FAILED', terminalReportHash: null } satisfies CandidateDevelopmentLocalTerminalOutcome),
            ),
          ),
        ),
        Effect.map((report) =>
          makeCandidateDevelopmentLocalTerminalReceipt(prepared.source, {
            status: report.decision.status,
            terminalReportHash: report.contentHash,
          }),
        ),
      )
    })
  }

const writeSynchronizedExclusiveFile = async (temporaryPath: string, content: string): Promise<void> => {
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const defaultLegacyReceiptPath = (path: string): string =>
  join(dirname(dirname(path)), legacyCandidateDevelopmentLocalReceiptName)

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (cause) {
    if (isFileSystemError(cause, 'ENOENT')) return false
    throw cause
  }
}

export const reserveCandidateDevelopmentLocalReceipt = (
  path: string,
  receipt: CandidateDevelopmentLocalAttemptReceipt,
  legacyReceiptPath = defaultLegacyReceiptPath(path),
): Effect.Effect<void, CandidateDevelopmentLocalError> =>
  Effect.tryPromise({
    try: async () => {
      if (await pathExists(legacyReceiptPath)) {
        throw localError(
          'RECEIPT_ALREADY_CONSUMED',
          'candidate development attempt was already consumed by the legacy local receipt',
        )
      }
      const markerPath = `${path}.reservation`
      try {
        await writeSynchronizedExclusiveFile(markerPath, serializeCandidateDevelopmentLocalReceipt(receipt))
      } catch (cause) {
        if (isFileSystemError(cause, 'EEXIST')) {
          throw localError('RECEIPT_ALREADY_CONSUMED', 'candidate development attempt was already consumed', cause)
        }
        throw cause
      }
      try {
        await link(markerPath, path)
      } catch (cause) {
        if (isFileSystemError(cause, 'EEXIST')) {
          await unlink(markerPath).catch(() => undefined)
          throw localError('RECEIPT_ALREADY_CONSUMED', 'candidate development attempt was already consumed', cause)
        }
        throw cause
      }
      await unlink(markerPath).catch(() => undefined)
    },
    catch: (cause) =>
      cause instanceof CandidateDevelopmentLocalError
        ? cause
        : localError('RECEIPT_RESERVATION_FAILED', 'candidate development attempt could not be reserved', cause),
  })

export const finalizeCandidateDevelopmentLocalReceipt = (
  path: string,
  receipt: CandidateDevelopmentLocalAttemptReceipt,
): Effect.Effect<void, CandidateDevelopmentLocalError> =>
  Effect.tryPromise({
    try: async () => {
      const temporaryPath = join(dirname(path), `.${receipt.candidateOrdinal}-${process.pid}-${randomUUID()}.tmp`)
      try {
        await writeSynchronizedExclusiveFile(temporaryPath, serializeCandidateDevelopmentLocalReceipt(receipt))
        await rename(temporaryPath, path)
      } catch (cause) {
        await unlink(temporaryPath).catch(() => undefined)
        throw cause
      }
    },
    catch: (cause) =>
      localError(
        'RECEIPT_FINALIZATION_FAILED',
        'candidate development receipt could not be finalized; do not retry',
        cause,
      ),
  })

const liveDependencies: CandidateDevelopmentLocalDependencies = {
  prepare: prepareCandidateDevelopmentLocalAttempt,
  attempt: makeCandidateDevelopmentLocalAttempt({
    reserve: reserveCandidateDevelopmentLocalReceipt,
    execute: executeCandidateDevelopmentCommand,
    finalize: finalizeCandidateDevelopmentLocalReceipt,
  }),
}

export const runCandidateDevelopmentLocally = (
  argv: readonly string[],
  dependencies: CandidateDevelopmentLocalDependencies = liveDependencies,
): Effect.Effect<
  CandidateDevelopmentLocalAttemptReceipt,
  CandidateDevelopmentLocalError | CandidateDevelopmentCommandFailure
> =>
  Effect.gen(function* () {
    const args = yield* Effect.fromResult(parseCandidateDevelopmentLocalArguments(argv))
    const prepared = yield* dependencies.prepare(args)
    return yield* dependencies.attempt(prepared)
  }).pipe(Effect.annotateLogs({ operation: 'candidate-development-local' }))

const renderLocalFailure = (failure: CandidateDevelopmentLocalError | CandidateDevelopmentCommandFailure): string =>
  failure instanceof CandidateDevelopmentLocalError
    ? `${JSON.stringify({
        schemaVersion: 'bayn.candidate-development-local-error.v1',
        code: failure.code,
        message: failure.message,
      })}\n`
    : renderCandidateDevelopmentCommandFailure(failure)

const reportCause = (
  cause: Cause.Cause<CandidateDevelopmentLocalError | CandidateDevelopmentCommandFailure>,
): Effect.Effect<void> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  const [reason] = cause.reasons
  const rendered =
    cause.reasons.length === 1 && reason !== undefined && Cause.isFailReason(reason)
      ? renderLocalFailure(reason.error)
      : renderCandidateDevelopmentCommandDefect()
  return Effect.sync(() => process.stderr.write(rendered))
}

class CandidateDevelopmentLocalCommandError extends Data.TaggedError('CandidateDevelopmentLocalCommandError')<{
  readonly cause: CandidateDevelopmentLocalError | CandidateDevelopmentCommandFailure
}> {}

export const runCandidateDevelopmentLocalMain = (argv: readonly string[]): void => {
  NodeRuntime.runMain(
    runCandidateDevelopmentLocally(argv).pipe(
      Effect.tap((receipt) =>
        Effect.sync(() => {
          process.stderr.write(`BAYN_CANDIDATE_DEVELOPMENT_LOCAL_RECEIPT=${JSON.stringify(receipt)}\n`)
        }),
      ),
      Effect.tapCause(reportCause),
      Effect.mapError((cause) => new CandidateDevelopmentLocalCommandError({ cause })),
    ),
    { disableErrorReporting: true },
  )
}

if (import.meta.main) runCandidateDevelopmentLocalMain(process.argv.slice(2))
