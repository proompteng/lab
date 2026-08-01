import { describe, expect, test } from 'bun:test'
import { join, mkdtemp, pathToFileURL, rm, spawn, tmpdir, writeFile } from './test-runtime'
import { execFileResultPromise } from './test-support'

describe('candidate development failure output', () => {
  test('distinguishes operational errors without rendering raw operational metadata', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-operational-errors-'))
    const nonRepository = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-not-repository-'))
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const cases = [
      {
        name: 'artifact-schema-version',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
          modulePath: 'services/bayn/src/candidate.mjs',
          cause: new TypeError('candidate artifact schema version is invalid'),
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
          modulePath: 'services/bayn/src/candidate.mjs',
          cause: {
            name: 'TypeError',
            category: 'artifact-schema-version-invalid',
          },
        },
      },
      {
        name: 'artifact-strategy-protocol-hash',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
          modulePath: 'services/bayn/src/candidate.mjs',
          cause: new TypeError('candidate artifact strategy protocol hash differs from preflight'),
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
          modulePath: 'services/bayn/src/candidate.mjs',
          cause: {
            name: 'TypeError',
            category: 'artifact-strategy-protocol-hash-mismatch',
          },
        },
      },
      {
        name: 'worker-serialized-artifact-schema-version',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
          modulePath: 'services/bayn/src/candidate.mjs',
          cause: {
            name: 'TypeError',
            message: 'candidate artifact schema version is invalid',
            stack: 'TypeError: candidate artifact schema version is invalid at /home/alice/private-worker.ts',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
          modulePath: 'services/bayn/src/candidate.mjs',
          cause: {
            name: 'TypeError',
            category: 'artifact-schema-version-invalid',
          },
        },
      },
      {
        name: 'worker-serialized-program-error',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
          cause: {
            name: 'RangeError',
            message: 'private runtime detail must-not-render',
            stack: 'RangeError: private runtime detail at /home/alice/private-worker.ts',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
          cause: {
            name: 'RangeError',
          },
        },
      },
      {
        name: 'module-format-parser-error',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-module-format',
          cause: {
            modulePath: 'services/bayn/src/candidate.mjs',
            cause: new SyntaxError('Unexpected token near /home/alice/private-source.mjs'),
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-module-format',
          cause: {
            modulePath: 'services/bayn/src/candidate.mjs',
            cause: {
              name: 'SyntaxError',
            },
          },
        },
      },
      {
        name: 'git-batch-object-missing',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: new Error('candidate Git object is missing: ${'a'.repeat(40)}'),
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            name: 'Error',
            category: 'git-object-missing',
          },
        },
      },
      {
        name: 'git-batch-header-invalid',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: new Error('candidate Git batch header is invalid: private-header-must-not-render'),
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            name: 'Error',
            category: 'git-batch-header-invalid',
          },
        },
      },
      {
        name: 'git-batch-object-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: new Error('candidate Git batch object mismatch: private-object-must-not-render'),
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            name: 'Error',
            category: 'git-batch-object-mismatch',
          },
        },
      },
      {
        name: 'git-batch-exit',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: new Error('candidate Git batch exited 128: fatal private-stderr-must-not-render'),
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            name: 'Error',
            category: 'git-batch-exit',
          },
        },
      },
      {
        name: 'artifact-worker-exit',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
          modulePath: 'services/bayn/src/candidate.mjs',
          cause: new Error('candidate artifact worker exited 7'),
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
          modulePath: 'services/bayn/src/candidate.mjs',
          cause: {
            name: 'Error',
            category: 'artifact-worker-exit',
          },
        },
      },
      {
        name: 'realpath-failure',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'read-module',
          cause: Object.assign(new Error('ENOENT: no such file or directory, realpath /home/alice/private/candidate.mjs'), {
            code: 'ENOENT',
            errno: -2,
            syscall: 'realpath',
            path: '/home/alice/private/candidate.mjs',
            environment: { GITHUB_TOKEN: 'must-not-render' },
            credential: 'must-not-render',
          }),
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'read-module',
          cause: {
            name: 'Error',
            code: 'ENOENT',
            errno: -2,
            syscall: 'realpath',
          },
        },
      },
      {
        name: 'git-failure',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'resolve-repository',
          cause: Object.assign(new Error('Command failed: git --no-replace-objects -C /home/alice/private rev-parse --show-toplevel'), {
            code: 128,
            killed: false,
            signal: null,
            cmd: 'git --no-replace-objects -C /home/alice/private rev-parse --show-toplevel',
            stdout: 'must-not-render',
            stderr: 'fatal: credential must-not-render',
            path: '/home/alice/private',
          }),
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'resolve-repository',
          cause: {
            name: 'Error',
            code: 128,
            signal: null,
            killed: false,
          },
        },
      },
    ] as const

    try {
      for (const testCase of cases) {
        const scriptPath = join(directory, `${testCase.name}.ts`)
        const script = `
import { Effect } from 'effect'
import { runCandidateDevelopmentCommandMain } from ${JSON.stringify(commandUrl)}

runCandidateDevelopmentCommandMain(Effect.fail(${testCase.failureExpression}))
`
        await writeFile(scriptPath, script)
        const result = await execFileResultPromise(process.execPath, [scriptPath], import.meta.dir)
        const expected = `${JSON.stringify({
          schemaVersion: 'bayn.candidate-development-command-failure.v1',
          error: {
            _tag: 'CandidateDevelopmentCommandError',
            failure: testCase.expectedFailure,
          },
        })}\n`

        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toBe(expected)
        expect(result.stderr).not.toContain('must-not-render')
        expect(result.stderr).not.toContain('/home/alice')
        expect(result.stderr).not.toContain('git --no-replace-objects')
        expect(result.stderr).not.toContain('GITHUB_TOKEN')
        expect(result.stderr).not.toContain('candidate artifact schema version is invalid')
        expect(result.stderr).not.toContain('candidate artifact strategy protocol hash differs from preflight')
        expect(result.stderr).not.toContain('private-header-must-not-render')
        expect(result.stderr).not.toContain('private-object-must-not-render')
        expect(result.stderr).not.toContain('private-stderr-must-not-render')
      }

      const missingModulePath = join(directory, 'missing', 'private-candidate.mjs')
      const missingManifestPath = join(directory, 'missing', 'private-manifest.json')
      const realpathScriptPath = join(directory, 'realpath-failure.ts')
      await writeFile(
        realpathScriptPath,
        `
import {
  runCandidateDevelopmentCommandMain,
  verifyCandidateDevelopmentSourceFiles,
} from ${JSON.stringify(commandUrl)}

runCandidateDevelopmentCommandMain(
  verifyCandidateDevelopmentSourceFiles(
    ${JSON.stringify(missingModulePath)},
    ${JSON.stringify(missingManifestPath)},
  ),
)
`,
      )
      const realpathResult = await execFileResultPromise(process.execPath, [realpathScriptPath], import.meta.dir)
      const realpathFailure = JSON.parse(realpathResult.stderr)
      expect(realpathResult.exitCode).toBe(1)
      expect(realpathResult.stdout).toBe('')
      expect(realpathFailure).toMatchObject({
        error: {
          failure: {
            _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
            operation: 'read-module',
            cause: {
              name: 'Error',
              code: 'ENOENT',
              errno: -2,
            },
          },
        },
      })
      expect(['lstat', 'realpath']).toContain(realpathFailure.error.failure.cause.syscall)
      expect(Object.keys(realpathFailure.error.failure.cause).toSorted()).toEqual(['code', 'errno', 'name', 'syscall'])
      expect(realpathResult.stderr).not.toContain(directory)
      expect(realpathResult.stderr).not.toContain('private-candidate')
      expect(realpathResult.stderr).not.toContain('ENOENT:')

      const modulePath = join(nonRepository, 'program.mjs')
      const manifestPath = join(nonRepository, 'source-manifest.json')
      await writeFile(modulePath, 'export const safe = true\n')
      await writeFile(manifestPath, '{}\n')
      const gitScriptPath = join(directory, 'git-failure.ts')
      await writeFile(
        gitScriptPath,
        `
import {
  runCandidateDevelopmentCommandMain,
  verifyCandidateDevelopmentSourceFiles,
} from ${JSON.stringify(commandUrl)}

runCandidateDevelopmentCommandMain(
  verifyCandidateDevelopmentSourceFiles(
    ${JSON.stringify(modulePath)},
    ${JSON.stringify(manifestPath)},
  ),
)
`,
      )
      const gitResult = await execFileResultPromise(process.execPath, [gitScriptPath], import.meta.dir)
      const gitFailure = JSON.parse(gitResult.stderr)
      expect(gitResult.exitCode).toBe(1)
      expect(gitResult.stdout).toBe('')
      expect(gitFailure).toMatchObject({
        error: {
          failure: {
            _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
            operation: 'resolve-repository',
            cause: {
              name: 'Error',
              code: 128,
              signal: null,
              killed: false,
            },
          },
        },
      })
      expect(Object.keys(gitFailure.error.failure.cause).toSorted()).toEqual(['code', 'killed', 'name', 'signal'])
      expect(gitResult.stderr).not.toContain(directory)
      expect(gitResult.stderr).not.toContain('not-a-repository')
      expect(gitResult.stderr).not.toContain('rev-parse')
      expect(gitResult.stderr).not.toContain('fatal:')
      expect(gitResult.stderr).not.toContain('git --no-replace-objects')
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(nonRepository, { recursive: true, force: true })
    }
  }, 15_000)

  test('keeps interruption-only shutdown silent and unwinds the command scope', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-interruption-'))
    const scriptPath = join(directory, 'interruption.ts')
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const script = `
import { Effect } from 'effect'
import { runCandidateDevelopmentCommandMain } from ${JSON.stringify(commandUrl)}

const initialSigtermListenerCount = process.listenerCount('SIGTERM')

runCandidateDevelopmentCommandMain(
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<void>((resolveReady) => {
            const inspect = () => {
              if (process.listenerCount('SIGTERM') > initialSigtermListenerCount) resolveReady()
              else setImmediate(inspect)
            }
            inspect()
          }),
      ).pipe(Effect.tap(() => Effect.sync(() => process.stdout.write('ready\\n')))),
      () => Effect.sync(() => process.stdout.write('finalized\\n')),
    ).pipe(Effect.flatMap(() => Effect.never)),
  ),
)
`

    try {
      await writeFile(scriptPath, script)
      const result = await new Promise<{
        readonly exitCode: number | null
        readonly signal: NodeJS.Signals | null
        readonly stdout: string
        readonly stderr: string
      }>((resolveExecution, rejectExecution) => {
        const child = spawn(process.execPath, [scriptPath], {
          cwd: import.meta.dir,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let interrupted = false
        const timeout = setTimeout(() => {
          child.kill('SIGKILL')
          rejectExecution(new Error('candidate development interruption process did not terminate'))
        }, 5_000)
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
          if (!interrupted && stdout.includes('ready\n')) {
            interrupted = true
            if (!child.kill('SIGTERM')) rejectExecution(new Error('failed to interrupt candidate development process'))
          }
        })
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk
        })
        child.once('error', (error) => {
          clearTimeout(timeout)
          rejectExecution(error)
        })
        child.once('close', (exitCode, signal) => {
          clearTimeout(timeout)
          resolveExecution({ exitCode, signal, stdout, stderr })
        })
      })

      expect(result.exitCode).toBe(130)
      expect(result.signal).toBeNull()
      expect(result.stdout).toBe('ready\nfinalized\n')
      expect(result.stderr).toBe('')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('renders one bounded generic record for an unhandled command defect', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-defect-'))
    const scriptPath = join(directory, 'defect.ts')
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const script = `
import { Effect } from 'effect'
import { runCandidateDevelopmentCommandMain } from ${JSON.stringify(commandUrl)}

runCandidateDevelopmentCommandMain(
  Effect.sync(() => {
    throw new Error('credential-value at /workspace/private/defect.ts:1:1')
  }),
)
`

    try {
      await writeFile(scriptPath, script)
      const result = await execFileResultPromise(process.execPath, [scriptPath], import.meta.dir)
      const expected = `${JSON.stringify({
        schemaVersion: 'bayn.candidate-development-command-failure.v1',
        error: {
          _tag: 'CandidateDevelopmentCommandDefect',
          reason: 'unhandled-defect',
        },
      })}\n`

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(expected)
      expect(result.stderr).not.toContain('credential-value')
      expect(result.stderr).not.toContain('/workspace/')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('falls back to a generic record when the configured failure writer defects', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-writer-defect-'))
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const cases = [
      {
        name: 'returned-effect-defect',
        writer: `() => Effect.die(new Error('credential-value at /workspace/private/stderr.ts:1:1'))`,
      },
      {
        name: 'synchronous-throw',
        writer: `() => { throw new Error('credential-value at /workspace/private/stderr.ts:1:1') }`,
      },
    ] as const
    const expected = `${JSON.stringify({
      schemaVersion: 'bayn.candidate-development-command-failure.v1',
      error: {
        _tag: 'CandidateDevelopmentCommandDefect',
        reason: 'unhandled-defect',
      },
    })}\n`

    try {
      for (const testCase of cases) {
        const scriptPath = join(directory, `${testCase.name}.ts`)
        const script = `
import { Effect } from 'effect'
import { runCandidateDevelopmentCommandMain } from ${JSON.stringify(commandUrl)}

runCandidateDevelopmentCommandMain(
  Effect.fail({ _tag: 'CandidateDevelopmentCommandModulePathMissing' }),
  ${testCase.writer},
)
`
        await writeFile(scriptPath, script)
        const result = await execFileResultPromise(process.execPath, [scriptPath], import.meta.dir)

        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toBe(expected)
        expect(result.stderr).not.toContain('credential-value')
        expect(result.stderr).not.toContain('/workspace/')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('preserves success output without emitting a failure record', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-success-'))
    const scriptPath = join(directory, 'success.ts')
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const script = `
import { Effect } from 'effect'
import { runCandidateDevelopmentCommandMain } from ${JSON.stringify(commandUrl)}

runCandidateDevelopmentCommandMain(
  Effect.sync(() => {
    process.stdout.write('candidate-development-success\\n')
  }),
)
`

    try {
      await writeFile(scriptPath, script)
      const result = await execFileResultPromise(process.execPath, [scriptPath], import.meta.dir)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('candidate-development-success\n')
      expect(result.stderr).toBe('')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
