import { constants } from 'node:fs'
import { link, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import process from 'node:process'

import { NodeRuntime } from '@effect/platform-node'
import { Cause, Data, Effect, Exit } from 'effect'

import type {
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentCommandReport,
} from '../candidate-development-command/contracts'
import type {
  CandidateDevelopmentLoadedExecutableProgram,
  runCandidateDevelopmentCommand as runCandidateDevelopmentCommandType,
} from '../candidate-development-command/orchestration'
import type { CandidateDevelopmentSourceGit } from '../candidate-development-command/git-contracts'
import {
  renderCandidateDevelopmentCommandDefect,
  renderCandidateDevelopmentCommandFailure,
} from '../candidate-development-command/failures'
import { candidateDevelopmentSourceGit } from '../candidate-development-command/git-interpreter'
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
  readonly legacyReceiptPaths: readonly string[]
  readonly source: CandidateDevelopmentLocalSourceBinding
}

export interface CandidateDevelopmentLocalReceiptReservationContext {
  readonly repositoryRoot: string
  readonly sourceGit?: CandidateDevelopmentSourceGit
  readonly legacyReceiptPaths?: readonly string[]
}

export interface CandidateDevelopmentLocalAttemptPort {
  reserve: (
    path: string,
    receipt: CandidateDevelopmentLocalAttemptReceipt,
    legacyReceiptPath?: string,
    context?: CandidateDevelopmentLocalReceiptReservationContext,
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

type CandidateDevelopmentCommandRunner = typeof runCandidateDevelopmentCommandType

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
  expectedSourceRevision?: string,
): Effect.Effect<void, CandidateDevelopmentLocalError> =>
  Effect.tryPromise({
    try: async (signal) => {
      if (expectedSourceRevision !== undefined) {
        const sourceRevision = await sourceGit.text(repositoryRoot, ['rev-parse', 'HEAD'], signal)
        if (sourceRevision !== expectedSourceRevision) throw new Error('source revision changed during the attempt')
      }
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
  runCommand: CandidateDevelopmentCommandRunner,
  loaded: CandidateDevelopmentLoadedExecutableProgram,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure> =>
  runCommand(loaded.program, loaded.verifiedSource).pipe(
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
  const verifySourceTree = verifyCandidateDevelopmentLocalSourceTree(
    prepared.repositoryRoot,
    sourcePaths,
    candidateDevelopmentSourceGit,
    prepared.source.sourceRevision,
  )
  const loadInterpreter = Effect.tryPromise({
    try: async () => {
      const [sandbox, orchestration, sourceProvenance] = await Promise.all([
        import('../candidate-development-command/sandbox'),
        import('../candidate-development-command/orchestration'),
        import('../candidate-development-command/source-provenance-policy'),
      ])
      return { sandbox, orchestration, sourceProvenance }
    },
    catch: (cause) => localError('SOURCE_BINDING_INVALID', 'candidate development interpreter is unavailable', cause),
  })
  return verifySourceTree.pipe(
    Effect.flatMap(() => loadInterpreter),
    Effect.flatMap(({ sandbox, orchestration, sourceProvenance }) =>
      orchestration
        .loadAuthorizedCandidateDevelopmentExecutableProgram(
          prepared.args.modulePath,
          prepared.args.sourceManifestPath,
          (module, manifest) =>
            orchestration.loadCandidateDevelopmentExecutableProgram(
              module,
              manifest,
              sandbox.evaluateCandidateDevelopmentArtifact,
              (sourceModulePath, sourceManifest, sourceGit) =>
                sourceProvenance.verifyCandidateDevelopmentSourceFiles(
                  sourceModulePath,
                  sourceManifest,
                  sourceGit,
                  prepared.source.sourceRevision,
                ),
              sandbox.loadCandidateDevelopmentRuntimeMarketDataFile(prepared.args.runtimeMarketDataPath),
            ),
        )
        .pipe(Effect.map((loaded) => ({ loaded, runCommand: orchestration.runCandidateDevelopmentCommand }))),
    ),
    Effect.tap(() =>
      verifyCandidateDevelopmentLocalSourceTree(
        prepared.repositoryRoot,
        sourcePaths,
        candidateDevelopmentSourceGit,
        prepared.source.sourceRevision,
      ),
    ),
    Effect.flatMap(({ loaded, runCommand }) => executeLoadedCandidateDevelopmentProgram(runCommand, loaded)),
    Effect.tap(() =>
      verifyCandidateDevelopmentLocalSourceTree(
        prepared.repositoryRoot,
        sourcePaths,
        candidateDevelopmentSourceGit,
        prepared.source.sourceRevision,
      ),
    ),
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
    const sourceRevision = yield* Effect.tryPromise({
      try: async (signal) => {
        const revision = await candidateDevelopmentSourceGit.text(repositoryRoot, ['rev-parse', 'HEAD'], signal)
        if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('candidate source revision is invalid')
        return revision
      },
      catch: (cause) => localError('SOURCE_BINDING_INVALID', 'candidate source revision is unavailable', cause),
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
    yield* verifyCandidateDevelopmentLocalSourceTree(
      repositoryRoot,
      sourcePaths,
      candidateDevelopmentSourceGit,
      sourceRevision,
    )
    const verifySourceFiles = yield* Effect.tryPromise({
      try: async () =>
        (await import('../candidate-development-command/source-provenance-policy'))
          .verifyCandidateDevelopmentSourceFiles,
      catch: (cause) => localError('SOURCE_BINDING_INVALID', 'candidate source verifier is unavailable', cause),
    })
    const verified = yield* verifySourceFiles(
      normalizedArgs.modulePath,
      normalizedArgs.sourceManifestPath,
      candidateDevelopmentSourceGit,
      sourceRevision,
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
        const worktreeList = await candidateDevelopmentSourceGit.text(
          repositoryRoot,
          ['worktree', 'list', '--porcelain'],
          signal,
        )
        const worktreeRoots = worktreeList
          .split('\n\n')
          .map((record) =>
            record
              .split('\n')
              .find((line) => line.startsWith('worktree '))
              ?.slice('worktree '.length),
          )
          .filter((worktreeRoot): worktreeRoot is string => worktreeRoot !== undefined && worktreeRoot.length > 0)
        if (worktreeRoots.length === 0) throw new Error('candidate worktree list is empty')
        const legacyReceiptPaths = await Promise.all(
          worktreeRoots.map(async (worktreeRoot) => {
            const canonicalWorktreeRoot = await realpath(resolve(repositoryRoot, worktreeRoot))
            return resolve(
              canonicalWorktreeRoot,
              await candidateDevelopmentSourceGit.text(
                canonicalWorktreeRoot,
                ['rev-parse', '--git-path', legacyCandidateDevelopmentLocalReceiptName],
                signal,
              ),
            )
          }),
        )
        return {
          attempt: join(receiptDirectory, `ordinal-${source.candidateOrdinal}.json`),
          legacy: legacyReceiptPath,
          legacyPaths: [...new Set([legacyReceiptPath, ...legacyReceiptPaths])],
        }
      },
      catch: (cause) => localError('RECEIPT_RESERVATION_FAILED', 'candidate receipt path is unavailable', cause),
    })
    return {
      repositoryRoot,
      args: normalizedArgs,
      receiptPath: receiptPaths.attempt,
      legacyReceiptPath: receiptPaths.legacy,
      legacyReceiptPaths: receiptPaths.legacyPaths,
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
        {
          repositoryRoot: prepared.repositoryRoot,
          legacyReceiptPaths: prepared.legacyReceiptPaths,
        },
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

const writeReservationMarker = async (markerPath: string, content: string): Promise<void> => {
  const marker = await open(
    markerPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await marker.writeFile(content, 'utf8')
    await marker.sync()
  } finally {
    await marker.close()
  }
}

const writeFinalizationTemporary = async (temporaryPath: string, content: string): Promise<void> => {
  const temporary = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await temporary.writeFile(content, 'utf8')
    await temporary.sync()
  } finally {
    await temporary.close()
  }
}

const syncReceiptDirectory = async (path: string): Promise<void> => {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

const defaultLegacyReceiptPath = (path: string): string =>
  join(dirname(dirname(path)), legacyCandidateDevelopmentLocalReceiptName)

const legacyReceiptSourceFields = [
  'sourceRevision',
  'modulePath',
  'moduleBlobOid',
  'moduleSha256',
  'sourceManifestPath',
  'sourceManifestBlobOid',
  'sourceManifestSha256',
  'bindingHash',
] as const

type LegacyReceiptInspection = 'ABSENT' | 'MATCHING_SOURCE' | 'DIFFERENT_SOURCE'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const inspectLegacyCandidateDevelopmentLocalReceipt = async (
  path: string,
  candidateOrdinal: number,
  context: CandidateDevelopmentLocalReceiptReservationContext | undefined,
): Promise<LegacyReceiptInspection> => {
  let serialized: string
  try {
    serialized = await readFile(path, 'utf8')
  } catch (cause) {
    if (isFileSystemError(cause, 'ENOENT')) return 'ABSENT'
    throw localError('RECEIPT_ALREADY_CONSUMED', 'legacy local receipt could not be inspected')
  }

  let value: unknown
  try {
    value = JSON.parse(serialized) as unknown
  } catch {
    throw localError('RECEIPT_ALREADY_CONSUMED', 'legacy local receipt is invalid')
  }
  if (!isRecord(value) || value.schemaVersion !== 'bayn.candidate-development-local-attempt.v1') {
    throw localError('RECEIPT_ALREADY_CONSUMED', 'legacy local receipt is invalid')
  }
  const exitCode = value.exitCode
  if (
    value.attempt !== 1 ||
    (value.status !== 'reserved' && value.status !== 'completed' && value.status !== 'failed') ||
    (exitCode !== undefined && (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0))
  ) {
    throw localError('RECEIPT_ALREADY_CONSUMED', 'legacy local receipt is invalid')
  }
  const legacySourceValue = value.source
  if (
    !isRecord(legacySourceValue) ||
    legacyReceiptSourceFields.some((field) => typeof legacySourceValue[field] !== 'string')
  ) {
    throw localError('RECEIPT_ALREADY_CONSUMED', 'legacy local receipt is invalid')
  }
  const legacySource = {
    sourceRevision: legacySourceValue.sourceRevision as string,
    modulePath: legacySourceValue.modulePath as string,
    moduleBlobOid: legacySourceValue.moduleBlobOid as string,
    moduleSha256: legacySourceValue.moduleSha256 as string,
    sourceManifestPath: legacySourceValue.sourceManifestPath as string,
    sourceManifestBlobOid: legacySourceValue.sourceManifestBlobOid as string,
    sourceManifestSha256: legacySourceValue.sourceManifestSha256 as string,
  }
  if (
    !/^[0-9a-f]{40}$/.test(legacySource.sourceRevision) ||
    !/^[0-9a-f]{40}$/.test(legacySource.moduleBlobOid) ||
    !/^[0-9a-f]{64}$/.test(legacySource.moduleSha256) ||
    !/^[0-9a-f]{40}$/.test(legacySource.sourceManifestBlobOid) ||
    !/^[0-9a-f]{64}$/.test(legacySource.sourceManifestSha256) ||
    legacySource.modulePath.length === 0 ||
    legacySource.sourceManifestPath.length === 0 ||
    legacySource.modulePath.includes('\u0000') ||
    legacySource.sourceManifestPath.includes('\u0000') ||
    legacySource.modulePath.includes('\n') ||
    legacySource.modulePath.includes('\r') ||
    legacySource.sourceManifestPath.includes('\n') ||
    legacySource.sourceManifestPath.includes('\r') ||
    legacySource.modulePath.startsWith('/') ||
    legacySource.sourceManifestPath.startsWith('/') ||
    legacySource.modulePath.split('/').some((part) => part === '' || part === '..') ||
    legacySource.sourceManifestPath.split('/').some((part) => part === '' || part === '..') ||
    !/^[0-9a-f]{64}$/.test(legacySourceValue.bindingHash as string)
  ) {
    throw localError('RECEIPT_ALREADY_CONSUMED', 'legacy local receipt is invalid')
  }
  const expectedBindingHash = createHash('sha256')
    .update(
      JSON.stringify([
        'bayn.candidate-development-local-source-binding.v1',
        legacySource.sourceRevision,
        legacySource.modulePath,
        legacySource.moduleBlobOid,
        legacySource.moduleSha256,
        legacySource.sourceManifestPath,
        legacySource.sourceManifestBlobOid,
        legacySource.sourceManifestSha256,
      ]),
      'utf8',
    )
    .digest('hex')
  if (legacySourceValue.bindingHash !== expectedBindingHash) {
    throw localError('RECEIPT_ALREADY_CONSUMED', 'legacy local receipt is invalid')
  }
  if (context === undefined) {
    throw localError('RECEIPT_ALREADY_CONSUMED', 'legacy local receipt cannot be verified')
  }
  try {
    const sourceGit = context.sourceGit ?? candidateDevelopmentSourceGit
    const manifestSpec = `${legacySource.sourceRevision}:${legacySource.sourceManifestPath}`
    const manifestBlobOid = await sourceGit.text(context.repositoryRoot, ['rev-parse', manifestSpec])
    if (manifestBlobOid !== legacySource.sourceManifestBlobOid) {
      throw new Error('legacy source manifest blob changed')
    }
    const manifestSource = await sourceGit.bytes(context.repositoryRoot, ['cat-file', 'blob', manifestSpec])
    const manifest = JSON.parse(manifestSource.toString('utf8')) as unknown
    if (!isRecord(manifest)) throw new Error('legacy source manifest is invalid')
    const manifestCandidateOrdinal = manifest.candidateOrdinal
    if (
      typeof manifestCandidateOrdinal !== 'number' ||
      !Number.isSafeInteger(manifestCandidateOrdinal) ||
      manifestCandidateOrdinal < 1
    ) {
      throw new Error('legacy source manifest ordinal is invalid')
    }
    return manifestCandidateOrdinal === candidateOrdinal ? 'MATCHING_SOURCE' : 'DIFFERENT_SOURCE'
  } catch (cause) {
    if (cause instanceof CandidateDevelopmentLocalError) throw cause
    throw localError('RECEIPT_ALREADY_CONSUMED', 'legacy local receipt could not be verified', cause)
  }
}

export const reserveCandidateDevelopmentLocalReceipt = (
  path: string,
  receipt: CandidateDevelopmentLocalAttemptReceipt,
  legacyReceiptPath = defaultLegacyReceiptPath(path),
  context?: CandidateDevelopmentLocalReceiptReservationContext,
): Effect.Effect<void, CandidateDevelopmentLocalError> =>
  Effect.tryPromise({
    try: async () => {
      const legacyReceiptPaths = [...new Set([legacyReceiptPath, ...(context?.legacyReceiptPaths ?? [])])]
      const legacyReceipts = await Promise.all(
        legacyReceiptPaths.map((candidateLegacyReceiptPath) =>
          inspectLegacyCandidateDevelopmentLocalReceipt(candidateLegacyReceiptPath, receipt.candidateOrdinal, context),
        ),
      )
      if (legacyReceipts.some((legacyReceipt) => legacyReceipt === 'MATCHING_SOURCE')) {
        throw localError(
          'RECEIPT_ALREADY_CONSUMED',
          'candidate development attempt was already consumed by the legacy local receipt',
        )
      }
      const markerPath = `${path}.reservation`
      try {
        await writeReservationMarker(markerPath, serializeCandidateDevelopmentLocalReceipt(receipt))
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
      await syncReceiptDirectory(dirname(path))
      await unlink(markerPath)
      await syncReceiptDirectory(dirname(path))
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
        await writeFinalizationTemporary(temporaryPath, serializeCandidateDevelopmentLocalReceipt(receipt))
        await rename(temporaryPath, path)
        await syncReceiptDirectory(dirname(path))
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
