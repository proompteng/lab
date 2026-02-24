import { afterEach, describe, expect, it } from 'vitest'

import { normalizeVcsMode, resolveVcsAuthMethod, validateVcsAuthConfig } from '~/server/agents-controller/vcs-auth'

afterEach(() => {
  delete process.env.JANGAR_AGENTS_CONTROLLER_VCS_DEPRECATED_TOKEN_TYPES
})

describe('agents controller vcs-auth module', () => {
  it('normalizes vcs mode values with read-write fallback', () => {
    expect(normalizeVcsMode('read-only')).toBe('read-only')
    expect(normalizeVcsMode('none')).toBe('none')
    expect(normalizeVcsMode('invalid')).toBe('read-write')
    expect(normalizeVcsMode(null)).toBe('read-write')
  })

  it('resolves auth method from explicit and inferred secret refs', () => {
    expect(resolveVcsAuthMethod({ method: 'token' })).toBe('token')
    expect(resolveVcsAuthMethod({ token: { secretRef: { name: 'token-secret' } } })).toBe('token')
    expect(resolveVcsAuthMethod({ app: { privateKeySecretRef: { name: 'app-secret' } } })).toBe('app')
    expect(resolveVcsAuthMethod({ ssh: { privateKeySecretRef: { name: 'ssh-secret' } } })).toBe('ssh')
    expect(resolveVcsAuthMethod({})).toBe('none')
  })

  it('rejects unsupported auth method for provider', () => {
    const result = validateVcsAuthConfig('gitlab', {
      method: 'app',
      app: { privateKeySecretRef: { name: 'app-secret' } },
    })
    expect(result).toEqual({
      ok: false,
      reason: 'UnsupportedAuth',
      message: 'auth.method=app is not supported for gitlab providers',
    })
  })

  it('validates token type support and emits deprecation warnings', () => {
    const deprecated = validateVcsAuthConfig('github', {
      method: 'token',
      token: { type: 'personal-access-token' },
    })
    expect(deprecated.ok).toBe(true)
    if (deprecated.ok) {
      expect(deprecated.method).toBe('token')
      expect(deprecated.tokenType).toBe('pat')
      expect(deprecated.defaultUsername).toBe('x-access-token')
      expect(deprecated.warnings).toEqual([
        {
          reason: 'DeprecatedAuth',
          message: 'auth.token.type=pat is deprecated for github providers',
        },
      ])
    }

    const unsupported = validateVcsAuthConfig('bitbucket', {
      method: 'token',
      token: { type: 'pat' },
    })
    expect(unsupported).toEqual({
      ok: false,
      reason: 'UnsupportedAuth',
      message: 'auth.token.type=pat is not supported for bitbucket providers',
    })
  })

  it('respects deprecated token override map from env json', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_VCS_DEPRECATED_TOKEN_TYPES = JSON.stringify({
      gitlab: ['access_token'],
    })
    const result = validateVcsAuthConfig('gitlab', {
      method: 'token',
      token: { type: 'access_token' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings).toEqual([
        {
          reason: 'DeprecatedAuth',
          message: 'auth.token.type=access_token is deprecated for gitlab providers',
        },
      ])
    }
  })
})
