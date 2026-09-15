import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __private } from '../torghut-trading-db'

describe('torghut-trading-db ssl config', () => {
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    previousEnv.TORGHUT_DB_SSLMODE = process.env.TORGHUT_DB_SSLMODE
    previousEnv.TORGHUT_PGSSLMODE = process.env.TORGHUT_PGSSLMODE
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('prefers sslmode from url over env', () => {
    process.env.TORGHUT_DB_SSLMODE = 'verify-full'
    const mode = __private.resolveEffectiveSslMode('postgresql://user:pass@localhost:5432/db?sslmode=require')
    expect(mode).toBe('require')
  })

  it('uses env sslmode when url does not include one', () => {
    process.env.TORGHUT_PGSSLMODE = 'verify-ca'
    const mode = __private.resolveEffectiveSslMode('postgresql://user:pass@localhost:5432/db')
    expect(mode).toBe('verify-ca')
  })

  it('defaults to require when sslmode is unset', () => {
    delete process.env.TORGHUT_DB_SSLMODE
    delete process.env.TORGHUT_PGSSLMODE
    const mode = __private.resolveEffectiveSslMode('postgresql://user:pass@localhost:5432/db')
    expect(mode).toBe('require')
  })

  it('verifies when sslmode requires validation', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIBsDCCAVWgAwIBAgIUWm4vZ0t2\n-----END CERTIFICATE-----'
    const ssl = __private.resolveSslConfig('verify-ca', ca)
    expect(ssl?.rejectUnauthorized).toBe(true)
    expect(ssl?.ca).toBe(ca)
  })
})
