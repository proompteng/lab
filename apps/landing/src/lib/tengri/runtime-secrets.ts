import 'server-only'

import { readFileSync } from 'node:fs'
import path from 'node:path'

export type TengriBffSecretName =
  | 'BETTER_AUTH_SECRET'
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
  | 'TENGRI_INTERNAL_HMAC_SECRET'

export function readTengriBffSecret(name: TengriBffSecretName) {
  const directory = process.env.TENGRI_BFF_SECRET_DIR?.trim()
  if (!directory) return process.env[name]?.trim() || ''

  try {
    return readFileSync(path.join(directory, name), 'utf8').trim()
  } catch (error) {
    if (isMissingSecretFile(error)) return ''
    throw error
  }
}

function isMissingSecretFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
