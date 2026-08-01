import { describe, expect, test } from 'bun:test'

import {
  candidateDevelopmentExecutableProgramSchemaVersion,
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
})
