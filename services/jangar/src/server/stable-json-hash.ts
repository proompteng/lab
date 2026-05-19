import { asRecord } from '~/server/primitives-http'

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
