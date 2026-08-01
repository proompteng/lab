import { describe, expect, test } from 'bun:test'
import { join, mkdtemp, pathToFileURL, rm, writeFile } from './test-runtime'
import { execFileResultPromise } from './test-support'

describe('candidate development failure projection', () => {
  test('preserves exact insufficient walk-forward preflight details without arbitrary data', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-preflight-failure-'))
    const scriptPath = join(directory, 'preflight-failure.ts')
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const developmentUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development.ts')).href
    const script = `
import { Effect, Result } from 'effect'
import { runCandidateDevelopmentCommandMain } from ${JSON.stringify(commandUrl)}
import { computeEndAnchoredWalkForwardBoundaries } from ${JSON.stringify(developmentUrl)}

const decision = computeEndAnchoredWalkForwardBoundaries(
  ['2020-01-02', '2020-01-03', '2020-01-06'],
  1,
  { minimumTrainingSessions: 4, testSessions: 2, requiredFolds: 2 },
)
const preflight = Result.getOrThrow(decision)
if (preflight.status !== 'FAIL') {
  throw new Error('expected insufficient walk-forward geometry')
}

runCandidateDevelopmentCommandMain(
  Effect.fail({
    _tag: 'CandidateDevelopmentPreflightFailed',
    preflight: {
      ...preflight,
      secret: 'must-not-render',
      stack: '/workspace/private/preflight.ts:1:1',
      timestamp: '2026-07-31T18:00:00.000Z',
    },
  }),
)
`

    try {
      await writeFile(scriptPath, script)
      const result = await execFileResultPromise(process.execPath, [scriptPath], import.meta.dir)
      const expected = `${JSON.stringify({
        schemaVersion: 'bayn.candidate-development-command-failure.v1',
        error: {
          _tag: 'CandidateDevelopmentCommandError',
          failure: {
            _tag: 'CandidateDevelopmentPreflightFailed',
            preflight: {
              status: 'FAIL',
              reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS',
              requiredObservations: 8,
              availableObservations: 2,
              availableFoldCount: 0,
              requiredFoldCount: 2,
              observationDeficit: 6,
            },
          },
        },
      })}\n`

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(expected)
      expect(result.stderr).not.toContain('must-not-render')
      expect(result.stderr).not.toContain('/workspace/')
      expect(result.stderr).not.toContain('2026-07-31')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('preserves known untagged binding mismatch details without arbitrary data', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-binding-mismatch-'))
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const cases = [
      {
        name: 'strategy-protocol-hash',
        failure: {
          _tag: 'CandidateDevelopmentCommandProgramInvalid',
          reason: 'strategy-protocol-hash-mismatch',
          cause: {
            expected: 'a'.repeat(64),
            observed: 'b'.repeat(64),
            secret: 'must-not-render',
            stack: '/workspace/private/program.ts:1:1',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandProgramInvalid',
          reason: 'strategy-protocol-hash-mismatch',
          cause: {
            expected: 'a'.repeat(64),
            observed: 'b'.repeat(64),
          },
        },
      },
      {
        name: 'verified-program-binding',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'artifact.structuralBindings.strategyProtocolHash',
            expected: 'c'.repeat(64),
            observed: 'd'.repeat(64),
            secret: 'must-not-render',
            path: '/workspace/private/manifest.json',
            timestamp: '2026-07-31T18:00:00.000Z',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'artifact.structuralBindings.strategyProtocolHash',
            expected: 'c'.repeat(64),
            observed: 'd'.repeat(64),
          },
        },
      },
      {
        name: 'source-path-binding',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-source-paths',
          cause: {
            field: 'modulePath',
            expected: 'services/bayn/src/expected.ts',
            observed: 'services/bayn/src/observed.ts',
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-source-paths',
          cause: {
            field: 'modulePath',
            expected: 'services/bayn/src/expected.ts',
            observed: 'services/bayn/src/observed.ts',
          },
        },
      },
      {
        name: 'preregistration-blob-binding',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-blob',
          cause: {
            field: 'marketData.snapshotId',
            expected: 'e'.repeat(64),
            observed: 'f'.repeat(64),
            secret: 'must-not-render',
            path: '/workspace/private/preregistration.json',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-blob',
          cause: {
            field: 'marketData.snapshotId',
            expected: 'e'.repeat(64),
            observed: 'f'.repeat(64),
          },
        },
      },
      {
        name: 'malformed-preregistration-binding',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-blob',
          cause: {
            expected: 'lowercase Git revision/blob OID and repository-relative preregistration path',
            observed: {
              sourceRevision: 'not-a-revision',
              blobOid: 'e'.repeat(40),
              path: '../../../home/alice/private-preregistration.json',
              secret: 'must-not-render',
            },
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-blob',
          cause: {
            expected: 'lowercase Git revision/blob OID and repository-relative preregistration path',
            observed: {
              sourceRevision: {
                _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
                reason: 'unsupported-value',
              },
              blobOid: 'e'.repeat(40),
              path: {
                _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
                reason: 'unsupported-value',
              },
            },
          },
        },
      },
      {
        name: 'preregistration-blob-oid-mismatch',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-blob',
          cause: {
            revision: 'a'.repeat(40),
            path: 'candidate/preregistration.json',
            expected: 'b'.repeat(40),
            observed: 'c'.repeat(40),
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-blob',
          cause: {
            expected: 'b'.repeat(40),
            observed: 'c'.repeat(40),
          },
        },
      },
      {
        name: 'post-import-binding',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-post-import',
          cause: {
            expected: '1'.repeat(64),
            observed: '2'.repeat(64),
            secret: 'must-not-render',
            stack: '/workspace/private/post-import.ts:1:1',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-post-import',
          cause: {
            expected: '1'.repeat(64),
            observed: '2'.repeat(64),
          },
        },
      },
      {
        name: 'artifact-preflight-failure',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'artifact.preflight',
            expected: 'PASS',
            observed: {
              _tag: 'CandidateDevelopmentGeometryIntegerInvalid',
              field: 'testSessions',
              value: 1.5,
              secret: 'must-not-render',
            },
            token: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'artifact.preflight',
            expected: 'PASS',
            observed: {
              _tag: 'CandidateDevelopmentGeometryIntegerInvalid',
              field: 'testSessions',
              value: 1.5,
            },
          },
        },
      },
      {
        name: 'artifact-preflight-decision',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'artifact.preflight',
            expected: 'PASS',
            observed: {
              status: 'FAIL',
              reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS',
              requiredObservations: 8,
              availableObservations: 2,
              availableFoldCount: 0,
              requiredFoldCount: 2,
              observationDeficit: 6,
              secret: 'must-not-render',
            },
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'artifact.preflight',
            expected: 'PASS',
            observed: {
              status: 'FAIL',
              reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS',
              requiredObservations: 8,
              availableObservations: 2,
              availableFoldCount: 0,
              requiredFoldCount: 2,
              observationDeficit: 6,
            },
          },
        },
      },
      {
        name: 'repository-shallow-state',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-repository-integrity',
          cause: {
            field: 'shallowRepository',
            expected: 'false',
            observed: 'true',
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-repository-integrity',
          cause: {
            field: 'shallowRepository',
            expected: 'false',
            observed: 'true',
          },
        },
      },
      {
        name: 'repository-replace-refs',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-repository-integrity',
          cause: {
            field: 'replaceRefs',
            expected: [],
            observed: [`refs/replace/${'a'.repeat(40)}`],
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-repository-integrity',
          cause: {
            field: 'replaceRefs',
            expected: [],
            observed: [`refs/replace/${'a'.repeat(40)}`],
          },
        },
      },
      {
        name: 'repository-replacement-config',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-repository-integrity',
          cause: {
            field: 'replacementConfig',
            expected: [],
            observed: [`replace.${'b'.repeat(40)}.name`],
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-repository-integrity',
          cause: {
            field: 'replacementConfig',
            expected: [],
            observed: [`replace.${'b'.repeat(40)}.name`],
          },
        },
      },
      {
        name: 'repository-alternate-path-redaction',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-repository-integrity',
          cause: {
            field: 'alternates',
            expected: [],
            observed: ['/home/alice/private-repo/objects', '../../../home/alice/private-repo/objects'],
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-repository-integrity',
          cause: {
            field: 'alternates',
            expected: [],
            observed: [
              {
                _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
                reason: 'unsupported-value',
              },
              {
                _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
                reason: 'unsupported-value',
              },
            ],
          },
        },
      },
      {
        name: 'immutable-history-commit-limit',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            field: 'immutableHistoryCommitCount',
            expected: '<50000',
            observed: 50000,
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            field: 'immutableHistoryCommitCount',
            expected: '<50000',
            observed: 50000,
          },
        },
      },
      {
        name: 'preregistration-lineage-unreachable',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            expected: `${'a'.repeat(40)} to be a proper ancestor of ${'b'.repeat(40)}`,
            observed: 'not reachable through raw commit parents',
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            expected: `${'a'.repeat(40)} to be a proper ancestor of ${'b'.repeat(40)}`,
            observed: 'not reachable through raw commit parents',
          },
        },
      },
      {
        name: 'preregistration-lineage-same-revision',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            expected: 'proper ancestor of evaluated source revision',
            observed: 'a'.repeat(40),
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            expected: 'proper ancestor of evaluated source revision',
            observed: 'a'.repeat(40),
          },
        },
      },
      {
        name: 'immutable-history-tree-limit',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-module-novelty',
          cause: {
            field: 'immutableHistoryTreeCount',
            expected: '<500000',
            observed: 500000,
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-module-novelty',
          cause: {
            field: 'immutableHistoryTreeCount',
            expected: '<500000',
            observed: 500000,
          },
        },
      },
      {
        name: 'module-novelty-provenance',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-module-novelty',
          cause: {
            preregistrationRevision: 'a'.repeat(40),
            modulePath: 'candidate/program.mjs',
            expected: 'evaluated module blob created after preregistration',
            observed: 'b'.repeat(40),
            history: ['c'.repeat(40)],
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-module-novelty',
          cause: {
            preregistrationRevision: 'a'.repeat(40),
            modulePath: 'candidate/program.mjs',
            expected: 'evaluated module blob created after preregistration',
            observed: 'b'.repeat(40),
            history: ['c'.repeat(40)],
          },
        },
      },
      {
        name: 'immutable-commit-diagnostic',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            field: 'immutableCommit',
            commitOid: 'a'.repeat(40),
            expected: 'raw commit with lowercase 40-character tree and parent OIDs',
            observed: {
              treeOid: 'malformed-tree-oid',
              parentOids: ['b'.repeat(40), 'private-parent-value'],
              secret: 'must-not-render',
            },
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-lineage',
          cause: {
            field: 'immutableCommit',
            commitOid: 'a'.repeat(40),
            expected: 'raw commit with lowercase 40-character tree and parent OIDs',
            observed: {
              treeOid: {
                _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
                reason: 'unsupported-value',
              },
              parentOids: [
                'b'.repeat(40),
                {
                  _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
                  reason: 'unsupported-value',
                },
              ],
            },
          },
        },
      },
      {
        name: 'immutable-tree-entry-diagnostic',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-module-novelty',
          cause: {
            field: 'immutableTreeEntry',
            treeOid: 'c'.repeat(40),
            offset: 128,
            expected: 'raw Git tree entry with mode, name, NUL, and 20-byte object ID',
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-module-novelty',
          cause: {
            field: 'immutableTreeEntry',
            treeOid: 'c'.repeat(40),
            offset: 128,
            expected: 'raw Git tree entry with mode, name, NUL, and 20-byte object ID',
          },
        },
      },
      {
        name: 'immutable-tree-object-oid-diagnostic',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-module-novelty',
          cause: {
            field: 'immutableTreeObjectOid',
            treeOid: 'd'.repeat(40),
            offset: 256,
            observed: 'private-object-value',
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-preregistration-module-novelty',
          cause: {
            field: 'immutableTreeObjectOid',
            treeOid: 'd'.repeat(40),
            offset: 256,
            observed: {
              _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
              reason: 'unsupported-value',
            },
          },
        },
      },
      {
        name: 'module-format-rejection',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-module-format',
          cause: {
            modulePath: 'services/bayn/src/candidate.mjs',
            imports: [
              { kind: 'import-statement', path: 'node:fs' },
              { kind: 'dynamic-import', path: './helper.mjs', secret: 'must-not-render' },
            ],
            identifiers: ['process', 'template-literal'],
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-module-format',
          cause: {
            modulePath: 'services/bayn/src/candidate.mjs',
            imports: [
              { kind: 'import-statement', path: 'node:fs' },
              { kind: 'dynamic-import', path: './helper.mjs' },
            ],
            identifiers: ['process', 'template-literal'],
          },
        },
      },
      {
        name: 'trial-history-terminal-evidence',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'trialHistory.latestTerminalEvidence',
            expected: { candidateOrdinal: 6, priorTrialCount: 5 },
            observed: {
              candidateOrdinal: 7,
              priorTrialCount: 5,
              qualificationAttemptConsumed: true,
              status: 'DEVELOPMENT_REJECTED',
              secret: 'must-not-render',
            },
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'trialHistory.latestTerminalEvidence',
            expected: { candidateOrdinal: 6, priorTrialCount: 5 },
            observed: {
              candidateOrdinal: 7,
              priorTrialCount: 5,
              qualificationAttemptConsumed: true,
            },
          },
        },
      },
      {
        name: 'missing-next-preregistration-terminal-evidence',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'trialHistory.nextCandidatePreregistration',
            expected: 'a separately reviewed preregistration after the latest terminal development attempt',
            observed: null,
            latestTerminalEvidence: {
              candidateOrdinal: 18,
              priorTrialCount: 17,
              qualificationAttemptConsumed: false,
              status: 'DEVELOPMENT_REJECTED',
              secret: 'must-not-render',
            },
            secret: 'must-not-render',
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'trialHistory.nextCandidatePreregistration',
            expected: 'a separately reviewed preregistration after the latest terminal development attempt',
            observed: null,
            latestTerminalEvidence: {
              candidateOrdinal: 18,
              priorTrialCount: 17,
              qualificationAttemptConsumed: false,
            },
          },
        },
      },
      {
        name: 'trial-history-development-evidence',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'trialHistory.latestDevelopmentEvidence',
            expected: { candidateOrdinal: 7, priorTrialCount: 6, qualificationAttemptConsumed: false },
            observed: {
              candidateOrdinal: 8,
              priorTrialCount: 7,
              qualificationAttemptConsumed: true,
              status: 'DEVELOPMENT_REJECTED',
              secret: 'must-not-render',
            },
          },
        },
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'trialHistory.latestDevelopmentEvidence',
            expected: { candidateOrdinal: 7, priorTrialCount: 6, qualificationAttemptConsumed: false },
            observed: { candidateOrdinal: 8, priorTrialCount: 7, qualificationAttemptConsumed: true },
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

runCandidateDevelopmentCommandMain(Effect.fail(${JSON.stringify(testCase.failure)}))
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
        expect(result.stderr).not.toContain('/workspace/')
        expect(result.stderr).not.toContain('2026-07-31')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test('preserves bounded schema issue paths and children without raw inputs', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-schema-errors-'))
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const cases = [
      {
        name: 'invalid-source-manifest',
        imports: 'Effect, Result, Schema',
        body: `
const SourceManifest = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-source-manifest.v1'),
  modulePath: Schema.String,
  marketData: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-market-data-source.v1'),
    snapshotId: Schema.String,
  }),
})
const decoded = Schema.decodeUnknownResult(SourceManifest, { errors: 'all', onExcessProperty: 'error' })({
  schemaVersion: 'wrong-version-must-not-render',
  modulePath: 'private/module-path-must-not-render.mjs',
  marketData: {
    schemaVersion: 'bayn.candidate-development-market-data-source.v1',
    snapshotId: 99,
  },
})
if (Result.isSuccess(decoded)) throw new Error('expected schema failure')
runCandidateDevelopmentCommandMain(Effect.fail({
  _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
  operation: 'decode-source-manifest',
  cause: decoded.failure,
}))
`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'decode-source-manifest',
          cause: {
            _tag: 'SchemaError',
            issue: {
              _tag: 'Composite',
              issues: [
                {
                  _tag: 'Pointer',
                  path: ['schemaVersion'],
                  issue: {
                    _tag: 'InvalidType',
                    expected: {
                      _tag: 'Literal',
                      literal: 'bayn.candidate-development-source-manifest.v1',
                    },
                  },
                },
                {
                  _tag: 'Pointer',
                  path: ['marketData'],
                  issue: {
                    _tag: 'Composite',
                    issues: [
                      {
                        _tag: 'Pointer',
                        path: ['snapshotId'],
                        issue: { _tag: 'InvalidType', expected: { _tag: 'String' } },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
      {
        name: 'nested-composite',
        imports: 'Effect, Result, Schema',
        body: `
const Nested = Schema.Struct({
  payload: Schema.Struct({ name: Schema.String, count: Schema.Number }),
})
const decoded = Schema.decodeUnknownResult(Nested, { errors: 'all', onExcessProperty: 'error' })({
  payload: { name: 7, count: 'must-not-render' },
})
if (Result.isSuccess(decoded)) throw new Error('expected schema failure')
runCandidateDevelopmentCommandMain(Effect.fail({
  _tag: 'CandidateDevelopmentCommandProgramInvalid',
  reason: 'input-invalid',
  cause: decoded.failure,
}))
`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandProgramInvalid',
          reason: 'input-invalid',
          cause: {
            _tag: 'SchemaError',
            issue: {
              _tag: 'Composite',
              issues: [
                {
                  _tag: 'Pointer',
                  path: ['payload'],
                  issue: {
                    _tag: 'Composite',
                    issues: [
                      {
                        _tag: 'Pointer',
                        path: ['name'],
                        issue: { _tag: 'InvalidType', expected: { _tag: 'String' } },
                      },
                      {
                        _tag: 'Pointer',
                        path: ['count'],
                        issue: { _tag: 'InvalidType', expected: { _tag: 'Number' } },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
      {
        name: 'hostile-pointer-metadata',
        imports: 'Effect, Option, SchemaError, SchemaIssue',
        body: `
const cause = new SchemaError.SchemaError(
  new SchemaIssue.Pointer(
    ['/workspace/private', 'GITHUB_TOKEN'],
    new SchemaIssue.InvalidValue(Option.some('credential-value'), { message: 'must-not-render' }),
  ),
)
runCandidateDevelopmentCommandMain(Effect.fail({
  _tag: 'CandidateDevelopmentCommandProgramInvalid',
  reason: 'input-invalid',
  cause,
}))
`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandProgramInvalid',
          reason: 'input-invalid',
          cause: {
            _tag: 'SchemaError',
            issue: {
              _tag: 'Pointer',
              path: [
                { _tag: 'CandidateDevelopmentCommandFailureDetailRejected', reason: 'unsupported-value' },
                { _tag: 'CandidateDevelopmentCommandFailureDetailRejected', reason: 'unsupported-value' },
              ],
              issue: { _tag: 'InvalidValue' },
            },
          },
        },
      },
      {
        name: 'unbranded-schema-lookalike',
        imports: 'Effect',
        body: `
runCandidateDevelopmentCommandMain(Effect.fail({
  _tag: 'CandidateDevelopmentCommandProgramInvalid',
  reason: 'input-invalid',
  cause: {
    _tag: 'SchemaError',
    issue: { _tag: 'Pointer', path: ['private'], issue: { _tag: 'InvalidType' } },
    secret: 'must-not-render',
  },
}))
`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandProgramInvalid',
          reason: 'input-invalid',
          cause: { _tag: 'CandidateDevelopmentCommandFailureDetailRejected', reason: 'invalid-tag' },
        },
      },
    ] as const

    try {
      for (const testCase of cases) {
        const scriptPath = join(directory, `${testCase.name}.ts`)
        await writeFile(
          scriptPath,
          `
import { ${testCase.imports} } from 'effect'
import { runCandidateDevelopmentCommandMain } from ${JSON.stringify(commandUrl)}
${testCase.body}
`,
        )
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
        expect(result.stderr).not.toContain('credential-value')
        expect(result.stderr).not.toContain('/workspace/private')
        expect(result.stderr).not.toContain('GITHUB_TOKEN')
        expect(result.stderr).not.toContain('private/module-path')
        expect(result.stderr).not.toContain('wrong-version')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test('preserves declared tagged domain failure payloads without arbitrary data', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-domain-failures-'))
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const cases = [
      {
        name: 'geometry-integer-invalid',
        failureExpression: `{
          _tag: 'CandidateDevelopmentPreflightInvalid',
          cause: {
            _tag: 'CandidateDevelopmentGeometryIntegerInvalid',
            field: 'testSessions',
            value: Number.NaN,
            secret: 'must-not-render',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentPreflightInvalid',
          cause: {
            _tag: 'CandidateDevelopmentGeometryIntegerInvalid',
            field: 'testSessions',
            value: 'NaN',
          },
        },
      },
      {
        name: 'calendar-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentPreflightInvalid',
          cause: {
            _tag: 'CandidateDevelopmentCalendarMismatch',
            field: 'sessionCount',
            expected: 1762,
            observed: 1761,
            token: 'must-not-render',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentPreflightInvalid',
          cause: {
            _tag: 'CandidateDevelopmentCalendarMismatch',
            field: 'sessionCount',
            expected: 1762,
            observed: 1761,
          },
        },
      },
      {
        name: 'doubled-cost-protocol-deviation',
        failureExpression: `{
          _tag: 'CandidateDevelopmentDoubledCostInvalid',
          cause: {
            _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation',
            disposition: 'INVALID_PROTOCOL_DEVIATION',
            reason: 'SIGNAL_DECISIONS_CHANGED',
            baselineHash: '${'a'.repeat(64)}',
            stressedHash: '${'b'.repeat(64)}',
            path: '/workspace/private/stressed.json',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentDoubledCostInvalid',
          cause: {
            _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation',
            reason: 'SIGNAL_DECISIONS_CHANGED',
            disposition: 'INVALID_PROTOCOL_DEVIATION',
            baselineHash: 'a'.repeat(64),
            stressedHash: 'b'.repeat(64),
          },
        },
      },
      {
        name: 'comparison-signal-execution-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonSignalExecutionMismatch',
            index: 3,
            expected: { signalDate: '2020-01-30', executionDate: '2020-01-31' },
            observed: { signalDate: '2020-01-30', executionDate: '2020-02-03' },
            expectedCount: 4,
            observedCount: 4,
            timestamp: '2026-07-31T18:00:00.000Z',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonSignalExecutionMismatch',
            index: 3,
            expected: { signalDate: '2020-01-30', executionDate: '2020-01-31' },
            observed: { signalDate: '2020-01-30', executionDate: '2020-02-03' },
            expectedCount: 4,
            observedCount: 4,
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
        expect(result.stderr).not.toContain('/workspace/')
        expect(result.stderr).not.toContain('2026-07-31')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
