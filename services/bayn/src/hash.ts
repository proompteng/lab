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

const compareUtf16 = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const serializeCanonicalValue = (value: unknown, ancestors: Set<object>, path: string): string => {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new TypeError(`${path} contains an invalid Unicode surrogate`)
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
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
    const values = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}[${key}] must be an enumerable data property`)
      }
      return descriptor.value
    })
    ancestors.add(value)
    try {
      return `[${values
        .map((nested, index) => serializeCanonicalValue(nested, ancestors, `${path}[${index}]`))
        .join(',')}]`
    } finally {
      ancestors.delete(value)
    }
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`)
    }
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) throw new TypeError(`${path} contains a symbol key`)
    const entries = (keys as string[]).map((key) => {
      if (!key.isWellFormed()) throw new TypeError(`${path} contains an invalid Unicode key`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`)
      }
      return [key, descriptor.value] as const
    })
    ancestors.add(value)
    try {
      return `{${entries
        .sort(([left], [right]) => compareUtf16(left, right))
        .map(
          ([key, nested]) => `${JSON.stringify(key)}:${serializeCanonicalValue(nested, ancestors, `${path}.${key}`)}`,
        )
        .join(',')}}`
    } finally {
      ancestors.delete(value)
    }
  }
  throw new TypeError(`${path} contains a non-JSON ${typeof value} value`)
}

export const canonicalJsonV1 = (value: unknown): string => serializeCanonicalValue(value, new Set(), '$')

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
