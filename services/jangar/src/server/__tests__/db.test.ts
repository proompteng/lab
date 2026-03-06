import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __private } from '../db'

describe('db ssl config', () => {
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    previousEnv.PGSSLMODE = process.env.PGSSLMODE
    previousEnv.DATABASE_URL = process.env.DATABASE_URL
  })

  afterEach(() => {
    if (previousEnv.PGSSLMODE === undefined) {
      delete process.env.PGSSLMODE
    } else {
      process.env.PGSSLMODE = previousEnv.PGSSLMODE
    }

    if (previousEnv.DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousEnv.DATABASE_URL
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

  it('normalizes blank database urls', () => {
    expect(__private.normalizeDbUrl(undefined)).toBe('')
    expect(__private.normalizeDbUrl('  postgres://db  ')).toBe('postgres://db')
  })

  it('reuses the shared db only for the default process url without a custom factory', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'

    expect(__private.shouldReuseSharedDb({})).toBe(true)
    expect(__private.shouldReuseSharedDb({ url: 'postgresql://user:pass@localhost:5432/db' })).toBe(true)
    expect(__private.shouldReuseSharedDb({ url: 'postgresql://other@localhost:5432/db' })).toBe(false)
    expect(__private.shouldReuseSharedDb({ createDb: () => ({}) as never })).toBe(false)
  })
})
