import { createHash } from 'node:crypto'

const canonicalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeValue(nested)]),
    )
  }
  return value
}

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalizeValue(value))

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export const hashObject = (value: unknown): string => sha256(canonicalJson(value))

export const stableU128 = (...parts: readonly string[]): bigint => {
  const bytes = createHash('sha256').update(parts.join('\u001f')).digest().subarray(0, 16)
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }
  return value === 0n ? 1n : value
}

export const stableU64 = (...parts: readonly string[]): bigint => {
  const value = stableU128(...parts) & ((1n << 64n) - 1n)
  return value === 0n ? 1n : value
}
