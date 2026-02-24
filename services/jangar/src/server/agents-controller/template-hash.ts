import { createHash } from 'node:crypto'

import { asRecord } from '~/server/primitives-http'

export const resolvePath = (value: Record<string, unknown>, path: string) => {
  const parts = path
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
  let cursor: unknown = value
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor ?? null
}

export const renderTemplate = (template: string, context: Record<string, unknown>) =>
  template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, path) => {
    const value = resolvePath(context, String(path))
    if (value == null) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  })

export const isNonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

export const canonicalizeForJsonHash = (value: unknown): unknown => {
  if (value == null) return null
  if (Array.isArray(value)) return value.map((entry) => canonicalizeForJsonHash(entry))
  if (typeof value !== 'object') return value

  const record = asRecord(value)
  if (!record) return value

  const output: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const entry = record[key]
    if (entry === undefined) continue
    output[key] = canonicalizeForJsonHash(entry)
  }
  return output
}

export const stableJsonStringifyForHash = (value: unknown) => JSON.stringify(canonicalizeForJsonHash(value))
