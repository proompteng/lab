import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import {
  makeCandidateDevelopmentLocalAttemptReceipt,
  parseCandidateDevelopmentLocalArguments,
  serializeCandidateDevelopmentLocalReceipt,
  validateCandidateDevelopmentLocalSourceBinding,
  type CandidateDevelopmentLocalArguments,
  type CandidateDevelopmentLocalAttemptReceipt,
  type CandidateDevelopmentLocalSourceBinding,
  type CandidateDevelopmentLocalSourceBindingInput,
} from './contract'

const execFileAsync = promisify(execFile)
const maximumGitOutputBytes = 8 * 1024 * 1024
const candidateDevelopmentCommandPath = 'services/bayn/src/candidate-development-command.ts'
const candidateDevelopmentEvaluatorSourcePath = 'services/bayn/src'
const localReceiptName = 'bayn-candidate-development-local-receipt.json'

export type CandidateDevelopmentLocalErrorCode =
  | 'invalid-arguments'
  | 'source-binding-invalid'
  | 'git-command-failed'
  | 'source-path-invalid'
  | 'source-working-tree-dirty'
  | 'source-manifest-invalid'
  | 'receipt-already-consumed'
  | 'receipt-reservation-failed'
  | 'receipt-finalization-failed'
  | 'candidate-process-failed'
  | 'candidate-exited'

export class CandidateDevelopmentLocalError extends Error {
  readonly code: CandidateDevelopmentLocalErrorCode

  constructor(code: CandidateDevelopmentLocalErrorCode, message: string) {
    super(message)
    this.name = 'CandidateDevelopmentLocalError'
    this.code = code
  }
}

export interface CandidateDevelopmentLocalSourceResolution {
  readonly repositoryRoot: string
  readonly modulePath: string
  readonly sourceManifestPath: string
  readonly runtimeMarketDataPath: string
  readonly receiptPath: string
  readonly attemptReceiptPath: string
  readonly candidateOrdinal: number
  readonly source: CandidateDevelopmentLocalSourceBinding
}

export interface CandidateDevelopmentLocalProcessRequest {
  readonly repositoryRoot: string
  readonly argv: readonly string[]
  readonly sourceRevision: string
}

export interface CandidateDevelopmentLocalDependencies {
  readonly resolveSourceBinding: (
    args: CandidateDevelopmentLocalArguments,
  ) => Promise<CandidateDevelopmentLocalSourceResolution>
  readonly revalidateSourceBinding: (resolution: CandidateDevelopmentLocalSourceResolution) => Promise<void>
  readonly reserveReceipt: (
    path: string,
    receipt: CandidateDevelopmentLocalAttemptReceipt,
    candidateOrdinal?: number,
    attemptReceiptPath?: string,
  ) => Promise<void>
  readonly finalizeReceipt: (path: string, receipt: CandidateDevelopmentLocalAttemptReceipt) => Promise<void>
  readonly runCandidateDevelopment: (request: CandidateDevelopmentLocalProcessRequest) => Promise<number>
}

export interface CandidateDevelopmentLocalRunResult {
  readonly receiptPath: string
  readonly receipt: CandidateDevelopmentLocalAttemptReceipt
}

const isFileSystemError = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code

const gitCommandFailure = (): CandidateDevelopmentLocalError =>
  new CandidateDevelopmentLocalError('git-command-failed', 'Git could not verify the reviewed source binding')

export const candidateDevelopmentGitCommand = (args: readonly string[]) => ({
  args: ['--no-replace-objects', ...args],
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
})

const gitText = async (repositoryRoot: string, args: readonly string[]): Promise<string> => {
  try {
    const command = candidateDevelopmentGitCommand(args)
    const result = await execFileAsync('git', command.args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: command.env,
      maxBuffer: maximumGitOutputBytes,
    })
    return String(result.stdout)
  } catch {
    throw gitCommandFailure()
  }
}

const gitToken = async (repositoryRoot: string, args: readonly string[]): Promise<string> => {
  const output = (await gitText(repositoryRoot, args)).trim()
  if (output.length === 0) throw gitCommandFailure()
  return output
}

const gitDiffIsClean = async (repositoryRoot: string, paths: readonly string[]): Promise<boolean> => {
  try {
    const command = candidateDevelopmentGitCommand(['diff', '--quiet', 'HEAD', '--', ...paths])
    await execFileAsync('git', command.args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: command.env,
      maxBuffer: maximumGitOutputBytes,
    })
    return true
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && (cause.code === 1 || cause.code === '1')) {
      return false
    }
    throw gitCommandFailure()
  }
}

const gitWorkingTreeIsClean = async (repositoryRoot: string, paths: readonly string[]): Promise<boolean> => {
  const indexEntries = await gitText(repositoryRoot, ['ls-files', '-v', '--', ...paths])
  if (
    indexEntries
      .split('\n')
      .filter((entry) => entry.length > 0)
      .some((entry) => !entry.startsWith('H '))
  ) {
    return false
  }
  if (!(await gitDiffIsClean(repositoryRoot, paths))) return false
  const status = await gitText(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignored=matching',
    '--',
    ...paths,
  ])
  return status.length === 0
}

const repositoryRelativePath = (repositoryRoot: string, absolutePath: string, label: string): string => {
  const path = relative(repositoryRoot, absolutePath)
  if (path.length === 0 || path === '..' || path.startsWith(`..${sep}`) || path.startsWith(sep)) {
    throw new CandidateDevelopmentLocalError('source-path-invalid', `${label} must be inside the repository`)
  }
  return path.split(sep).join('/')
}

const sourceManifestRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CandidateDevelopmentLocalError('source-manifest-invalid', 'source manifest must be a JSON object')
  }
  return value as Record<string, unknown>
}

const verifySourceManifest = (value: unknown, modulePath: string, moduleSha256: string): number => {
  const manifest = sourceManifestRecord(value)
  if (manifest.schemaVersion !== 'bayn.candidate-development-source-manifest.v1') {
    throw new CandidateDevelopmentLocalError('source-manifest-invalid', 'source manifest schema is unsupported')
  }
  if (manifest.modulePath !== modulePath) {
    throw new CandidateDevelopmentLocalError('source-manifest-invalid', 'source manifest module path is not exact')
  }
  if (manifest.moduleSha256 !== undefined && manifest.moduleSha256 !== moduleSha256) {
    throw new CandidateDevelopmentLocalError('source-manifest-invalid', 'source manifest module hash is not exact')
  }
  if (
    typeof manifest.candidateOrdinal !== 'number' ||
    !Number.isSafeInteger(manifest.candidateOrdinal) ||
    manifest.candidateOrdinal < 1
  ) {
    throw new CandidateDevelopmentLocalError('source-manifest-invalid', 'source manifest candidate ordinal is invalid')
  }
  return manifest.candidateOrdinal
}

const sourceSha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const gitPath = async (repositoryRoot: string): Promise<string> => {
  const path = await gitToken(repositoryRoot, ['rev-parse', '--git-path', localReceiptName])
  return resolve(repositoryRoot, path)
}

const gitCommonPath = async (repositoryRoot: string): Promise<string> => {
  const path = await gitToken(repositoryRoot, ['rev-parse', '--git-common-dir'])
  return realpath(resolve(repositoryRoot, path))
}

export const resolveCandidateDevelopmentLocalSource = async (
  args: CandidateDevelopmentLocalArguments,
): Promise<CandidateDevelopmentLocalSourceResolution> => {
  const repositoryRoot = await realpath(await gitToken(process.cwd(), ['rev-parse', '--show-toplevel']))
  let absoluteModulePath: string
  let absoluteSourceManifestPath: string
  try {
    absoluteModulePath = await realpath(resolve(repositoryRoot, args.modulePath))
    absoluteSourceManifestPath = await realpath(resolve(repositoryRoot, args.sourceManifestPath))
  } catch {
    throw new CandidateDevelopmentLocalError('source-path-invalid', 'module and source manifest must be readable files')
  }

  const modulePath = repositoryRelativePath(repositoryRoot, absoluteModulePath, 'module')
  const sourceManifestPath = repositoryRelativePath(repositoryRoot, absoluteSourceManifestPath, 'source manifest')
  if (
    !(await gitWorkingTreeIsClean(repositoryRoot, [
      modulePath,
      sourceManifestPath,
      candidateDevelopmentEvaluatorSourcePath,
    ]))
  ) {
    throw new CandidateDevelopmentLocalError(
      'source-working-tree-dirty',
      'candidate module, source manifest, and evaluator source must match their exact reviewed HEAD blobs',
    )
  }
  for (const path of [modulePath, sourceManifestPath]) {
    const trackedPath = (await gitText(repositoryRoot, ['ls-files', '--error-unmatch', '--', path])).trim()
    if (trackedPath !== path)
      throw new CandidateDevelopmentLocalError('source-path-invalid', 'source path is not tracked')
  }

  const sourceRevision = await gitToken(repositoryRoot, ['rev-parse', 'HEAD'])
  const moduleSpec = `${sourceRevision}:${modulePath}`
  const sourceManifestSpec = `${sourceRevision}:${sourceManifestPath}`
  const [moduleBlobOid, sourceManifestBlobOid, moduleSource, sourceManifestSource] = await Promise.all([
    gitToken(repositoryRoot, ['rev-parse', moduleSpec]),
    gitToken(repositoryRoot, ['rev-parse', sourceManifestSpec]),
    gitText(repositoryRoot, ['cat-file', 'blob', moduleSpec]),
    gitText(repositoryRoot, ['cat-file', 'blob', sourceManifestSpec]),
  ])
  const moduleSha256 = sourceSha256(moduleSource)
  const sourceManifestSha256 = sourceSha256(sourceManifestSource)
  let parsedManifest: unknown
  try {
    parsedManifest = JSON.parse(sourceManifestSource) as unknown
  } catch {
    throw new CandidateDevelopmentLocalError('source-manifest-invalid', 'source manifest is not valid JSON')
  }
  const candidateOrdinal = verifySourceManifest(parsedManifest, modulePath, moduleSha256)

  const sourceInput: CandidateDevelopmentLocalSourceBindingInput = {
    sourceRevision,
    modulePath,
    moduleBlobOid,
    moduleSha256,
    sourceManifestPath,
    sourceManifestBlobOid,
    sourceManifestSha256,
  }
  const source = validateCandidateDevelopmentLocalSourceBinding(sourceInput)
  if (!source.ok) throw new CandidateDevelopmentLocalError(source.code, source.message)
  const commonDirectory = await gitCommonPath(repositoryRoot)
  return {
    repositoryRoot,
    modulePath,
    sourceManifestPath,
    runtimeMarketDataPath: resolve(repositoryRoot, args.runtimeMarketDataPath),
    receiptPath: await gitPath(repositoryRoot),
    attemptReceiptPath: join(
      commonDirectory,
      'bayn',
      'candidate-development-attempts',
      `ordinal-${candidateOrdinal}.json`,
    ),
    candidateOrdinal,
    source: source.value,
  }
}

export const revalidateCandidateDevelopmentLocalSource = async (
  resolution: CandidateDevelopmentLocalSourceResolution,
): Promise<void> => {
  const currentRevision = await gitToken(resolution.repositoryRoot, ['rev-parse', 'HEAD'])
  if (currentRevision !== resolution.source.sourceRevision) {
    throw new CandidateDevelopmentLocalError(
      'source-binding-invalid',
      'the reviewed source revision changed during local candidate development',
    )
  }
  if (
    !(await gitWorkingTreeIsClean(resolution.repositoryRoot, [
      resolution.modulePath,
      resolution.sourceManifestPath,
      candidateDevelopmentEvaluatorSourcePath,
    ]))
  ) {
    throw new CandidateDevelopmentLocalError(
      'source-working-tree-dirty',
      'candidate module, source manifest, or evaluator source changed during local candidate development',
    )
  }
  const [moduleBlobOid, sourceManifestBlobOid] = await Promise.all([
    gitToken(resolution.repositoryRoot, [
      'rev-parse',
      `${resolution.source.sourceRevision}:${resolution.source.modulePath}`,
    ]),
    gitToken(resolution.repositoryRoot, [
      'rev-parse',
      `${resolution.source.sourceRevision}:${resolution.source.sourceManifestPath}`,
    ]),
  ])
  if (
    moduleBlobOid !== resolution.source.moduleBlobOid ||
    sourceManifestBlobOid !== resolution.source.sourceManifestBlobOid
  ) {
    throw new CandidateDevelopmentLocalError(
      'source-binding-invalid',
      'the reviewed source blobs changed during local candidate development',
    )
  }
}

const temporaryReceiptPath = (path: string): string => `${path}.tmp-${process.pid}-${randomUUID()}`

const reserveReceiptAtPath = async (path: string, receipt: CandidateDevelopmentLocalAttemptReceipt): Promise<void> => {
  const temporaryPath = temporaryReceiptPath(path)
  try {
    await writeFile(temporaryPath, serializeCandidateDevelopmentLocalReceipt(receipt), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    try {
      await link(temporaryPath, path)
    } catch (cause) {
      if (isFileSystemError(cause, 'EEXIST')) {
        throw new CandidateDevelopmentLocalError(
          'receipt-already-consumed',
          'the local candidate-development attempt has already been consumed',
        )
      }
      throw new CandidateDevelopmentLocalError(
        'receipt-reservation-failed',
        'the local attempt receipt was not reserved',
      )
    }
  } catch (cause) {
    if (cause instanceof CandidateDevelopmentLocalError) throw cause
    throw new CandidateDevelopmentLocalError('receipt-reservation-failed', 'the local attempt receipt was not reserved')
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

const candidateDevelopmentAttemptReceiptPath = (legacyReceiptPath: string, candidateOrdinal: number): string =>
  join(dirname(legacyReceiptPath), 'bayn', 'candidate-development-attempts', `ordinal-${candidateOrdinal}.json`)

export const reserveCandidateDevelopmentLocalReceipt = async (
  path: string,
  receipt: CandidateDevelopmentLocalAttemptReceipt,
  candidateOrdinal?: number,
  attemptReceiptPath?: string,
): Promise<void> => {
  if (candidateOrdinal !== undefined) {
    const attemptPath = attemptReceiptPath ?? candidateDevelopmentAttemptReceiptPath(path, candidateOrdinal)
    await mkdir(dirname(attemptPath), { recursive: true, mode: 0o700 })
    await reserveReceiptAtPath(attemptPath, receipt)
  }
  await reserveReceiptAtPath(path, receipt)
}

export const finalizeCandidateDevelopmentLocalReceipt = async (
  path: string,
  receipt: CandidateDevelopmentLocalAttemptReceipt,
): Promise<void> => {
  const temporaryPath = temporaryReceiptPath(path)
  try {
    await writeFile(temporaryPath, serializeCandidateDevelopmentLocalReceipt(receipt), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    await rename(temporaryPath, path)
  } catch {
    throw new CandidateDevelopmentLocalError(
      'receipt-finalization-failed',
      'the local attempt receipt could not be finalized; do not retry',
    )
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export const runCandidateDevelopmentProcess = async (
  request: CandidateDevelopmentLocalProcessRequest,
): Promise<number> => {
  const child = Bun.spawn([process.execPath, candidateDevelopmentCommandPath, ...request.argv], {
    cwd: request.repositoryRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      BAYN_CANDIDATE_DEVELOPMENT_EXPECTED_SOURCE_REVISION: request.sourceRevision,
    },
  })
  return child.exited
}

const defaultDependencies: CandidateDevelopmentLocalDependencies = {
  resolveSourceBinding: resolveCandidateDevelopmentLocalSource,
  revalidateSourceBinding: revalidateCandidateDevelopmentLocalSource,
  reserveReceipt: reserveCandidateDevelopmentLocalReceipt,
  finalizeReceipt: finalizeCandidateDevelopmentLocalReceipt,
  runCandidateDevelopment: runCandidateDevelopmentProcess,
}

const finalizeFailedAttempt = async (
  dependencies: CandidateDevelopmentLocalDependencies,
  receiptPath: string,
  source: CandidateDevelopmentLocalSourceBinding,
  exitCode?: number,
): Promise<void> => {
  await dependencies.finalizeReceipt(
    receiptPath,
    makeCandidateDevelopmentLocalAttemptReceipt(source, 'failed', exitCode),
  )
}

export const runCandidateDevelopmentLocally = async (
  argv: readonly string[],
  dependencies: CandidateDevelopmentLocalDependencies = defaultDependencies,
): Promise<CandidateDevelopmentLocalRunResult> => {
  const parsed = parseCandidateDevelopmentLocalArguments(argv)
  if (!parsed.ok) throw new CandidateDevelopmentLocalError(parsed.code, parsed.message)
  const resolved = await dependencies.resolveSourceBinding(parsed.value)
  const reserved = makeCandidateDevelopmentLocalAttemptReceipt(resolved.source, 'reserved')
  await dependencies.reserveReceipt(
    resolved.receiptPath,
    reserved,
    resolved.candidateOrdinal,
    resolved.attemptReceiptPath,
  )

  try {
    await dependencies.revalidateSourceBinding(resolved)
  } catch (cause) {
    try {
      await finalizeFailedAttempt(dependencies, resolved.receiptPath, resolved.source)
    } catch {
      throw new CandidateDevelopmentLocalError(
        'receipt-finalization-failed',
        'the local attempt receipt could not be finalized; do not retry',
      )
    }
    throw cause
  }

  let exitCode: number
  try {
    exitCode = await dependencies.runCandidateDevelopment({
      repositoryRoot: resolved.repositoryRoot,
      argv: [resolved.modulePath, resolved.sourceManifestPath, resolved.runtimeMarketDataPath],
      sourceRevision: resolved.source.sourceRevision,
    })
  } catch {
    try {
      await finalizeFailedAttempt(dependencies, resolved.receiptPath, resolved.source)
    } catch {
      throw new CandidateDevelopmentLocalError(
        'receipt-finalization-failed',
        'the local attempt receipt could not be finalized; do not retry',
      )
    }
    throw new CandidateDevelopmentLocalError('candidate-process-failed', 'the candidate-development command failed')
  }

  try {
    await dependencies.revalidateSourceBinding(resolved)
  } catch (cause) {
    try {
      await finalizeFailedAttempt(dependencies, resolved.receiptPath, resolved.source, exitCode)
    } catch {
      throw new CandidateDevelopmentLocalError(
        'receipt-finalization-failed',
        'the local attempt receipt could not be finalized; do not retry',
      )
    }
    throw cause
  }

  if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
    try {
      await finalizeFailedAttempt(dependencies, resolved.receiptPath, resolved.source)
    } catch {
      throw new CandidateDevelopmentLocalError(
        'receipt-finalization-failed',
        'the local attempt receipt could not be finalized; do not retry',
      )
    }
    throw new CandidateDevelopmentLocalError(
      'candidate-process-failed',
      'the candidate-development command exit was invalid',
    )
  }
  if (exitCode !== 0) {
    try {
      await finalizeFailedAttempt(dependencies, resolved.receiptPath, resolved.source, exitCode)
    } catch {
      throw new CandidateDevelopmentLocalError(
        'receipt-finalization-failed',
        'the local attempt receipt could not be finalized; do not retry',
      )
    }
    throw new CandidateDevelopmentLocalError(
      'candidate-exited',
      `the candidate-development command exited with ${exitCode}`,
    )
  }

  const completed = makeCandidateDevelopmentLocalAttemptReceipt(resolved.source, 'completed', exitCode)
  await dependencies.finalizeReceipt(resolved.receiptPath, completed)
  return { receiptPath: resolved.receiptPath, receipt: completed }
}

if (import.meta.main) {
  const { runCandidateDevelopmentLocalMain } =
    await import('../../../../../services/bayn/src/candidate-development-local/command')
  runCandidateDevelopmentLocalMain(process.argv.slice(2))
}
