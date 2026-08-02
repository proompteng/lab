import { describe, expect, test } from 'bun:test'
import {
  bindCandidateDevelopmentVerifiedSource,
  evaluateCandidateDevelopmentArtifact,
  executeCandidateDevelopmentArtifactRuntime,
  loadCandidateDevelopmentExecutableProgram,
  openCandidateDevelopmentGitBatchObjectReader,
  type CandidateDevelopmentSourceGit,
  type CandidateDevelopmentSourceManifest,
  type CandidateDevelopmentSourceVerifier,
  type CandidateDevelopmentVerifiedSourceFiles,
  verifyCandidateDevelopmentPreregistrationLineage,
  verifyCandidateDevelopmentPreregistrationModuleNovelty,
  verifyCandidateDevelopmentRepositoryIntegrity,
  verifyCandidateDevelopmentSourceFiles,
} from './test-api'
import {
  Effect,
  Fiber,
  dirname,
  join,
  mkdir,
  mkdtemp,
  pathToFileURL,
  resolve,
  rm,
  tmpdir,
  writeFile,
} from './test-runtime'
import {
  baselineFixture,
  commandEvaluationFixture,
  execFileBytesPromise,
  execFilePromise,
  execFileTextPromise,
  fixtureSourceManifest,
  frozenSourceInput,
  frozenSourceSourceManifestBytes,
  frozenSourceStrategyProtocol,
  frozenSourceStructuralBindings,
  frozenSourceVerifiedSourceFiles,
  frozenSourceVirtualPreregistrationSourceGit,
  initializeFrozenSourceDescendantRepository,
  reportFixture,
  successOf,
  syntheticFrozenSourceRuntime,
} from './test-support'

describe('candidate development source provenance', () => {
  test('verifies the source manifest and module as exact Git blobs', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    const dependencyPath = join(candidateDirectory, 'dependency.mjs')
    const sourceManifestPath = join(candidateDirectory, 'source-manifest.json')
    const moduleBytes = 'export const candidateDevelopmentProgram = {}\n'
    const dependencyBytes = 'export const dependency = 1\n'
    const sourceManifest: CandidateDevelopmentSourceManifest = {
      ...fixtureSourceManifest,
      modulePath: 'candidate/program.mjs',
    }
    const sourceManifestBytes = `${JSON.stringify(sourceManifest, null, 2)}\n`
    try {
      await mkdir(candidateDirectory, { recursive: true })
      await writeFile(modulePath, moduleBytes)
      await writeFile(dependencyPath, dependencyBytes)
      await writeFile(sourceManifestPath, sourceManifestBytes)
      await initializeFrozenSourceDescendantRepository(repository)
      await execFilePromise(
        'git',
        ['add', 'candidate/program.mjs', 'candidate/dependency.mjs', 'candidate/source-manifest.json'],
        repository,
      )
      await execFilePromise('git', ['commit', '-qm', 'test: bind candidate source'], repository)
      const sourceGit = frozenSourceVirtualPreregistrationSourceGit()

      const verified = await Effect.runPromise(
        verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit),
      )
      expect(verified.files.modulePath).toBe('candidate/program.mjs')
      expect(verified.files.sourceManifestPath).toBe('candidate/source-manifest.json')
      expect(verified.files.sourceRevision).toMatch(/^[0-9a-f]{40}$/)
      expect(verified.files.moduleBlobOid).toMatch(/^[0-9a-f]{40}$/)
      expect(Buffer.from(verified.moduleUrl.split(',')[1] ?? '', 'base64').toString('utf8')).toBe(moduleBytes)
      const mismatchedSourceRevision =
        '0'.repeat(40) === verified.files.sourceRevision ? '1'.repeat(40) : '0'.repeat(40)
      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit, mismatchedSourceRevision),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-head',
        cause: {
          field: 'expectedSourceRevision',
          expected: mismatchedSourceRevision,
          observed: verified.files.sourceRevision,
        },
      })

      const replacementPath = join(candidateDirectory, 'replacement.mjs')
      const replacementBytes = "throw new Error('replacement blob executed')\n"
      await writeFile(replacementPath, replacementBytes)
      const replacementOid = await execFileTextPromise(
        'git',
        ['hash-object', '-w', 'candidate/replacement.mjs'],
        repository,
      )
      await execFilePromise('git', ['replace', verified.files.moduleBlobOid, replacementOid], repository)
      expect(
        await Effect.runPromise(
          Effect.flip(verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit)),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'replaceRefs' },
      })
      await execFilePromise('git', ['replace', '-d', verified.files.moduleBlobOid], repository)

      await writeFile(modulePath, `${moduleBytes}// tampered\n`)
      const moduleDiskDrift = await Effect.runPromise(
        verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit),
      )
      expect(moduleDiskDrift.files.moduleSha256).toBe(verified.files.moduleSha256)
      expect(moduleDiskDrift.moduleUrl).toBe(verified.moduleUrl)

      await writeFile(modulePath, moduleBytes)
      await writeFile(sourceManifestPath, `${sourceManifestBytes} `)
      const manifestDiskDrift = await Effect.runPromise(
        verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit),
      )
      expect(manifestDiskDrift.files.sourceManifestSha256).toBe(verified.files.sourceManifestSha256)

      await writeFile(sourceManifestPath, sourceManifestBytes)
      await writeFile(modulePath, 'import "node:fs"\nexport const candidateDevelopmentProgram = {}\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: add imported dependency'], repository)
      expect(
        await Effect.runPromise(
          Effect.flip(verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit)),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-format',
      })
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  }, 60_000)

  test('ignores inherited Git repository-selection environment', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-environment-'))
    const alternateRepository = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-alternate-'))
    const candidateDirectory = join(repository, 'candidate')
    const alternateCandidateDirectory = join(alternateRepository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    const sourceManifestPath = join(candidateDirectory, 'source-manifest.json')
    const moduleBytes = 'export const candidateDevelopmentProgram = { source: "trusted" }\n'
    const alternateModuleBytes = 'export const candidateDevelopmentProgram = { source: "alternate" }\n'
    const sourceManifest = { ...fixtureSourceManifest, modulePath: 'candidate/program.mjs' }
    const sourceManifestBytes = `${JSON.stringify(sourceManifest, null, 2)}\n`
    const previousGitDir = process.env.GIT_DIR
    const previousGitWorkTree = process.env.GIT_WORK_TREE
    try {
      for (const [root, directory, bytes] of [
        [repository, candidateDirectory, moduleBytes],
        [alternateRepository, alternateCandidateDirectory, alternateModuleBytes],
      ] as const) {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'program.mjs'), bytes)
        await writeFile(join(directory, 'source-manifest.json'), sourceManifestBytes)
        await initializeFrozenSourceDescendantRepository(root)
        await execFilePromise('git', ['add', 'candidate/program.mjs', 'candidate/source-manifest.json'], root)
        await execFilePromise('git', ['commit', '-qm', 'test: bind source environment'], root)
      }
      const expectedRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const sourceGit = frozenSourceVirtualPreregistrationSourceGit()

      process.env.GIT_DIR = join(alternateRepository, '.git')
      process.env.GIT_WORK_TREE = repository
      const verified = await Effect.runPromise(
        verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit),
      )

      expect(verified.files.sourceRevision).toBe(expectedRevision)
      expect(Buffer.from(verified.moduleUrl.split(',')[1] ?? '', 'base64').toString('utf8')).toBe(moduleBytes)
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
      if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = previousGitWorkTree
      await rm(repository, { recursive: true, force: true })
      await rm(alternateRepository, { recursive: true, force: true })
    }
  }, 60_000)

  test('rejects grafts, replacement refs, and alternate object metadata before Git verification', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-repository-integrity-'))
    const alternateRepository = await mkdtemp(join(tmpdir(), 'bayn-candidate-alternate-objects-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    try {
      await mkdir(candidateDirectory, { recursive: true })
      await mkdir(join(alternateRepository, 'objects'), { recursive: true })
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)

      await writeFile(modulePath, 'export const candidate = "before-preregistration"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: candidate before preregistration'], repository)
      const priorRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const priorModuleOid = await execFileTextPromise('git', ['rev-parse', 'HEAD:candidate/program.mjs'], repository)

      await writeFile(modulePath, 'export const candidate = "preregistration-placeholder"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: preregistration placeholder'], repository)
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      expect(await execFileTextPromise('git', ['rev-parse', '--is-shallow-repository'], repository)).toBe('false')
      expect(
        await execFileTextPromise(
          'git',
          ['log', '--format=%H', `--find-object=${priorModuleOid}`, preregistrationRevision, '--'],
          repository,
        ),
      ).not.toBe('')
      expect(await Effect.runPromise(verifyCandidateDevelopmentRepositoryIntegrity(repository))).toBeUndefined()

      const graftsPath = resolve(
        repository,
        await execFileTextPromise('git', ['rev-parse', '--git-path', 'info/grafts'], repository),
      )
      await mkdir(dirname(graftsPath), { recursive: true })
      await writeFile(graftsPath, `${preregistrationRevision}\n`)
      expect(await execFileTextPromise('git', ['rev-parse', '--is-shallow-repository'], repository)).toBe('false')
      expect(
        await execFileTextPromise(
          'git',
          ['log', '--format=%H', `--find-object=${priorModuleOid}`, preregistrationRevision, '--'],
          repository,
        ),
      ).toBe('')
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'grafts', observed: [preregistrationRevision] },
      })
      await rm(graftsPath, { force: true })
      expect(await Effect.runPromise(verifyCandidateDevelopmentRepositoryIntegrity(repository))).toBeUndefined()

      await execFilePromise('git', ['replace', preregistrationRevision, priorRevision], repository)
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'replaceRefs' },
      })
      await execFilePromise('git', ['replace', '-d', preregistrationRevision], repository)

      await execFilePromise('git', ['config', 'replace.refBase', 'refs/custom-replace'], repository)
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'replacementConfig', observed: ['replace.refbase'] },
      })
      await execFilePromise('git', ['config', '--unset-all', 'replace.refBase'], repository)

      const alternatesPath = resolve(
        repository,
        await execFileTextPromise('git', ['rev-parse', '--git-path', 'objects/info/alternates'], repository),
      )
      await mkdir(dirname(alternatesPath), { recursive: true })
      await writeFile(alternatesPath, `${join(alternateRepository, 'objects')}\n`)
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'alternates' },
      })
      await rm(alternatesPath, { force: true })

      const httpAlternatesPath = resolve(
        repository,
        await execFileTextPromise('git', ['rev-parse', '--git-path', 'objects/info/http-alternates'], repository),
      )
      await writeFile(httpAlternatesPath, 'https://example.invalid/objects\n')
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'httpAlternates' },
      })
      await rm(httpAlternatesPath, { force: true })
      expect(await Effect.runPromise(verifyCandidateDevelopmentRepositoryIntegrity(repository))).toBeUndefined()
    } finally {
      await rm(repository, { recursive: true, force: true })
      await rm(alternateRepository, { recursive: true, force: true })
    }
  })

  test('cancels repository-integrity Git verification on interruption', async () => {
    let aborted = false
    const sourceGit: CandidateDevelopmentSourceGit = {
      text: (_repositoryRoot, _args, signal) =>
        new Promise((_resolve, reject) => {
          const abort = () => {
            aborted = true
            reject(signal?.reason ?? new Error('aborted'))
          }
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        }),
      bytes: async () => Buffer.alloc(0),
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* verifyCandidateDevelopmentRepositoryIntegrity('/tmp/repository', sourceGit).pipe(
          Effect.forkChild,
        )
        yield* Effect.sleep('10 millis')
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout('1 second'))
      }),
    )
    expect(aborted).toBe(true)
  })

  test('keeps module-history novelty independent from a graft inserted after preflight', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-graft-race-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    try {
      await mkdir(candidateDirectory, { recursive: true })
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)

      await writeFile(modulePath, 'export const candidate = "before-preregistration"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: candidate before preregistration'], repository)
      const priorModuleOid = await execFileTextPromise('git', ['rev-parse', 'HEAD:candidate/program.mjs'], repository)

      await writeFile(modulePath, 'export const candidate = "preregistration-placeholder"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: preregistration placeholder'], repository)
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const graftsPath = resolve(
        repository,
        await execFileTextPromise('git', ['rev-parse', '--git-path', 'info/grafts'], repository),
      )
      await mkdir(dirname(graftsPath), { recursive: true })

      let graftInserted = false
      const sourceGit: CandidateDevelopmentSourceGit = {
        text: async (repositoryRoot, args) => {
          if (!graftInserted && args[0] === 'cat-file' && args[1] === 'commit') {
            graftInserted = true
            await writeFile(graftsPath, `${preregistrationRevision}\n`)
          }
          return execFileTextPromise('git', ['--no-replace-objects', '-C', repositoryRoot, ...args], repositoryRoot)
        },
        bytes: (repositoryRoot, args) =>
          execFileBytesPromise('git', ['--no-replace-objects', '-C', repositoryRoot, ...args], repositoryRoot),
      }

      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationModuleNovelty(
              repository,
              preregistrationRevision,
              'candidate/program.mjs',
              priorModuleOid,
              sourceGit,
            ),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-module-novelty',
        cause: {
          preregistrationRevision,
          observed: priorModuleOid,
        },
      })
      expect(graftInserted).toBe(true)
      expect(await execFileTextPromise('git', ['rev-parse', '--is-shallow-repository'], repository)).toBe('false')
      expect(
        await execFileTextPromise(
          'git',
          ['log', '--format=%H', `--find-object=${priorModuleOid}`, preregistrationRevision, '--'],
          repository,
        ),
      ).toBe('')
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('requires preregistration to be a proper Git ancestor without replacement objects', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-preregistration-lineage-'))
    const markerPath = join(repository, 'marker.txt')
    try {
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)

      await writeFile(markerPath, 'root\n')
      await execFilePromise('git', ['add', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: root'], repository)
      const rootRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      await writeFile(markerPath, 'preregistered\n')
      await execFilePromise('git', ['add', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: preregister candidate'], repository)
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      await writeFile(markerPath, 'implemented\n')
      await execFilePromise('git', ['add', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: implement candidate'], repository)
      const properDescendantRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      expect(
        await Effect.runPromise(
          verifyCandidateDevelopmentPreregistrationLineage(
            repository,
            preregistrationRevision,
            properDescendantRevision,
          ),
        ),
      ).toBeUndefined()

      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationLineage(
              repository,
              preregistrationRevision,
              preregistrationRevision,
            ),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-lineage',
        cause: {
          expected: 'proper ancestor of evaluated source revision',
          observed: preregistrationRevision,
        },
      })

      await execFilePromise('git', ['checkout', '-qb', 'divergent', rootRevision], repository)
      await writeFile(markerPath, 'divergent implementation\n')
      await execFilePromise('git', ['add', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: divergent implementation'], repository)
      const divergentRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const divergentTree = await execFileTextPromise('git', ['rev-parse', `${divergentRevision}^{tree}`], repository)
      const replacementCommit = await execFileTextPromise(
        'git',
        ['commit-tree', divergentTree, '-p', preregistrationRevision, '-m', 'test: forged ancestry'],
        repository,
      )
      await execFilePromise('git', ['replace', divergentRevision, replacementCommit], repository)

      await execFilePromise(
        'git',
        ['merge-base', '--is-ancestor', preregistrationRevision, divergentRevision],
        repository,
      )
      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationLineage(repository, preregistrationRevision, divergentRevision),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'replaceRefs' },
      })
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('cancels preregistration lineage Git verification on interruption', async () => {
    let aborted = false
    const sourceGit: CandidateDevelopmentSourceGit = {
      text: (_repositoryRoot, args, signal) => {
        if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return Promise.resolve('false')
        if (args[0] === 'for-each-ref') return Promise.resolve('')
        if (args[0] === 'config' && args[1] === '--list') return Promise.resolve('')
        if (args[0] === 'rev-parse' && args[1] === '--git-path') return Promise.resolve(args[2] ?? '')
        return new Promise((_resolve, reject) => {
          const abort = () => {
            aborted = true
            reject(signal?.reason ?? new Error('aborted'))
          }
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      },
      bytes: async () => Buffer.alloc(0),
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* verifyCandidateDevelopmentPreregistrationLineage(
          '/tmp/repository',
          '1'.repeat(40),
          '2'.repeat(40),
          sourceGit,
        ).pipe(Effect.forkChild)
        yield* Effect.sleep('10 millis')
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout('1 second'))
      }),
    )
    expect(aborted).toBe(true)
  })

  test('requires the evaluated module blob to postdate all preregistration history', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-preregistration-module-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    const markerPath = join(repository, 'marker.txt')
    try {
      await mkdir(candidateDirectory, { recursive: true })
      const completedModule = 'export const candidate = "completed-before-preregistration"\n'
      await writeFile(modulePath, completedModule)
      await writeFile(markerPath, 'completed candidate\n')
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
      await execFilePromise('git', ['add', 'candidate/program.mjs', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: complete candidate before preregistration'], repository)
      const completedModuleOid = await execFileTextPromise(
        'git',
        ['rev-parse', 'HEAD:candidate/program.mjs'],
        repository,
      )

      await writeFile(modulePath, 'export const candidate = "preregistration-placeholder"\n')
      await writeFile(markerPath, 'preregistered\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: preregister after replacing implementation'], repository)
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      await writeFile(modulePath, completedModule)
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: restore pre-preregistered implementation'], repository)

      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationModuleNovelty(
              repository,
              preregistrationRevision,
              'candidate/program.mjs',
              completedModuleOid,
            ),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-module-novelty',
        cause: {
          preregistrationRevision,
          modulePath: 'candidate/program.mjs',
          expected: 'evaluated module blob created after preregistration',
          observed: completedModuleOid,
        },
      })

      await writeFile(modulePath, 'export const candidate = "implemented-after-preregistration"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: implement after preregistration'], repository)
      const laterModuleOid = await execFileTextPromise('git', ['rev-parse', 'HEAD:candidate/program.mjs'], repository)
      expect(
        await Effect.runPromise(
          verifyCandidateDevelopmentPreregistrationModuleNovelty(
            repository,
            preregistrationRevision,
            'candidate/program.mjs',
            laterModuleOid,
          ),
        ),
      ).toBeUndefined()
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('caches immutable subtrees across preregistration history', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-preregistration-tree-cache-'))
    const stableDirectory = join(repository, 'stable')
    const markerPath = join(repository, 'marker.txt')
    const modulePath = join(repository, 'candidate', 'program.mjs')
    try {
      await mkdir(stableDirectory, { recursive: true })
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
      await writeFile(join(stableDirectory, 'fixture.txt'), 'stable subtree\n')
      await writeFile(markerPath, 'one\n')
      await execFilePromise('git', ['add', 'stable/fixture.txt', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: first preregistration ancestor'], repository)
      for (const value of ['two', 'three']) {
        await writeFile(markerPath, `${value}\n`)
        await execFilePromise('git', ['add', 'marker.txt'], repository)
        await execFilePromise('git', ['commit', '-qm', `test: ${value} preregistration ancestor`], repository)
      }
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const stableTreeOid = await execFileTextPromise(
        'git',
        ['rev-parse', `${preregistrationRevision}:stable`],
        repository,
      )

      await mkdir(dirname(modulePath), { recursive: true })
      await writeFile(modulePath, 'export const candidate = "implemented-after-preregistration"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: implement candidate after preregistration'], repository)
      const moduleBlobOid = await execFileTextPromise('git', ['rev-parse', 'HEAD:candidate/program.mjs'], repository)

      const queriedTreeOids: string[] = []
      let objectReaderOpenCount = 0
      const sourceGit: CandidateDevelopmentSourceGit = {
        text: (repositoryRoot, args) =>
          execFileTextPromise('git', ['--no-replace-objects', '-C', repositoryRoot, ...args], repositoryRoot),
        bytes: (repositoryRoot, args) =>
          execFileBytesPromise('git', ['--no-replace-objects', '-C', repositoryRoot, ...args], repositoryRoot),
        openObjectReader: async (repositoryRoot) => {
          objectReaderOpenCount += 1
          return {
            read: async (oid, expectedType) => {
              if (expectedType === 'tree') queriedTreeOids.push(oid)
              return execFileBytesPromise(
                'git',
                ['--no-replace-objects', '-C', repositoryRoot, 'cat-file', expectedType, oid],
                repositoryRoot,
              )
            },
            close: async () => undefined,
          }
        },
      }

      expect(
        await Effect.runPromise(
          verifyCandidateDevelopmentPreregistrationModuleNovelty(
            repository,
            preregistrationRevision,
            'candidate/program.mjs',
            moduleBlobOid,
            sourceGit,
          ),
        ),
      ).toBeUndefined()
      expect(objectReaderOpenCount).toBe(1)
      expect(queriedTreeOids.filter((treeOid) => treeOid === stableTreeOid)).toHaveLength(1)
      expect(new Set(queriedTreeOids).size).toBe(queriedTreeOids.length)
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('terminates the production Git batch reader on cancellation', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-batch-cancellation-'))
    try {
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
      await writeFile(join(repository, 'marker.txt'), 'marker\n')
      await execFilePromise('git', ['add', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: batch reader cancellation'], repository)
      const revision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const controller = new AbortController()
      const reader = await openCandidateDevelopmentGitBatchObjectReader(repository, controller.signal)
      const commit = await reader.read(revision, 'commit')
      expect(commit.toString('utf8')).toContain('test: batch reader cancellation')
      controller.abort(new Error('test cancellation'))
      let rejected = false
      try {
        await reader.read(revision, 'commit')
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)
      await reader.close()
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('terminates the Git batch reader before buffering an oversized object', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-batch-oversized-'))
    try {
      await execFilePromise('git', ['init', '-q'], repository)
      const oversizedPath = join(repository, 'oversized.bin')
      await writeFile(oversizedPath, Buffer.alloc(4096, 0x61))
      const blobOid = await execFileTextPromise('git', ['hash-object', '-w', 'oversized.bin'], repository)
      const reader = await openCandidateDevelopmentGitBatchObjectReader(repository, new AbortController().signal, 128)
      let rejected = false
      try {
        await reader.read(blobOid, 'blob')
      } catch (cause) {
        rejected = true
        expect(String(cause)).toContain('maximumObjectBytes')
      }
      expect(rejected).toBe(true)
      await Promise.race([
        reader.close(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('oversized Git batch reader did not terminate')), 1_000),
        ),
      ])
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('rejects shallow Git history before module novelty verification', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-history-source-'))
    const shallowRepository = await mkdtemp(join(tmpdir(), 'bayn-candidate-history-shallow-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    try {
      await mkdir(candidateDirectory, { recursive: true })
      await writeFile(modulePath, 'export const candidate = "old"\n')
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: old candidate'], repository)
      await writeFile(modulePath, 'export const candidate = "new"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: new candidate'], repository)

      await rm(shallowRepository, { recursive: true, force: true })
      await execFilePromise(
        'git',
        ['clone', '-q', '--depth', '1', pathToFileURL(repository).href, shallowRepository],
        tmpdir(),
      )
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], shallowRepository)
      const moduleBlobOid = await execFileTextPromise(
        'git',
        ['rev-parse', 'HEAD:candidate/program.mjs'],
        shallowRepository,
      )
      expect(await execFileTextPromise('git', ['rev-parse', '--is-shallow-repository'], shallowRepository)).toBe('true')

      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationModuleNovelty(
              shallowRepository,
              preregistrationRevision,
              'candidate/program.mjs',
              moduleBlobOid,
            ),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'shallowRepository', expected: 'false', observed: 'true' },
      })
    } finally {
      await rm(repository, { recursive: true, force: true })
      await rm(shallowRepository, { recursive: true, force: true })
    }
  })

  test('pins verification and execution to the captured revision when HEAD moves', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-moving-head-'))
    const moduleRepositoryPath = 'candidate/program.mjs'
    const sourceManifestRepositoryPath = 'candidate/source-manifest.json'
    const modulePath = join(repository, moduleRepositoryPath)
    const sourceManifestPath = join(repository, sourceManifestRepositoryPath)
    const report = reportFixture(0.01)
    const baseEvaluation = commandEvaluationFixture(report, baselineFixture())
    const sourceA = `
      const evaluation = ${JSON.stringify(baseEvaluation)}
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(frozenSourceInput)},
        strategyProtocol: ${JSON.stringify(frozenSourceStrategyProtocol)},
        structuralBindings: ${JSON.stringify(frozenSourceStructuralBindings)},
        buildEvaluation: (verifiedSource) => ({
          ...evaluation,
          baseline: {
            ...evaluation.baseline,
            runId: verifiedSource.baselineRunId,
            codeRevision: verifiedSource.sourceRevision,
          },
          accounting: {
            ...evaluation.accounting,
            runId: verifiedSource.baselineRunId,
            stressedRunId: verifiedSource.stressedRunId,
          },
        }),
      }
    `
    const sourceB = `${sourceA}\n// moved HEAD must not execute\n`

    try {
      await initializeFrozenSourceDescendantRepository(repository)
      await mkdir(dirname(modulePath), { recursive: true })
      await writeFile(modulePath, sourceA)
      await writeFile(sourceManifestPath, frozenSourceSourceManifestBytes)
      await execFilePromise('git', ['add', moduleRepositoryPath, sourceManifestRepositoryPath], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: add trusted source A'], repository)
      const sourceRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      await writeFile(modulePath, sourceB)
      await execFilePromise('git', ['add', moduleRepositoryPath], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: add changed source B'], repository)
      const movedRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      const capturedRevisions: string[] = []
      const movingHeadGit: CandidateDevelopmentSourceGit = {
        text: async (repositoryRoot, args) => {
          const output = await execFileTextPromise('git', args, repositoryRoot)
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            capturedRevisions.push(output)
            await execFilePromise('git', ['reset', '--hard', movedRevision], repositoryRoot)
          }
          return output
        },
        bytes: (repositoryRoot, args) => execFileBytesPromise('git', args, repositoryRoot),
        openObjectReader: openCandidateDevelopmentGitBatchObjectReader,
      }
      let verificationPasses = 0
      const sourceVerifier: CandidateDevelopmentSourceVerifier = () =>
        Effect.promise(async () => {
          verificationPasses += 1
          await execFilePromise('git', ['reset', '--hard', sourceRevision], repository)
          const capturedRevision = await movingHeadGit.text(
            repository,
            ['rev-parse', 'HEAD'],
            new AbortController().signal,
          )
          const moduleBytes = await movingHeadGit.bytes(
            repository,
            ['show', `${capturedRevision}:${moduleRepositoryPath}`],
            new AbortController().signal,
          )
          return {
            files: { ...frozenSourceVerifiedSourceFiles, sourceRevision: capturedRevision },
            moduleUrl: `data:text/javascript;base64,${moduleBytes.toString('base64')}`,
          }
        })
      let importedSource = ''
      const importer = (moduleUrl: string, verifiedFiles: CandidateDevelopmentVerifiedSourceFiles) => {
        importedSource = Buffer.from(moduleUrl.split(',')[1] ?? '', 'base64').toString('utf8')
        return evaluateCandidateDevelopmentArtifact(moduleUrl, verifiedFiles)
      }

      const loaded = await Effect.runPromise(
        loadCandidateDevelopmentExecutableProgram(modulePath, sourceManifestPath, importer, sourceVerifier),
      )
      const expectedFiles: CandidateDevelopmentVerifiedSourceFiles = {
        ...frozenSourceVerifiedSourceFiles,
        sourceRevision,
      }
      const expectedVerifiedSource = successOf(bindCandidateDevelopmentVerifiedSource(expectedFiles, frozenSourceInput))
      const runtime = syntheticFrozenSourceRuntime(expectedVerifiedSource, expectedFiles)
      const decoded = await Effect.runPromise(
        executeCandidateDevelopmentArtifactRuntime(
          `data:text/javascript;base64,${Buffer.from(importedSource).toString('base64')}`,
          runtime.verifiedFiles,
          runtime.strategyProtocol,
          runtime.runtimeInput,
        ),
      )

      expect(verificationPasses).toBe(2)
      expect(capturedRevisions).toEqual([sourceRevision, sourceRevision])
      expect(importedSource).toBe(sourceA)
      expect(loaded.verifiedSource).toEqual(expectedVerifiedSource)
      expect(decoded.baseline.codeRevision).toBe(sourceRevision)
      expect(decoded.baseline.runId).toBe(expectedVerifiedSource.baselineRunId)
      expect(decoded.accounting.stressedRunId).toBe(expectedVerifiedSource.stressedRunId)
      expect(await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)).toBe(movedRevision)
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  }, 60_000)
})
