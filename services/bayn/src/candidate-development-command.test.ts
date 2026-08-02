import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect } from 'effect'

import {
  candidateDevelopmentExecutableProgramSchemaVersion,
  loadCandidateDevelopmentExpectedSourceRevision,
  renderCandidateDevelopmentCommandFailure,
} from './candidate-development-command'

describe('candidate-development-command compatibility facade', () => {
  test('re-exports the executable contract and bounded failure renderer', () => {
    expect(candidateDevelopmentExecutableProgramSchemaVersion).toBe('bayn.candidate-development-executable-program.v5')
    expect(
      renderCandidateDevelopmentCommandFailure({
        _tag: 'CandidateDevelopmentCommandModulePathMissing',
      }),
    ).toBe(
      JSON.stringify({
        schemaVersion: 'bayn.candidate-development-command-failure.v1',
        error: {
          _tag: 'CandidateDevelopmentCommandError',
          failure: { _tag: 'CandidateDevelopmentCommandModulePathMissing' },
        },
      }) + '\n',
    )
  })

  test('loads the reserved source revision through the typed config provider', async () => {
    const sourceRevision = 'a'.repeat(40)
    const loaded = await Effect.runPromise(
      loadCandidateDevelopmentExpectedSourceRevision.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ BAYN_CANDIDATE_DEVELOPMENT_EXPECTED_SOURCE_REVISION: sourceRevision }),
        ),
      ),
    )

    expect(loaded).toBe(sourceRevision)
  })

  test('fails closed when the reserved source revision is invalid configuration', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        loadCandidateDevelopmentExpectedSourceRevision.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ BAYN_CANDIDATE_DEVELOPMENT_EXPECTED_SOURCE_REVISION: 'not-a-revision' }),
          ),
        ),
      ),
    )

    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-head',
      cause: {
        field: 'expectedSourceRevision',
        expected: 'lowercase 40-character Git revision when configured',
        observed: 'invalid configuration',
      },
    })
  })
})
