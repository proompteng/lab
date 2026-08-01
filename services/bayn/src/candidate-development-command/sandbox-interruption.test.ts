import { describe, expect, test } from 'bun:test'
import {
  bindCandidateDevelopmentVerifiedSource,
  candidateDevelopmentExecutableProgramSchemaVersion,
  evaluateCandidateDevelopmentArtifact,
  executeCandidateDevelopmentArtifactRuntime,
  loadCandidateDevelopmentExecutableProgram,
  type CandidateDevelopmentSourceGit,
  validateCandidateDevelopmentExecutableProgram,
  verifyCandidateDevelopmentSourceFiles,
} from './test-api'
import { Deferred, Effect, Fiber, join, mkdtemp, realpath, rm, tmpdir, writeFile } from './test-runtime'
import {
  fixtureStrategyProtocol,
  fixtureStrategyProtocolHash,
  fixtureVerifiedModuleSource,
  fixtureVerifiedSourceFiles,
  frozenSourceInput,
  frozenSourcePreregistrationBlobOid,
  frozenSourcePreregistrationBytes,
  frozenSourcePreregistrationPath,
  frozenSourcePreregistrationRevision,
  frozenSourceStrategyProtocol,
  frozenSourceStructuralBindings,
  frozenSourceVerifiedSourceFiles,
  successOf,
  syntheticFrozenSourceRuntime,
} from './test-support'

describe('candidate development sandbox interruption', () => {
  test('interrupts a real infinite-loop artifact worker promptly', async () => {
    const input = frozenSourceInput
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(frozenSourceStrategyProtocol)},
        structuralBindings: ${JSON.stringify(frozenSourceStructuralBindings)},
        buildEvaluation: (verifiedSource) => {
          if (
            verifiedSource.sourceRevision === '' ||
            verifiedSource.baselineRunId === '' ||
            verifiedSource.stressedRunId === ''
          ) return {}
          while (true) {}
        },
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    const loaded = await Effect.runPromise(
      evaluateCandidateDevelopmentArtifact(moduleUrl, frozenSourceVerifiedSourceFiles),
    )
    const program = successOf(
      validateCandidateDevelopmentExecutableProgram(
        (loaded as { readonly candidateDevelopmentProgram?: unknown }).candidateDevelopmentProgram,
      ),
    )
    expect(program.input).toEqual(frozenSourceInput)
    const verifiedSource = successOf(bindCandidateDevelopmentVerifiedSource(frozenSourceVerifiedSourceFiles, input))
    const runtime = syntheticFrozenSourceRuntime(verifiedSource)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* executeCandidateDevelopmentArtifactRuntime(
          moduleUrl,
          runtime.verifiedFiles,
          runtime.strategyProtocol,
          runtime.runtimeInput,
        ).pipe(Effect.forkChild)
        yield* Effect.sleep('50 millis')
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout('1 second'))
      }),
    )
  })

  test('rejects async artifact execution before entering the sandbox', async () => {
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: {},
        strategyProtocol: {},
        buildEvaluation: async () => ({}),
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-format',
        cause: { identifiers: ['async'] },
      },
    })
  })

  test('rejects nonliteral dynamic imports before sandbox execution', async () => {
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: {},
        strategyProtocol: {},
        buildEvaluation: () => import('node:' + 'fs').catch(() => ({})),
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-format',
        cause: { identifiers: ['import'] },
      },
    })
  })

  test('rejects ShadowRealm before sandbox execution', async () => {
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: {},
        strategyProtocol: {},
        buildEvaluation: () => new ShadowRealm().evaluate('Math.random()'),
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-format',
        cause: { identifiers: ['ShadowRealm'] },
      },
    })
  })

  test('rejects Bun Loader before sandbox execution', async () => {
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: {},
        strategyProtocol: {},
        buildEvaluation: () => Loader,
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-format',
        cause: { identifiers: ['Loader'] },
      },
    })
  })

  test('rejects source drift during import before returning an executable program', async () => {
    const program = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      strategyProtocol: fixtureStrategyProtocol,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
        officialSessions: [],
        signalSessionDates: [],
        featureLookbackSessions: 126,
      },
      effects: {
        preregisterCandidate: () => Effect.succeed('registration'),
        loadDevelopmentData: () => Effect.succeed('data'),
        evaluateDevelopment: () => Effect.fail('not-executed'),
      },
    }
    let verificationCount = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        loadCandidateDevelopmentExecutableProgram(
          '/tmp/candidate-development-program.ts',
          '/tmp/candidate-development-source-manifest.json',
          () => Effect.succeed({ candidateDevelopmentProgram: program }),
          () => {
            verificationCount += 1
            return Effect.succeed(
              verificationCount === 1
                ? fixtureVerifiedModuleSource
                : {
                    ...fixtureVerifiedModuleSource,
                    files: { ...fixtureVerifiedSourceFiles, moduleSha256: 'f'.repeat(64) },
                  },
            )
          },
        ),
      ),
    )

    expect(verificationCount).toBe(2)
    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-post-import',
    })
  })

  test('does not import a module when Git source verification fails', async () => {
    let imports = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        loadCandidateDevelopmentExecutableProgram(
          '/tmp/candidate-development-program.ts',
          '/tmp/candidate-development-source-manifest.json',
          () => {
            imports += 1
            return Effect.succeed({})
          },
          () =>
            Effect.fail({
              _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
              operation: 'verify-module-blob',
              cause: 'tampered',
            }),
        ),
      ),
    )

    expect(imports).toBe(0)
    expect(failure).toEqual({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-blob',
      cause: 'tampered',
    })
  })

  test('aborts a stalled source Git subprocess when verification is interrupted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-abort-'))
    const modulePath = join(directory, 'program.mjs')
    const sourceManifestPath = join(directory, 'source-manifest.json')
    let resolveStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let aborted = false
    const sourceGit: CandidateDevelopmentSourceGit = {
      text: (_repositoryRoot, _args, signal) =>
        new Promise((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error('source verification did not provide an abort signal'))
            return
          }
          resolveStarted?.()
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal.reason ?? new Error('source verification aborted'))
            },
            { once: true },
          )
        }),
      bytes: () => Promise.reject(new Error('source byte read must not start')),
    }

    try {
      await writeFile(modulePath, 'export const candidateDevelopmentArtifact = {}\n')
      await writeFile(sourceManifestPath, '{}\n')
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit).pipe(
            Effect.forkChild,
          )
          yield* Effect.promise(() => started)
          yield* Fiber.interrupt(fiber)
        }),
      )
      expect(aborted).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('aborts and joins a sibling source Git read after batch failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-pair-abort-'))
    const modulePath = join(directory, 'program.mjs')
    const sourceManifestPath = join(directory, 'source-manifest.json')
    const sourceRevision = 'a'.repeat(40)
    const sourceTreeOid = 'b'.repeat(40)
    const preregistrationTreeOid = 'c'.repeat(40)
    const preregistrationSpec = `${frozenSourcePreregistrationRevision}:${frozenSourcePreregistrationPath}`
    let siblingStarted = false
    let siblingAborted = false
    let siblingSettled = false
    const sourceGit: CandidateDevelopmentSourceGit = {
      text: (_repositoryRoot, args) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return realpath(directory)
        if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return Promise.resolve('false')
        if (args[0] === 'for-each-ref') return Promise.resolve('')
        if (args[0] === 'config' && args[1] === '--list') return Promise.resolve('')
        if (args[0] === 'rev-parse' && args[1] === '--git-path') return Promise.resolve(args[2] ?? '')
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return Promise.resolve(sourceRevision)
        if (args[0] === 'rev-parse' && args[1] === preregistrationSpec) {
          return Promise.resolve(frozenSourcePreregistrationBlobOid)
        }
        return Promise.reject(new Error(`unexpected Git text command: ${args.join(' ')}`))
      },
      bytes: (_repositoryRoot, args, signal) => {
        const spec = args.at(-1) ?? ''
        if (spec === preregistrationSpec) return Promise.resolve(frozenSourcePreregistrationBytes)
        if (spec.endsWith(':program.mjs')) return Promise.reject(new Error('module blob failed'))
        return new Promise((_resolve, reject) => {
          siblingStarted = true
          if (signal === undefined) {
            siblingSettled = true
            reject(new Error('paired source read did not receive an abort signal'))
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              siblingAborted = true
              siblingSettled = true
              reject(signal.reason ?? new Error('paired source read aborted'))
            },
            { once: true },
          )
        })
      },
      openObjectReader: async () => ({
        read: async (oid, expectedType) => {
          if (expectedType !== 'commit') throw new Error(`unexpected object type: ${expectedType}`)
          if (oid === sourceRevision) {
            return Buffer.from(
              `tree ${sourceTreeOid}\nparent ${frozenSourcePreregistrationRevision}\n\nsource revision\n`,
            )
          }
          if (oid === frozenSourcePreregistrationRevision) {
            return Buffer.from(`tree ${preregistrationTreeOid}\n\npreregistration revision\n`)
          }
          throw new Error(`unexpected commit object: ${oid}`)
        },
        close: async () => undefined,
      }),
    }

    try {
      await writeFile(modulePath, 'export const candidateDevelopmentArtifact = {}\n')
      await writeFile(sourceManifestPath, '{}\n')
      const failure = await Effect.runPromise(
        Effect.flip(verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit)),
      )

      expect(failure).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-blob',
      })
      expect(siblingStarted).toBe(true)
      expect(siblingAborted).toBe(true)
      expect(siblingSettled).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('interrupts dynamic module evaluation without detaching it', async () => {
    const program = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      strategyProtocol: fixtureStrategyProtocol,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
        officialSessions: [],
        signalSessionDates: [],
        featureLookbackSessions: 126,
      },
      effects: {
        preregisterCandidate: () => Effect.succeed('registration'),
        loadDevelopmentData: () => Effect.succeed('data'),
        evaluateDevelopment: () => Effect.fail('not-executed'),
      },
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let completed = false
        const fiber = yield* loadCandidateDevelopmentExecutableProgram(
          '/tmp/candidate-development-program.ts',
          '/tmp/candidate-development-source-manifest.json',
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.tap(() =>
                Effect.sync(() => {
                  completed = true
                }),
              ),
              Effect.as({ candidateDevelopmentProgram: program }),
            ),
          () => Effect.succeed(fixtureVerifiedModuleSource),
        ).pipe(Effect.forkChild)

        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect(completed).toBe(false)

        yield* Deferred.succeed(release, undefined)
        yield* Effect.yieldNow

        expect(completed).toBe(false)
      }),
    )
  })
})
