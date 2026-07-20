import { createHash } from 'node:crypto'

const canonicalizeLegacyValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeLegacyValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeLegacyValue(nested)]),
    )
  }
  return value
}

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalizeLegacyValue(value))

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export const hashObject = (value: unknown): string => sha256(canonicalJson(value))

type JsonPrimitive = null | boolean | number | string
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

const compareUtf16 = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

const canonicalizeValue = (value: unknown, ancestors: Set<object>, path: string): JsonValue => {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw new TypeError(`${path} contains an invalid Unicode surrogate`)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`)
    const keys = Object.keys(value)
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new TypeError(`${path} must be a dense array without custom properties`)
    }
    if (
      Reflect.ownKeys(value).some(
        (key) =>
          key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length),
      )
    ) {
      throw new TypeError(`${path} must be a dense array without custom properties`)
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}[${key}] must be an enumerable data property`)
      }
    }
    ancestors.add(value)
    const canonical = value.map((nested, index) => canonicalizeValue(nested, ancestors, `${path}[${index}]`))
    ancestors.delete(value)
    return canonical
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`)
    }
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) throw new TypeError(`${path} contains a symbol key`)
    for (const key of keys as string[]) {
      if (hasLoneSurrogate(key)) throw new TypeError(`${path} contains an invalid Unicode key`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`)
      }
    }
    ancestors.add(value)
    const canonical = Object.fromEntries(
      (keys as string[])
        .sort(compareUtf16)
        .map((key) => [key, canonicalizeValue((value as Record<string, unknown>)[key], ancestors, `${path}.${key}`)]),
    )
    ancestors.delete(value)
    return canonical
  }
  throw new TypeError(`${path} contains a non-JSON ${typeof value} value`)
}

export const canonicalJsonV1 = (value: unknown): string => JSON.stringify(canonicalizeValue(value, new Set(), '$'))

export const canonicalHashV1 = (value: unknown): string => sha256(canonicalJsonV1(value))

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
