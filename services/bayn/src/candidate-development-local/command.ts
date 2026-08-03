import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { NodeRuntime } from '@effect/platform-node'
import { Cause, Data, Effect, Exit, Result } from 'effect'

import {
  activeCandidateDevelopmentRegistration,
  candidateDevelopmentTrialLedgerState,
  type CandidateDevelopmentNextPreregistration,
} from '../candidate-development-calendar'
import { makeRuntimeProvenanceResult, makeStrategyProtocolHash, type RuntimeProvenance } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import { hashParameters } from '../protocol'
import {
  analyzeQualificationAtOrdinal,
  defaultQualificationStatisticsPolicy,
  prepareQualificationSeries,
} from '../qualification-statistics'
import {
  evaluateStrategyApplication,
  hashEvaluationTargets,
  hashStrategyEvaluation,
} from '../strategy/evaluation-runner'
import {
  bindReviewedStrategySource,
  makeActiveStrategyApplication,
  type StrategyApplication,
  type StrategyDefinition,
} from '../strategy'
import { qualificationDormancyDecisionFromLedgerState } from '../candidate-development-trials/qualification-dormancy'
import {
  bindCandidateDevelopmentLocalSource,
  CandidateDevelopmentLocalError,
  decodeCandidateDevelopmentRuntimeMarketDataWitness,
  decodeCandidateDevelopmentSourceManifest,
  makeCandidateDevelopmentLocalTerminalReport,
  makeCandidateDevelopmentLocalReceipt,
  makeCandidateDevelopmentLocalTerminalReceipt,
  makeCandidateDevelopmentLocalTerminalReportHash,
  parseCandidateDevelopmentLocalArguments,
  serializeCandidateDevelopmentLocalReceipt,
  witnessContentHash,
  type CandidateDevelopmentLocalArguments,
  type CandidateDevelopmentLocalAttemptReceipt,
  type CandidateDevelopmentLocalSourceManifestBinding,
  type CandidateDevelopmentLocalSourceBinding,
  type CandidateDevelopmentLocalTerminalOutcome,
  type CandidateDevelopmentRuntimeMarketDataWitness,
  type CandidateDevelopmentSourceManifest,
} from './domain'

const candidateDevelopmentEvaluatorSourcePath = 'services/bayn/src'

export interface CandidateDevelopmentSourceGit {
  readonly text: (repositoryRoot: string, args: readonly string[], signal?: AbortSignal) => Promise<string>
  readonly bytes: (repositoryRoot: string, args: readonly string[], signal?: AbortSignal) => Promise<Buffer>
}

const gitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))

const execGit = (
  executable: 'git',
  repositoryRoot: string,
  args: readonly string[],
  encoding: 'utf8' | 'buffer',
  signal?: AbortSignal,
): Promise<string | Buffer> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      executable,
      ['--no-replace-objects', '-C', repositoryRoot, ...args],
      {
        encoding,
        env: gitEnvironment(),
        maxBuffer: encoding === 'buffer' ? 64 * 1024 * 1024 : 16 * 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        if (error === null) resolveGit(stdout)
        else rejectGit(error)
      },
    )
  })

export const candidateDevelopmentSourceGit: CandidateDevelopmentSourceGit = {
  text: async (repositoryRoot, args, signal) =>
    String(await execGit('git', repositoryRoot, args, 'utf8', signal)).trim(),
  bytes: async (repositoryRoot, args, signal) =>
    Buffer.from(await execGit('git', repositoryRoot, args, 'buffer', signal)),
}

export interface PreparedCandidateDevelopmentLocalAttempt {
  readonly repositoryRoot: string
  readonly args: CandidateDevelopmentLocalArguments
  readonly receiptPath: string
  readonly source: CandidateDevelopmentLocalSourceBinding
  readonly sourceManifest: CandidateDevelopmentSourceManifest
  /** The exact source-controlled application used by the terminal evaluator. */
  readonly application: StrategyApplication<any, any, any>
  /** Compatibility projection retained for archived receipt/test consumers. */
  readonly definition: StrategyDefinition<any, any, any>
  readonly provenance: RuntimeProvenance
}

export interface CandidateDevelopmentLocalAttemptPort {
  readonly reserve: (
    path: string,
    receipt: CandidateDevelopmentLocalAttemptReceipt,
  ) => Effect.Effect<void, CandidateDevelopmentLocalError>
  readonly execute: (
    prepared: PreparedCandidateDevelopmentLocalAttempt,
  ) => Effect.Effect<CandidateDevelopmentLocalTerminalOutcome, CandidateDevelopmentLocalError>
  readonly finalize: (
    path: string,
    receipt: CandidateDevelopmentLocalAttemptReceipt,
  ) => Effect.Effect<void, CandidateDevelopmentLocalError>
}

export type CandidateDevelopmentLocalAttempt = (
  prepared: PreparedCandidateDevelopmentLocalAttempt,
) => Effect.Effect<CandidateDevelopmentLocalAttemptReceipt, CandidateDevelopmentLocalError>

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

const sha256Bytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const sourceTreePaths = (modulePath: string, sourceManifestPath: string): readonly string[] => [
  modulePath,
  sourceManifestPath,
  candidateDevelopmentEvaluatorSourcePath,
]

export const verifyCandidateDevelopmentLocalSourceTree = (
  repositoryRoot: string,
  paths: readonly string[],
  sourceGit: CandidateDevelopmentSourceGit = candidateDevelopmentSourceGit,
  expectedSourceRevision?: string,
): Effect.Effect<void, CandidateDevelopmentLocalError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const currentRevision = await sourceGit.text(repositoryRoot, ['rev-parse', 'HEAD'], signal)
      if (expectedSourceRevision !== undefined && currentRevision !== expectedSourceRevision) {
        throw new Error('source revision changed during the attempt')
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

const decodeJson = (bytes: Buffer, message: string): Result.Result<unknown, CandidateDevelopmentLocalError> => {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return Result.succeed(value)
  } catch (cause) {
    return Result.fail(localError('SOURCE_BINDING_INVALID', message, cause))
  }
}

const verifySourceManifest = (
  value: unknown,
  modulePath: string,
  moduleSha256: string,
): Result.Result<CandidateDevelopmentSourceManifest, CandidateDevelopmentLocalError> => {
  const decoded = decodeCandidateDevelopmentSourceManifest(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(localError('SOURCE_BINDING_INVALID', 'candidate source manifest is invalid', decoded.failure))
  }
  if (decoded.success.modulePath !== modulePath) {
    return Result.fail(localError('SOURCE_BINDING_INVALID', 'candidate source manifest module path is not exact'))
  }
  if (decoded.success.moduleSha256 !== moduleSha256) {
    return Result.fail(localError('SOURCE_BINDING_INVALID', 'candidate source manifest module hash is not exact'))
  }
  if (!modulePath.endsWith('.ts')) {
    return Result.fail(localError('SOURCE_BINDING_INVALID', 'candidate module must be a TypeScript source file'))
  }
  if (decoded.success.candidateOrdinal !== decoded.success.priorTrialCount + 1) {
    return Result.fail(localError('SOURCE_BINDING_INVALID', 'candidate source manifest trial lineage is not exact'))
  }
  return Result.succeed(decoded.success)
}

export const verifyCandidateDevelopmentSourceManifest = (
  sourceManifest: CandidateDevelopmentSourceManifest,
  preregistration: CandidateDevelopmentNextPreregistration,
): Result.Result<void, CandidateDevelopmentLocalError> => {
  const mismatched =
    sourceManifest.candidateOrdinal !== preregistration.candidateOrdinal ||
    sourceManifest.priorTrialCount !== preregistration.priorTrialCount ||
    sourceManifest.trialHistoryHash !== preregistration.priorTrialsHash ||
    sourceManifest.strategyProtocolHash !== preregistration.strategyProtocolHash ||
    sourceManifest.modulePath !== preregistration.modulePath ||
    sourceManifest.moduleSha256 !== preregistration.moduleSha256 ||
    sourceManifest.marketData.snapshotId !== preregistration.marketData.snapshotId ||
    sourceManifest.marketData.inputManifestHash !== preregistration.marketData.inputManifestHash ||
    sourceManifest.marketData.boundedContentHash !== preregistration.marketData.boundedContentHash
  return mismatched
    ? Result.fail(
        localError(
          'SOURCE_BINDING_INVALID',
          'candidate source manifest does not match the frozen preregistered trial successor',
        ),
      )
    : Result.succeed(undefined)
}

export const verifyCandidateDevelopmentSourceManifestBinding = (
  observed: CandidateDevelopmentLocalSourceManifestBinding,
  expected: CandidateDevelopmentLocalSourceManifestBinding,
): Result.Result<void, CandidateDevelopmentLocalError> =>
  observed.path === expected.path && observed.blobOid === expected.blobOid && observed.sha256 === expected.sha256
    ? Result.succeed(undefined)
    : Result.fail(localError('SOURCE_BINDING_INVALID', 'candidate source manifest object is not the reviewed object'))

const loadFrozenCandidateDevelopmentPreregistration = (): Result.Result<
  CandidateDevelopmentNextPreregistration,
  CandidateDevelopmentLocalError
> => {
  const active = activeCandidateDevelopmentRegistration
  return active === null
    ? Result.fail(localError('MODULE_INVALID', 'no preregistered candidate development successor is available'))
    : (() => {
        const lifecycle = qualificationDormancyDecisionFromLedgerState(candidateDevelopmentTrialLedgerState)
        return lifecycle.ok &&
          lifecycle.decision.status === 'dormant' &&
          lifecycle.decision.reason === 'development-not-approved'
          ? Result.succeed(active.preregistration)
          : Result.fail(
              localError(
                'MODULE_INVALID',
                'the active candidate development registration has already consumed or terminalized its attempt',
              ),
            )
      })()
}

const readReviewedSource = async (
  repositoryRoot: string,
  modulePath: string,
  sourceManifestPath: string,
  sourceRevision: string,
  sourceGit: CandidateDevelopmentSourceGit,
  signal: AbortSignal,
): Promise<{
  readonly moduleBytes: Buffer
  readonly moduleBlobOid: string
  readonly sourceManifestBytes: Buffer
  readonly sourceManifestBlobOid: string
}> => {
  const moduleSpec = `${sourceRevision}:${modulePath}`
  const sourceManifestSpec = `${sourceRevision}:${sourceManifestPath}`
  const [moduleBytes, moduleBlobOid, sourceManifestBytes, sourceManifestBlobOid] = await Promise.all([
    sourceGit.bytes(repositoryRoot, ['cat-file', 'blob', moduleSpec], signal),
    sourceGit.text(repositoryRoot, ['rev-parse', moduleSpec], signal),
    sourceGit.bytes(repositoryRoot, ['cat-file', 'blob', sourceManifestSpec], signal),
    sourceGit.text(repositoryRoot, ['rev-parse', sourceManifestSpec], signal),
  ])
  return { moduleBytes, moduleBlobOid, sourceManifestBytes, sourceManifestBlobOid }
}

const receiptPathFor = async (
  repositoryRoot: string,
  candidateOrdinal: number,
  sourceGit: CandidateDevelopmentSourceGit,
) => {
  const commonDirectory = await realpath(
    resolve(repositoryRoot, await sourceGit.text(repositoryRoot, ['rev-parse', '--git-common-dir'])),
  )
  const receiptDirectory = resolve(commonDirectory, 'bayn', 'candidate-development-attempts')
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
  if ((await realpath(receiptDirectory)) !== receiptDirectory)
    throw new Error('candidate receipt directory is not canonical')
  return resolve(receiptDirectory, `ordinal-${candidateOrdinal}.json`)
}

const prepareCandidateDevelopmentLocalAttempt = (
  args: CandidateDevelopmentLocalArguments,
  application: StrategyApplication<any, any, any>,
  sourceManifestBinding: CandidateDevelopmentLocalSourceManifestBinding,
  sourceGit: CandidateDevelopmentSourceGit = candidateDevelopmentSourceGit,
): Effect.Effect<PreparedCandidateDevelopmentLocalAttempt, CandidateDevelopmentLocalError> =>
  Effect.gen(function* () {
    const preregistration = yield* Effect.fromResult(loadFrozenCandidateDevelopmentPreregistration())
    const repositoryRoot = yield* Effect.tryPromise({
      try: async (signal) => realpath(await sourceGit.text(process.cwd(), ['rev-parse', '--show-toplevel'], signal)),
      catch: (cause) => localError('SOURCE_BINDING_INVALID', 'candidate repository root is unavailable', cause),
    })
    const sourceRevision = yield* Effect.tryPromise({
      try: async (signal) => {
        const revision = await sourceGit.text(repositoryRoot, ['rev-parse', 'HEAD'], signal)
        if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('candidate source revision is invalid')
        return revision
      },
      catch: (cause) => localError('SOURCE_BINDING_INVALID', 'candidate source revision is unavailable', cause),
    })
    const normalizedArgs = resolveCandidateDevelopmentLocalArguments(repositoryRoot, args)
    const canonicalArgs = yield* Effect.tryPromise({
      try: async () => ({
        ...normalizedArgs,
        modulePath: await realpath(normalizedArgs.modulePath),
        sourceManifestPath: await realpath(normalizedArgs.sourceManifestPath),
      }),
      catch: (cause) =>
        localError('SOURCE_BINDING_INVALID', 'candidate module and source manifest paths are unavailable', cause),
    })
    const modulePath = yield* Effect.try({
      try: () => repositoryRelativePath(repositoryRoot, canonicalArgs.modulePath, 'module'),
      catch: (cause) =>
        cause instanceof CandidateDevelopmentLocalError
          ? cause
          : localError('SOURCE_BINDING_INVALID', 'candidate module path is invalid', cause),
    })
    const sourceManifestPath = yield* Effect.try({
      try: () => repositoryRelativePath(repositoryRoot, canonicalArgs.sourceManifestPath, 'source manifest'),
      catch: (cause) =>
        cause instanceof CandidateDevelopmentLocalError
          ? cause
          : localError('SOURCE_BINDING_INVALID', 'candidate source manifest path is invalid', cause),
    })
    yield* verifyCandidateDevelopmentLocalSourceTree(
      repositoryRoot,
      sourceTreePaths(modulePath, sourceManifestPath),
      sourceGit,
      sourceRevision,
    )
    const source = yield* Effect.tryPromise({
      try: async (signal) => {
        const trackedModule = await sourceGit.text(
          repositoryRoot,
          ['ls-files', '--error-unmatch', '--', modulePath],
          signal,
        )
        const trackedManifest = await sourceGit.text(
          repositoryRoot,
          ['ls-files', '--error-unmatch', '--', sourceManifestPath],
          signal,
        )
        if (trackedModule !== modulePath || trackedManifest !== sourceManifestPath) {
          throw new Error('candidate source files are not tracked')
        }
        const reviewed = await readReviewedSource(
          repositoryRoot,
          modulePath,
          sourceManifestPath,
          sourceRevision,
          sourceGit,
          signal,
        )
        const sourceManifestBindingResult = verifyCandidateDevelopmentSourceManifestBinding(
          {
            path: sourceManifestPath,
            blobOid: reviewed.sourceManifestBlobOid,
            sha256: sha256Bytes(reviewed.sourceManifestBytes),
          },
          sourceManifestBinding,
        )
        if (Result.isFailure(sourceManifestBindingResult)) throw sourceManifestBindingResult.failure
        const manifestValue = decodeJson(reviewed.sourceManifestBytes, 'candidate source manifest is not valid JSON')
        if (Result.isFailure(manifestValue)) throw manifestValue.failure
        const manifest = verifySourceManifest(manifestValue.success, modulePath, sha256Bytes(reviewed.moduleBytes))
        if (Result.isFailure(manifest)) throw manifest.failure
        const lineage = verifyCandidateDevelopmentSourceManifest(manifest.success, preregistration)
        if (Result.isFailure(lineage)) throw lineage.failure
        if (manifest.success.moduleFormat !== 'typescript-strategy-definition-v1') {
          throw new Error('candidate module format is unsupported')
        }
        const bound = bindCandidateDevelopmentLocalSource({
          sourceRevision,
          modulePath,
          moduleBlobOid: reviewed.moduleBlobOid,
          moduleSha256: sha256Bytes(reviewed.moduleBytes),
          sourceManifestPath,
          sourceManifestBlobOid: reviewed.sourceManifestBlobOid,
          sourceManifestSha256: sha256Bytes(reviewed.sourceManifestBytes),
          sourceManifest: manifest.success,
        })
        if (Result.isFailure(bound)) throw bound.failure
        const provenance = makeCandidateProvenance(application.definition, bound.success)
        if (Result.isFailure(provenance)) throw provenance.failure
        const binding = verifyCandidateBinding(
          application,
          application.definition,
          bound.success,
          manifest.success,
          provenance.success,
        )
        if (Result.isFailure(binding)) throw binding.failure
        return { source: bound.success, sourceManifest: manifest.success, provenance: provenance.success }
      },
      catch: (cause) =>
        cause instanceof CandidateDevelopmentLocalError
          ? cause
          : localError('SOURCE_BINDING_INVALID', 'candidate source binding is invalid', cause),
    })
    const receiptPath = yield* Effect.tryPromise({
      try: () => receiptPathFor(repositoryRoot, source.sourceManifest.candidateOrdinal, sourceGit),
      catch: (cause) => localError('RECEIPT_RESERVATION_FAILED', 'candidate receipt path is unavailable', cause),
    })
    return {
      repositoryRoot,
      args: canonicalArgs,
      receiptPath,
      source: source.source,
      sourceManifest: source.sourceManifest,
      application,
      definition: application.definition,
      provenance: source.provenance,
    }
  })

const readWitness = (
  path: string,
): Effect.Effect<CandidateDevelopmentRuntimeMarketDataWitness, CandidateDevelopmentLocalError> =>
  Effect.tryPromise({
    try: async () => {
      const bytes = await readFile(path)
      let value: unknown
      try {
        value = JSON.parse(bytes.toString('utf8'))
      } catch (cause) {
        throw localError('WITNESS_INVALID', 'frozen development witness is not valid JSON', cause)
      }
      const decoded = decodeCandidateDevelopmentRuntimeMarketDataWitness(value)
      if (Result.isFailure(decoded))
        throw localError('WITNESS_INVALID', 'frozen development witness is invalid', decoded.failure)
      const { contentHash, ...content } = decoded.success
      const recomputed = witnessContentHash(content)
      if (Result.isFailure(recomputed) || recomputed.success !== contentHash) {
        throw localError('WITNESS_INVALID', 'frozen development witness content hash is not exact')
      }
      return decoded.success
    },
    catch: (cause) =>
      cause instanceof CandidateDevelopmentLocalError
        ? cause
        : localError('WITNESS_INVALID', 'frozen development witness could not be decoded', cause),
  })

const makeCandidateProvenance = (
  definition: StrategyDefinition<any, any, any>,
  source: CandidateDevelopmentLocalSourceBinding,
): Result.Result<RuntimeProvenance, CandidateDevelopmentLocalError> => {
  const parameterHash = hashParameters(definition.parameters)
  const provenance = makeRuntimeProvenanceResult({
    sourceRevision: source.sourceRevision,
    image: {
      repository: 'registry.local/bayn-candidate-development',
      digest: `sha256:${source.moduleSha256}`,
    },
    strategy: {
      name: definition.name,
      behaviorHash: source.moduleSha256,
      parameterHash,
      parameterSchemaVersion: definition.parameters.schemaVersion,
    },
  })
  return Result.isFailure(provenance)
    ? Result.fail(localError('MODULE_INVALID', 'candidate runtime provenance is invalid', provenance.failure))
    : Result.succeed(provenance.success)
}

const verifyCandidateBinding = (
  application: StrategyApplication<any, any, any>,
  definition: StrategyDefinition<any, any, any>,
  source: CandidateDevelopmentLocalSourceBinding,
  sourceManifest: CandidateDevelopmentSourceManifest,
  provenance: RuntimeProvenance,
): Result.Result<void, CandidateDevelopmentLocalError> => {
  if (
    application.reviewedSource === undefined ||
    application.reviewedSource.modulePath !== source.modulePath ||
    application.reviewedSource.moduleSha256 !== source.moduleSha256
  ) {
    return Result.fail(
      localError('SOURCE_BINDING_INVALID', 'candidate application is not the reviewed source module export'),
    )
  }
  if (definition.name !== sourceManifest.strategyName) {
    return Result.fail(localError('SOURCE_BINDING_INVALID', 'candidate definition does not match the source manifest'))
  }
  const observed = makeStrategyProtocolHash(provenance.strategy)
  return observed === sourceManifest.strategyProtocolHash
    ? Result.succeed(undefined)
    : Result.fail(
        localError('SOURCE_BINDING_INVALID', 'candidate definition protocol does not match the source manifest'),
      )
}

export const candidateDevelopmentTerminalStatus = (
  economicStatus: 'PASS' | 'FAIL_CLOSED',
  qualificationStatus: 'PASS' | 'REJECTED' | 'INSUFFICIENT',
): 'PASS' | 'HOLD_REJECT' => (economicStatus === 'PASS' && qualificationStatus === 'PASS' ? 'PASS' : 'HOLD_REJECT')

export const evaluateCandidateDevelopmentApplication = (
  application: StrategyApplication<any, any, any>,
  witness: CandidateDevelopmentRuntimeMarketDataWitness,
  source: CandidateDevelopmentLocalSourceBinding,
  sourceManifest: CandidateDevelopmentSourceManifest,
): Result.Result<CandidateDevelopmentLocalTerminalOutcome, CandidateDevelopmentLocalError> => {
  const definition = application.definition
  const provenance = makeCandidateProvenance(definition, source)
  if (Result.isFailure(provenance)) {
    return Result.fail(provenance.failure)
  }
  const binding = verifyCandidateBinding(application, definition, source, sourceManifest, provenance.success)
  if (Result.isFailure(binding)) {
    return Result.fail(binding.failure)
  }
  const evaluation = evaluateStrategyApplication({
    application,
    provenance: provenance.success,
    bars: witness.bars,
    inputManifest: witness.inputManifest,
  })
  if (Result.isFailure(evaluation)) {
    return Result.fail(localError('DECISION_FAILED', 'candidate strategy evaluation failed', evaluation.failure))
  }
  const analysis = prepareQualificationSeries(evaluation.success).pipe(
    Result.flatMap((series) =>
      analyzeQualificationAtOrdinal(series, defaultQualificationStatisticsPolicy, {
        candidateOrdinal: sourceManifest.candidateOrdinal,
        priorTrialCount: sourceManifest.priorTrialCount,
        priorTrialsHash: sourceManifest.trialHistoryHash,
      }),
    ),
  )
  if (Result.isFailure(analysis)) {
    return Result.fail(localError('DECISION_FAILED', 'candidate qualification statistics failed', analysis.failure))
  }
  const evaluationHash = hashStrategyEvaluation(evaluation.success)
  const targetHash = hashEvaluationTargets(evaluation.success)
  const qualificationAnalysisHash = canonicalHashV1Result(analysis.success)
  if (Result.isFailure(evaluationHash) || Result.isFailure(targetHash) || Result.isFailure(qualificationAnalysisHash)) {
    return Result.fail(localError('DECISION_FAILED', 'candidate terminal hashes could not be constructed'))
  }
  const status = candidateDevelopmentTerminalStatus(evaluation.success.verdict.status, analysis.success.status)
  const terminalReport = makeCandidateDevelopmentLocalTerminalReport(
    source,
    status,
    evaluationHash.success,
    targetHash.success,
    qualificationAnalysisHash.success,
  )
  const terminalReportHash = makeCandidateDevelopmentLocalTerminalReportHash(
    source,
    status,
    evaluationHash.success,
    targetHash.success,
    qualificationAnalysisHash.success,
  )
  return Result.isFailure(terminalReportHash)
    ? Result.fail(localError('DECISION_FAILED', 'candidate terminal receipt hash could not be constructed'))
    : Result.succeed({ status, terminalReport, terminalReportHash: terminalReportHash.success })
}

export const evaluateCandidateDevelopmentDefinition = (
  definition: StrategyDefinition<any, any, any>,
  witness: CandidateDevelopmentRuntimeMarketDataWitness,
  source: CandidateDevelopmentLocalSourceBinding,
  sourceManifest: CandidateDevelopmentSourceManifest,
): Result.Result<CandidateDevelopmentLocalTerminalOutcome, CandidateDevelopmentLocalError> =>
  evaluateCandidateDevelopmentApplication(
    bindReviewedStrategySource(
      { ...makeActiveStrategyApplication(definition.parameters), definition },
      { modulePath: source.modulePath, moduleSha256: source.moduleSha256 },
    ),
    witness,
    source,
    sourceManifest,
  )

const executeCandidateDevelopmentLocalAttempt = (
  prepared: PreparedCandidateDevelopmentLocalAttempt,
): Effect.Effect<CandidateDevelopmentLocalTerminalOutcome, CandidateDevelopmentLocalError> =>
  Effect.gen(function* () {
    const witness = yield* readWitness(prepared.args.runtimeMarketDataPath)
    if (
      witness.snapshotId !== prepared.sourceManifest.marketData.snapshotId ||
      witness.snapshotId !== witness.inputManifest.finalizedSnapshot.snapshotId ||
      witness.inputManifest.hash !== prepared.sourceManifest.marketData.inputManifestHash ||
      witness.contentHash !== prepared.sourceManifest.marketData.boundedContentHash
    ) {
      return yield* Effect.fail(
        localError('WITNESS_INVALID', 'frozen development witness does not match the preregistered source manifest'),
      )
    }
    yield* verifyCandidateDevelopmentLocalSourceTree(
      prepared.repositoryRoot,
      sourceTreePaths(prepared.source.modulePath, prepared.source.sourceManifestPath),
      candidateDevelopmentSourceGit,
      prepared.source.sourceRevision,
    )
    yield* Effect.tryPromise({
      try: async () => {
        const [moduleBytes, sourceManifestBytes] = await Promise.all([
          readFile(prepared.args.modulePath),
          readFile(prepared.args.sourceManifestPath),
        ])
        if (
          sha256Bytes(moduleBytes) !== prepared.source.moduleSha256 ||
          sha256Bytes(sourceManifestBytes) !== prepared.source.sourceManifestSha256
        ) {
          throw localError(
            'SOURCE_BINDING_INVALID',
            'candidate source bytes changed after the reviewed Git binding was prepared',
          )
        }
      },
      catch: (cause) =>
        cause instanceof CandidateDevelopmentLocalError
          ? cause
          : localError('SOURCE_BINDING_INVALID', 'candidate source bytes could not be verified', cause),
    })
    return yield* Effect.fromResult(
      evaluateCandidateDevelopmentApplication(prepared.application, witness, prepared.source, prepared.sourceManifest),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof CandidateDevelopmentLocalError
          ? cause
          : localError('DECISION_FAILED', 'candidate strategy evaluation failed', cause),
      ),
    )
  })

export const makeCandidateDevelopmentLocalAttempt =
  (port: CandidateDevelopmentLocalAttemptPort): CandidateDevelopmentLocalAttempt =>
  (prepared) =>
    Effect.gen(function* () {
      yield* port.reserve(prepared.receiptPath, makeCandidateDevelopmentLocalReceipt(prepared.source, 'RESERVED'))
      const exit = yield* Effect.exit(port.execute(prepared))
      const outcome: CandidateDevelopmentLocalTerminalOutcome = Exit.isSuccess(exit)
        ? exit.value
        : { status: 'FAILED', terminalReport: null, terminalReportHash: null }
      const terminalReceipt = makeCandidateDevelopmentLocalTerminalReceipt(prepared.source, outcome)
      yield* port.finalize(prepared.receiptPath, terminalReceipt)
      return yield* Exit.isSuccess(exit) ? Effect.succeed(terminalReceipt) : Effect.failCause(exit.cause)
    })

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

export const reserveCandidateDevelopmentLocalReceipt = (
  path: string,
  receipt: CandidateDevelopmentLocalAttemptReceipt,
): Effect.Effect<void, CandidateDevelopmentLocalError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
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
          throw localError('RECEIPT_ALREADY_CONSUMED', 'candidate development attempt was already consumed', cause)
        }
        throw cause
      } finally {
        await unlink(markerPath).catch(() => undefined)
      }
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
      const temporaryPath = `${path}.${process.pid}-${randomUUID()}.tmp`
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
  prepare: (args) =>
    activeCandidateDevelopmentRegistration === null
      ? Effect.fail(
          localError(
            'MODULE_INVALID',
            'no active candidate strategy application is statically composed for local development',
          ),
        )
      : prepareCandidateDevelopmentLocalAttempt(
          args,
          activeCandidateDevelopmentRegistration.application,
          activeCandidateDevelopmentRegistration.sourceManifest,
        ),
  attempt: makeCandidateDevelopmentLocalAttempt({
    reserve: reserveCandidateDevelopmentLocalReceipt,
    execute: executeCandidateDevelopmentLocalAttempt,
    finalize: finalizeCandidateDevelopmentLocalReceipt,
  }),
}

export const runCandidateDevelopmentLocally = (
  argv: readonly string[],
  dependencies: CandidateDevelopmentLocalDependencies = liveDependencies,
): Effect.Effect<CandidateDevelopmentLocalAttemptReceipt, CandidateDevelopmentLocalError> =>
  Effect.gen(function* () {
    const args = yield* Effect.fromResult(parseCandidateDevelopmentLocalArguments(argv))
    const prepared = yield* dependencies.prepare(args)
    return yield* dependencies.attempt(prepared)
  }).pipe(Effect.annotateLogs({ operation: 'candidate-development-local' }))

const renderLocalFailure = (failure: CandidateDevelopmentLocalError): string =>
  `${JSON.stringify({
    schemaVersion: 'bayn.candidate-development-local-error.v1',
    code: failure.code,
    message: failure.message,
  })}\n`

const reportCause = (cause: Cause.Cause<CandidateDevelopmentLocalError>): Effect.Effect<void> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  const [reason] = cause.reasons
  const rendered =
    cause.reasons.length === 1 && reason !== undefined && Cause.isFailReason(reason)
      ? renderLocalFailure(reason.error)
      : `${JSON.stringify({ schemaVersion: 'bayn.candidate-development-local-error.v1', code: 'DECISION_FAILED' })}\n`
  return Effect.sync(() => process.stderr.write(rendered))
}

class CandidateDevelopmentLocalCommandError extends Data.TaggedError('CandidateDevelopmentLocalCommandError')<{
  readonly cause: CandidateDevelopmentLocalError
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
