import { existsSync, readFileSync } from 'node:fs'

import { resolveAgentsDatabaseConfig } from './storage-config'

const DEFAULT_SSLMODE = 'require'

const loadCaCert = (rawValue: string) => {
  if (rawValue.includes('BEGIN CERTIFICATE')) return rawValue
  if (existsSync(rawValue)) return readFileSync(rawValue, 'utf8')
  return rawValue
}

const resolveSslMode = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl)
    const mode = url.searchParams.get('sslmode')
    return mode ? mode.trim().toLowerCase() : null
  } catch {
    return null
  }
}

export const resolveEffectiveSslMode = (rawUrl: string) => {
  const urlMode = resolveSslMode(rawUrl)
  if (urlMode) return urlMode

  const envMode = resolveAgentsDatabaseConfig().sslMode
  if (envMode) return envMode.toLowerCase()

  return DEFAULT_SSLMODE
}

export const resolveSslConfig = (sslmode: string | null, caCertPath?: string) => {
  if (sslmode === 'disable') return undefined

  const requiresVerification = sslmode === 'verify-ca' || sslmode === 'verify-full'
  if (requiresVerification) {
    const ca = caCertPath ? loadCaCert(caCertPath) : undefined
    return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true }
  }

  if (!sslmode && !caCertPath) return undefined
  return { rejectUnauthorized: false }
}
