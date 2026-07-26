import { createHash } from 'node:crypto'

import { pipe, Result } from 'effect'

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const compareUtf16 = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export interface CanonicalJsonFailure {
  readonly _tag: 'CanonicalJsonFailure'
  readonly path: string
  readonly reason:
    | 'cycle'
    | 'invalid-unicode-key'
    | 'invalid-unicode-surrogate'
    | 'non-data-property'
    | 'non-dense-array'
    | 'non-finite-number'
    | 'non-json-type'
    | 'non-plain-object'
    | 'symbol-key'
  readonly actualType: string
}

export const renderCanonicalJsonFailure = (failure: CanonicalJsonFailure): string =>
  `${failure.reason} at ${failure.path} (${failure.actualType})`

const canonicalFailure = (
  path: string,
  reason: CanonicalJsonFailure['reason'],
  actualType: string,
): Result.Result<never, CanonicalJsonFailure> => Result.fail({ _tag: 'CanonicalJsonFailure', path, reason, actualType })

const serializeArrayResult = (
  value: readonly unknown[],
  ancestors: readonly object[],
  path: string,
): Result.Result<string, CanonicalJsonFailure> => {
  if (ancestors.includes(value)) return canonicalFailure(path, 'cycle', 'array')
  const keys = Object.keys(value)
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index)) ||
    Reflect.ownKeys(value).some(
      (key) =>
        key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length),
    )
  ) {
    return canonicalFailure(path, 'non-dense-array', 'array')
  }
  return pipe(
    Result.all(
      keys.map((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor?.enumerable === true && 'value' in descriptor
          ? serializeCanonicalValueResult(descriptor.value, [...ancestors, value], `${path}[${index}]`)
          : canonicalFailure(`${path}[${key}]`, 'non-data-property', 'array-property')
      }),
    ),
    Result.map((values) => `[${values.join(',')}]`),
  )
}

const serializeObjectResult = (
  value: object,
  ancestors: readonly object[],
  path: string,
): Result.Result<string, CanonicalJsonFailure> => {
  if (ancestors.includes(value)) return canonicalFailure(path, 'cycle', 'object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return canonicalFailure(path, 'non-plain-object', prototype?.constructor?.name ?? 'object')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) {
    return canonicalFailure(path, 'symbol-key', 'object')
  }
  return pipe(
    Result.all(
      (keys as string[]).sort(compareUtf16).map((key) => {
        if (!key.isWellFormed()) return canonicalFailure(path, 'invalid-unicode-key', 'string')
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor?.enumerable === true && 'value' in descriptor
          ? pipe(
              serializeCanonicalValueResult(descriptor.value, [...ancestors, value], `${path}.${key}`),
              Result.map((nested) => `${JSON.stringify(key)}:${nested}`),
            )
          : canonicalFailure(`${path}.${key}`, 'non-data-property', 'object-property')
      }),
    ),
    Result.map((entries) => `{${entries.join(',')}}`),
  )
}

const serializeCanonicalValueResult = (
  value: unknown,
  ancestors: readonly object[],
  path: string,
): Result.Result<string, CanonicalJsonFailure> => {
  if (value === null) return Result.succeed('null')
  if (typeof value === 'boolean') return Result.succeed(value ? 'true' : 'false')
  if (typeof value === 'string') {
    return value.isWellFormed()
      ? Result.succeed(JSON.stringify(value))
      : canonicalFailure(path, 'invalid-unicode-surrogate', 'string')
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? Result.succeed(JSON.stringify(Object.is(value, -0) ? 0 : value))
      : canonicalFailure(path, 'non-finite-number', 'number')
  }
  if (Array.isArray(value)) return serializeArrayResult(value, ancestors, path)
  if (typeof value === 'object') return serializeObjectResult(value, ancestors, path)
  return canonicalFailure(path, 'non-json-type', typeof value)
}

export const canonicalJsonV1Result = (value: unknown): Result.Result<string, CanonicalJsonFailure> =>
  serializeCanonicalValueResult(value, [], '$')

export const canonicalHashV1Result = (value: unknown): Result.Result<string, CanonicalJsonFailure> =>
  pipe(canonicalJsonV1Result(value), Result.map(sha256))

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
