import { existsSync, readFileSync } from 'node:fs'

import { Pool } from 'pg'

type EnabledTorghutDb = { ok: true; pool: Pool }
type DisabledTorghutDb = { ok: false; disabled: true; message: string }

export type TorghutDbResult = EnabledTorghutDb | DisabledTorghutDb

let cachedPool: Pool | null = null

const DEFAULT_SSLMODE = 'require'

const resolveSslModeFromUrl = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl)
    const mode = url.searchParams.get('sslmode')
    return mode ? mode.trim().toLowerCase() : null
  } catch {
    return null
  }
}

const resolveEffectiveSslMode = (rawUrl: string) => {
  const urlMode = resolveSslModeFromUrl(rawUrl)
  if (urlMode) return urlMode

  const envMode = process.env.TORGHUT_PGSSLMODE?.trim() || process.env.TORGHUT_DB_SSLMODE?.trim()
  if (envMode) return envMode.toLowerCase()

  return DEFAULT_SSLMODE
}

const loadCaCert = (rawValue: string) => {
  if (rawValue.includes('BEGIN CERTIFICATE')) {
    return rawValue
  }
  if (existsSync(rawValue)) {
    return readFileSync(rawValue, 'utf8')
  }
  return rawValue
}

const resolveSslConfig = (sslmode: string | null, caCertPath?: string) => {
  if (sslmode === 'disable') return undefined

  const requiresVerification = sslmode === 'verify-ca' || sslmode === 'verify-full'
  if (requiresVerification) {
    const ca = caCertPath ? loadCaCert(caCertPath) : undefined
    return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true }
  }

  if (!sslmode && !caCertPath) return undefined
  return { rejectUnauthorized: false }
}

export const resolveTorghutDb = (): TorghutDbResult => {
  const dsn = process.env.TORGHUT_DB_DSN?.trim()
  if (!dsn) {
    return {
      ok: false,
      disabled: true,
      message: 'Torghut trading history is disabled because TORGHUT_DB_DSN is not configured.',
    }
  }

  if (cachedPool) return { ok: true, pool: cachedPool }

  // Do not log the DSN; it may contain secrets.
  const sslmode = resolveEffectiveSslMode(dsn)
  const caCertPath = process.env.TORGHUT_PGSSLROOTCERT?.trim() || process.env.TORGHUT_DB_CA_CERT?.trim()
  const ssl = resolveSslConfig(sslmode, caCertPath)
  cachedPool = new Pool({
    connectionString: dsn,
    ssl,
    max: 2,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
  })

  cachedPool.on('error', () => {
    // Avoid leaking connection strings in logs; reset so subsequent calls can retry.
    cachedPool = null
  })

  return { ok: true, pool: cachedPool }
}

export const __private = {
  resolveEffectiveSslMode,
  resolveSslConfig,
}
