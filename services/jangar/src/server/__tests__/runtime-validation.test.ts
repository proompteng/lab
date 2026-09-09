import { describe, expect, it } from 'vitest'

import { JANGAR_RUNTIME_PROFILES } from '~/server/runtime-profile'
import { validateRuntimeProfileConfiguration } from '~/server/runtime-validation'

describe('runtime validation', () => {
  it('fails fast for production profiles when rich render mode is misconfigured', () => {
    expect(() =>
      validateRuntimeProfileConfiguration(JANGAR_RUNTIME_PROFILES.httpServer, {
        NODE_ENV: 'production',
        JANGAR_OPENWEBUI_RICH_RENDER_ENABLED: 'true',
      }),
    ).toThrow('JANGAR_OPENWEBUI_EXTERNAL_BASE_URL is required')
  })

  it('skips production-only requirements for the test profile', () => {
    expect(() =>
      validateRuntimeProfileConfiguration(JANGAR_RUNTIME_PROFILES.test, {
        NODE_ENV: 'production',
        JANGAR_OPENWEBUI_RICH_RENDER_ENABLED: 'true',
      }),
    ).not.toThrow()
  })

  it('does not require embedding credentials just to boot a production profile', () => {
    expect(() =>
      validateRuntimeProfileConfiguration(JANGAR_RUNTIME_PROFILES.httpServer, {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://jangar:test@localhost:5432/jangar',
      }),
    ).not.toThrow()
  })
})
