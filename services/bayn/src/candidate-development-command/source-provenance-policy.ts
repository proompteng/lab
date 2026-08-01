import { readFile, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { Effect, Result } from 'effect'

import { frozenCandidateDevelopmentTrialHistory } from '../candidate-development-trial-history'

import { decodeCandidateDevelopmentSourceManifest } from './contracts'
import type {
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentSourceManifest,
  CandidateDevelopmentVerifiedSourceFiles,
} from './contracts'
import { sourceVerificationFailure } from './evaluation'
import {
  repositoryRelativePath,
  sha256Bytes,
  validateCandidateDevelopmentModuleSource,
  verifySelfContainedEsm,
} from './artifact-policy'
import { validateCandidateDevelopmentPreregistrationDocument } from './runtime-policy'
import type {
  CandidateDevelopmentGitObjectReader,
  CandidateDevelopmentSourceGit,
  CandidateDevelopmentSourceVerifier,
} from './git-contracts'
import {
  CandidateDevelopmentSourceVerificationError,
  candidateDevelopmentSourceGit,
  sourceStep,
} from './git-interpreter'

const activeGitMetadataLines = (value: string, commentsAllowed: boolean): readonly string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (!commentsAllowed || !line.startsWith('#')))

const readOptionalGitMetadata = async (path: string, signal: AbortSignal): Promise<string> => {
  try {
    return await readFile(path, { encoding: 'utf8', signal })
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') return ''
    throw cause
  }
}

const verifyCandidateDevelopmentRepositoryIntegrityPromise = async (
  repositoryRoot: string,
  sourceGit: CandidateDevelopmentSourceGit,
  signal: AbortSignal,
): Promise<void> => {
  const shallow = await sourceStep('verify-repository-integrity', () =>
    sourceGit.text(repositoryRoot, ['rev-parse', '--is-shallow-repository'], signal),
  )
  if (shallow !== 'false') {
    throw new CandidateDevelopmentSourceVerificationError('verify-repository-integrity', {
      field: 'shallowRepository',
      expected: 'false',
      observed: shallow,
    })
  }

  const replaceRefs = await sourceStep('verify-repository-integrity', () =>
    sourceGit.text(repositoryRoot, ['for-each-ref', '--format=%(refname)', 'refs/replace'], signal),
  )
  if (replaceRefs.length > 0) {
    throw new CandidateDevelopmentSourceVerificationError('verify-repository-integrity', {
      field: 'replaceRefs',
      expected: [],
      observed: replaceRefs.split('\n'),
    })
  }

  const replacementConfig = await sourceStep('verify-repository-integrity', () =>
    sourceGit.text(repositoryRoot, ['config', '--list'], signal),
  )
  const replacementConfigKeys = replacementConfig
    .split('\n')
    .map((line) => line.slice(0, line.indexOf('=')))
    .filter((key) => key.startsWith('replace.'))
  if (replacementConfigKeys.length > 0) {
    throw new CandidateDevelopmentSourceVerificationError('verify-repository-integrity', {
      field: 'replacementConfig',
      expected: [],
      observed: replacementConfigKeys,
    })
  }

  for (const metadata of [
    { field: 'grafts', path: 'info/grafts', commentsAllowed: true },
    { field: 'alternates', path: 'objects/info/alternates', commentsAllowed: false },
    { field: 'httpAlternates', path: 'objects/info/http-alternates', commentsAllowed: false },
  ] as const) {
    const gitPath = await sourceStep('verify-repository-integrity', () =>
      sourceGit.text(repositoryRoot, ['rev-parse', '--git-path', metadata.path], signal),
    )
    const absolutePath = resolve(repositoryRoot, gitPath)
    const contents = await sourceStep('verify-repository-integrity', () =>
      readOptionalGitMetadata(absolutePath, signal),
    )
    const activeLines = activeGitMetadataLines(contents, metadata.commentsAllowed)
    if (activeLines.length > 0) {
      throw new CandidateDevelopmentSourceVerificationError('verify-repository-integrity', {
        field: metadata.field,
        path: absolutePath,
        expected: [],
        observed: activeLines,
      })
    }
  }
}

export const verifyCandidateDevelopmentRepositoryIntegrity = (
  repositoryRoot: string,
  sourceGit: CandidateDevelopmentSourceGit = candidateDevelopmentSourceGit,
): Effect.Effect<void, CandidateDevelopmentCommandFailure> =>
  Effect.tryPromise({
    try: (signal) => verifyCandidateDevelopmentRepositoryIntegrityPromise(repositoryRoot, sourceGit, signal),
    catch: (cause): CandidateDevelopmentCommandFailure =>
      cause instanceof CandidateDevelopmentSourceVerificationError
        ? sourceVerificationFailure(cause.operation, cause.sourceCause)
        : sourceVerificationFailure('verify-repository-integrity', cause),
  })

const candidateDevelopmentMaximumHistoryCommits = 50_000
const candidateDevelopmentMaximumHistoryTrees = 500_000

interface CandidateDevelopmentImmutableCommit {
  readonly treeOid: string
  readonly parentOids: readonly string[]
}

interface CandidateDevelopmentImmutableTreeEntry {
  readonly objectType: 'blob' | 'commit' | 'tree'
  readonly objectOid: string
}

const openCandidateDevelopmentGitObjectReader = async (
  repositoryRoot: string,
  sourceGit: CandidateDevelopmentSourceGit,
  signal: AbortSignal,
): Promise<CandidateDevelopmentGitObjectReader> =>
  sourceGit.openObjectReader?.(repositoryRoot, signal) ??
  Promise.resolve({
    read: async (oid, expectedType) =>
      expectedType === 'commit'
        ? Buffer.from(await sourceGit.text(repositoryRoot, ['cat-file', 'commit', oid], signal), 'utf8')
        : sourceGit.bytes(repositoryRoot, ['cat-file', 'tree', oid], signal),
    close: async () => undefined,
  })

const decodeCandidateDevelopmentImmutableCommit = (
  operation: CandidateDevelopmentSourceVerificationError['operation'],
  commitOid: string,
  content: string,
): CandidateDevelopmentImmutableCommit => {
  const header = content.includes('\n\n') ? content.slice(0, content.indexOf('\n\n')) : content
  const lines = header.split('\n')
  const treeLine = lines.find((line) => line.startsWith('tree '))
  const treeOid = treeLine?.slice('tree '.length)
  const parentOids = lines.filter((line) => line.startsWith('parent ')).map((line) => line.slice('parent '.length))
  if (
    treeOid === undefined ||
    !/^[0-9a-f]{40}$/.test(treeOid) ||
    parentOids.some((parentOid) => !/^[0-9a-f]{40}$/.test(parentOid))
  ) {
    throw new CandidateDevelopmentSourceVerificationError(operation, {
      field: 'immutableCommit',
      commitOid,
      expected: 'raw commit with lowercase 40-character tree and parent OIDs',
      observed: { treeOid, parentOids },
    })
  }
  return { treeOid, parentOids }
}

const decodeCandidateDevelopmentImmutableTree = (
  treeOid: string,
  content: Buffer,
): readonly CandidateDevelopmentImmutableTreeEntry[] => {
  const entries: CandidateDevelopmentImmutableTreeEntry[] = []
  let offset = 0
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset)
    const nul = space < 0 ? -1 : content.indexOf(0x00, space + 1)
    if (space <= offset || nul <= space + 1 || nul + 21 > content.length) {
      throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-module-novelty', {
        field: 'immutableTreeEntry',
        treeOid,
        offset,
        expected: 'raw Git tree entry with mode, name, NUL, and 20-byte object ID',
      })
    }
    const mode = content.subarray(offset, space).toString('ascii')
    const objectOid = content.subarray(nul + 1, nul + 21).toString('hex')
    const objectType: CandidateDevelopmentImmutableTreeEntry['objectType'] =
      mode === '40000' || mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob'
    if (!/^[0-9a-f]{40}$/.test(objectOid)) {
      throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-module-novelty', {
        field: 'immutableTreeObjectOid',
        treeOid,
        offset,
        observed: objectOid,
      })
    }
    entries.push({ objectType, objectOid })
    offset = nul + 21
  }
  return entries
}

const walkCandidateDevelopmentImmutableHistory = async (
  startRevision: string,
  operation: CandidateDevelopmentSourceVerificationError['operation'],
  objectReader: CandidateDevelopmentGitObjectReader,
  visit: (commitOid: string, commit: CandidateDevelopmentImmutableCommit) => Promise<boolean>,
): Promise<boolean> => {
  const pending = [startRevision]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const commitOid = pending.pop()
    if (commitOid === undefined || visited.has(commitOid)) continue
    if (visited.size >= candidateDevelopmentMaximumHistoryCommits) {
      throw new CandidateDevelopmentSourceVerificationError(operation, {
        field: 'immutableHistoryCommitCount',
        expected: `<${candidateDevelopmentMaximumHistoryCommits}`,
        observed: visited.size,
      })
    }
    const content = await sourceStep(operation, () => objectReader.read(commitOid, 'commit'))
    const commit = decodeCandidateDevelopmentImmutableCommit(operation, commitOid, content.toString('utf8'))
    visited.add(commitOid)
    if (await visit(commitOid, commit)) return true
    pending.push(...commit.parentOids)
  }
  return false
}

const verifyCandidateDevelopmentPreregistrationLineagePromise = async (
  repositoryRoot: string,
  preregistrationRevision: string,
  sourceRevision: string,
  sourceGit: CandidateDevelopmentSourceGit,
  signal: AbortSignal,
): Promise<void> => {
  await verifyCandidateDevelopmentRepositoryIntegrityPromise(repositoryRoot, sourceGit, signal)
  if (preregistrationRevision === sourceRevision) {
    throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-lineage', {
      expected: 'proper ancestor of evaluated source revision',
      observed: preregistrationRevision,
    })
  }
  const objectReader = await sourceStep('verify-preregistration-lineage', () =>
    openCandidateDevelopmentGitObjectReader(repositoryRoot, sourceGit, signal),
  )
  let found: boolean
  try {
    found = await walkCandidateDevelopmentImmutableHistory(
      sourceRevision,
      'verify-preregistration-lineage',
      objectReader,
      async (commitOid) => commitOid === preregistrationRevision,
    )
  } finally {
    await objectReader.close()
  }
  if (!found) {
    throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-lineage', {
      expected: `${preregistrationRevision} to be a proper ancestor of ${sourceRevision}`,
      observed: 'not reachable through raw commit parents',
    })
  }
}

export const verifyCandidateDevelopmentPreregistrationLineage = (
  repositoryRoot: string,
  preregistrationRevision: string,
  sourceRevision: string,
  sourceGit: CandidateDevelopmentSourceGit = candidateDevelopmentSourceGit,
): Effect.Effect<void, CandidateDevelopmentCommandFailure> =>
  Effect.tryPromise({
    try: (signal) =>
      verifyCandidateDevelopmentPreregistrationLineagePromise(
        repositoryRoot,
        preregistrationRevision,
        sourceRevision,
        sourceGit,
        signal,
      ),
    catch: (cause): CandidateDevelopmentCommandFailure =>
      cause instanceof CandidateDevelopmentSourceVerificationError
        ? sourceVerificationFailure(cause.operation, cause.sourceCause)
        : sourceVerificationFailure('verify-preregistration-lineage', cause),
  })

const verifyCandidateDevelopmentPreregistrationModuleNoveltyPromise = async (
  repositoryRoot: string,
  preregistrationRevision: string,
  modulePath: string,
  moduleBlobOid: string,
  sourceGit: CandidateDevelopmentSourceGit,
  signal: AbortSignal,
): Promise<void> => {
  await verifyCandidateDevelopmentRepositoryIntegrityPromise(repositoryRoot, sourceGit, signal)
  const objectReader = await sourceStep('verify-preregistration-module-novelty', () =>
    openCandidateDevelopmentGitObjectReader(repositoryRoot, sourceGit, signal),
  )
  const searchedTrees = new Set<string>()
  let matchingCommitOid: string | undefined
  const treeContainsModuleBlob = async (rootTreeOid: string): Promise<boolean> => {
    const pendingTrees = [rootTreeOid]
    while (pendingTrees.length > 0) {
      const treeOid = pendingTrees.pop()
      if (treeOid === undefined || searchedTrees.has(treeOid)) continue
      if (searchedTrees.size >= candidateDevelopmentMaximumHistoryTrees) {
        throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-module-novelty', {
          field: 'immutableHistoryTreeCount',
          expected: `<${candidateDevelopmentMaximumHistoryTrees}`,
          observed: searchedTrees.size,
        })
      }
      const contents = await sourceStep('verify-preregistration-module-novelty', () =>
        objectReader.read(treeOid, 'tree'),
      )
      searchedTrees.add(treeOid)
      for (const { objectType, objectOid } of decodeCandidateDevelopmentImmutableTree(treeOid, contents)) {
        if (objectType === 'blob' && objectOid === moduleBlobOid) return true
        if (objectType === 'tree') pendingTrees.push(objectOid)
      }
    }
    return false
  }
  try {
    await walkCandidateDevelopmentImmutableHistory(
      preregistrationRevision,
      'verify-preregistration-module-novelty',
      objectReader,
      async (commitOid, commit) => {
        const found = await treeContainsModuleBlob(commit.treeOid)
        if (found) matchingCommitOid = commitOid
        return found
      },
    )
  } finally {
    await objectReader.close()
  }
  if (matchingCommitOid !== undefined) {
    throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-module-novelty', {
      preregistrationRevision,
      modulePath,
      expected: 'evaluated module blob created after preregistration',
      observed: moduleBlobOid,
      history: [matchingCommitOid],
    })
  }
}

export const verifyCandidateDevelopmentPreregistrationModuleNovelty = (
  repositoryRoot: string,
  preregistrationRevision: string,
  modulePath: string,
  moduleBlobOid: string,
  sourceGit: CandidateDevelopmentSourceGit = candidateDevelopmentSourceGit,
): Effect.Effect<void, CandidateDevelopmentCommandFailure> =>
  Effect.tryPromise({
    try: (signal) =>
      verifyCandidateDevelopmentPreregistrationModuleNoveltyPromise(
        repositoryRoot,
        preregistrationRevision,
        modulePath,
        moduleBlobOid,
        sourceGit,
        signal,
      ),
    catch: (cause): CandidateDevelopmentCommandFailure =>
      cause instanceof CandidateDevelopmentSourceVerificationError
        ? sourceVerificationFailure(cause.operation, cause.sourceCause)
        : sourceVerificationFailure('verify-preregistration-module-novelty', cause),
  })

const runCandidateDevelopmentSourcePair = async <Left, Right>(
  outerSignal: AbortSignal,
  left: (signal: AbortSignal) => Promise<Left>,
  right: (signal: AbortSignal) => Promise<Right>,
): Promise<readonly [Left, Right]> => {
  const controller = new AbortController()
  const signal = AbortSignal.any([outerSignal, controller.signal])
  const leftPromise = left(signal)
  const rightPromise = right(signal)
  try {
    return await Promise.all([leftPromise, rightPromise])
  } catch (cause) {
    controller.abort(cause)
    await Promise.allSettled([leftPromise, rightPromise])
    throw cause
  }
}

export const verifyCandidateDevelopmentSourceFiles: CandidateDevelopmentSourceVerifier = (
  modulePath,
  sourceManifestPath,
  sourceGit: CandidateDevelopmentSourceGit = candidateDevelopmentSourceGit,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const absoluteModulePath = await sourceStep('read-module', () => realpath(resolve(modulePath)))
      const absoluteSourceManifestPath = await sourceStep('read-source-manifest', () =>
        realpath(resolve(sourceManifestPath)),
      )
      const repositoryRoot = await sourceStep('resolve-repository', () =>
        sourceGit.text(dirname(absoluteModulePath), ['rev-parse', '--show-toplevel'], signal),
      )
      await verifyCandidateDevelopmentRepositoryIntegrityPromise(repositoryRoot, sourceGit, signal)
      const moduleRepositoryPath = repositoryRelativePath(repositoryRoot, absoluteModulePath)
      if (Result.isFailure(moduleRepositoryPath)) {
        throw new CandidateDevelopmentSourceVerificationError('verify-source-paths', moduleRepositoryPath.failure)
      }
      const sourceManifestRepositoryPath = repositoryRelativePath(repositoryRoot, absoluteSourceManifestPath)
      if (Result.isFailure(sourceManifestRepositoryPath)) {
        throw new CandidateDevelopmentSourceVerificationError(
          'verify-source-paths',
          sourceManifestRepositoryPath.failure,
        )
      }
      const sourceRevision = await sourceStep('verify-head', () =>
        sourceGit.text(repositoryRoot, ['rev-parse', 'HEAD'], signal),
      )
      if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
        throw new CandidateDevelopmentSourceVerificationError('verify-head', {
          expected: 'lowercase 40-character Git revision',
          observed: sourceRevision,
        })
      }
      const reviewedCandidatePreregistration =
        frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePreregistration
      {
        const preregistration = reviewedCandidatePreregistration.preregistration
        if (
          !/^[0-9a-f]{40}$/.test(preregistration.sourceRevision) ||
          !/^[0-9a-f]{40}$/.test(preregistration.blobOid) ||
          preregistration.path.length === 0 ||
          preregistration.path.startsWith('/') ||
          preregistration.path === '..' ||
          preregistration.path.startsWith('../') ||
          preregistration.path.includes('/../')
        ) {
          throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-blob', {
            expected: 'lowercase Git revision/blob OID and repository-relative preregistration path',
            observed: preregistration,
          })
        }
        const preregistrationSpec = `${preregistration.sourceRevision}:${preregistration.path}`
        const [preregistrationBytes, preregistrationBlobOid] = await runCandidateDevelopmentSourcePair(
          signal,
          (batchSignal) =>
            sourceStep('verify-preregistration-blob', () =>
              sourceGit.bytes(repositoryRoot, ['cat-file', 'blob', preregistrationSpec], batchSignal),
            ),
          (batchSignal) =>
            sourceStep('verify-preregistration-blob', () =>
              sourceGit.text(repositoryRoot, ['rev-parse', preregistrationSpec], batchSignal),
            ),
        )
        if (preregistrationBlobOid !== preregistration.blobOid) {
          throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-blob', {
            revision: preregistration.sourceRevision,
            path: preregistration.path,
            expected: preregistration.blobOid,
            observed: preregistrationBlobOid,
          })
        }
        const preregistrationJson = await sourceStep(
          'decode-preregistration',
          async () => JSON.parse(preregistrationBytes.toString('utf8')) as unknown,
        )
        const preregistrationDocument = validateCandidateDevelopmentPreregistrationDocument(
          reviewedCandidatePreregistration,
          preregistrationJson,
        )
        if (Result.isFailure(preregistrationDocument)) {
          const failure = preregistrationDocument.failure
          throw new CandidateDevelopmentSourceVerificationError(
            failure._tag === 'CandidateDevelopmentCommandSourceVerificationFailed'
              ? failure.operation
              : 'verify-preregistration-blob',
            failure._tag === 'CandidateDevelopmentCommandSourceVerificationFailed' ? failure.cause : failure,
          )
        }
        await verifyCandidateDevelopmentPreregistrationLineagePromise(
          repositoryRoot,
          preregistration.sourceRevision,
          sourceRevision,
          sourceGit,
          signal,
        )
      }
      const moduleSpec = `${sourceRevision}:${moduleRepositoryPath.success}`
      const sourceManifestSpec = `${sourceRevision}:${sourceManifestRepositoryPath.success}`
      const [moduleGitBytes, sourceManifestGitBytes] = await runCandidateDevelopmentSourcePair(
        signal,
        (batchSignal) =>
          sourceStep('verify-module-blob', () =>
            sourceGit.bytes(repositoryRoot, ['cat-file', 'blob', moduleSpec], batchSignal),
          ),
        (batchSignal) =>
          sourceStep('verify-source-manifest-blob', () =>
            sourceGit.bytes(repositoryRoot, ['cat-file', 'blob', sourceManifestSpec], batchSignal),
          ),
      )
      const sourceManifestJson = await sourceStep(
        'decode-source-manifest',
        async () => JSON.parse(sourceManifestGitBytes.toString('utf8')) as unknown,
      )
      const sourceManifest = decodeCandidateDevelopmentSourceManifest(sourceManifestJson)
      if (Result.isFailure(sourceManifest)) {
        throw new CandidateDevelopmentSourceVerificationError('decode-source-manifest', sourceManifest.failure)
      }
      if (sourceManifest.success.modulePath !== moduleRepositoryPath.success) {
        throw new CandidateDevelopmentSourceVerificationError('verify-source-paths', {
          expected: moduleRepositoryPath.success,
          observed: sourceManifest.success.modulePath,
        })
      }
      const moduleSource = moduleGitBytes.toString('utf8')
      const moduleFormat = verifySelfContainedEsm(moduleSource, moduleRepositoryPath.success)
      if (Result.isFailure(moduleFormat)) {
        throw new CandidateDevelopmentSourceVerificationError('verify-module-format', moduleFormat.failure)
      }
      const moduleSourcePolicy = validateCandidateDevelopmentModuleSource(moduleSource, moduleRepositoryPath.success)
      if (Result.isFailure(moduleSourcePolicy)) {
        throw new CandidateDevelopmentSourceVerificationError('verify-module-format', moduleSourcePolicy.failure)
      }
      const [moduleBlobOid, sourceManifestBlobOid] = await runCandidateDevelopmentSourcePair(
        signal,
        (batchSignal) =>
          sourceStep('verify-module-blob', () =>
            sourceGit.text(repositoryRoot, ['rev-parse', moduleSpec], batchSignal),
          ),
        (batchSignal) =>
          sourceStep('verify-source-manifest-blob', () =>
            sourceGit.text(repositoryRoot, ['rev-parse', sourceManifestSpec], batchSignal),
          ),
      )
      {
        await verifyCandidateDevelopmentPreregistrationModuleNoveltyPromise(
          repositoryRoot,
          reviewedCandidatePreregistration.preregistration.sourceRevision,
          moduleRepositoryPath.success,
          moduleBlobOid,
          sourceGit,
          signal,
        )
      }
      const files: CandidateDevelopmentVerifiedSourceFiles = {
        schemaVersion: 'bayn.candidate-development-verified-source-files.v1',
        sourceRevision,
        modulePath: moduleRepositoryPath.success,
        moduleBlobOid,
        moduleSha256: sha256Bytes(moduleGitBytes),
        sourceManifestPath: sourceManifestRepositoryPath.success,
        sourceManifestBlobOid,
        sourceManifestSha256: sha256Bytes(sourceManifestGitBytes),
        sourceManifest: sourceManifest.success as CandidateDevelopmentSourceManifest,
      }
      return {
        files,
        moduleUrl: `data:text/javascript;base64,${moduleGitBytes.toString('base64')}`,
      }
    },
    catch: (cause): CandidateDevelopmentCommandFailure =>
      cause instanceof CandidateDevelopmentSourceVerificationError
        ? sourceVerificationFailure(cause.operation, cause.sourceCause)
        : sourceVerificationFailure('resolve-repository', cause),
  })
