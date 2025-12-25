import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __private } from '../db'

describe('db ssl config', () => {
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    previousEnv.PGSSLMODE = process.env.PGSSLMODE
  })

  afterEach(() => {
    if (previousEnv.PGSSLMODE === undefined) {
      delete process.env.PGSSLMODE
    } else {
      process.env.PGSSLMODE = previousEnv.PGSSLMODE
    }
  })

  it('prefers sslmode from url over env', () => {
    process.env.PGSSLMODE = 'verify-full'
    const mode = __private.resolveEffectiveSslMode('postgresql://user:pass@localhost:5432/db?sslmode=require')
    expect(mode).toBe('require')
  })

  it('uses env sslmode when url does not include one', () => {
    process.env.PGSSLMODE = 'verify-ca'
    const mode = __private.resolveEffectiveSslMode('postgresql://user:pass@localhost:5432/db')
    expect(mode).toBe('verify-ca')
  })

  it('defaults to require when sslmode is unset', () => {
    delete process.env.PGSSLMODE
    const mode = __private.resolveEffectiveSslMode('postgresql://user:pass@localhost:5432/db')
    expect(mode).toBe('require')
  })

  it('treats require as insecure even with a ca bundle', () => {
    const ssl = __private.resolveSslConfig(
      'require',
      '-----BEGIN CERTIFICATE-----\nMIIBsDCCAVWgAwIBAgIUWm4vZ0t2\n-----END CERTIFICATE-----',
    )
    expect(ssl?.rejectUnauthorized).toBe(false)
    expect(ssl && 'ca' in ssl).toBe(false)
  })

  it('verifies when sslmode requires validation', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIBsDCCAVWgAwIBAgIUWm4vZ0t2\n-----END CERTIFICATE-----'
    const ssl = __private.resolveSslConfig('verify-full', ca)
    expect(ssl?.rejectUnauthorized).toBe(true)
    expect(ssl?.ca).toBe(ca)
  })
})
