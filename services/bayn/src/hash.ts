import { createHash } from 'node:crypto'

import { pipe, Result } from 'effect'

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

type CanonicalJsonValidationReason =
  | 'cycle'
  | 'invalid-unicode-key'
  | 'invalid-unicode-surrogate'
  | 'non-data-property'
  | 'non-dense-array'
  | 'non-finite-number'
  | 'non-json-type'
  | 'non-plain-object'
  | 'symbol-key'

type CanonicalJsonIntrospectionOperation =
  | 'array-classification'
  | 'array-length'
  | 'enumerable-own-keys'
  | 'own-keys'
  | 'property-descriptor'
  | 'prototype'

interface CanonicalJsonValidationFailure {
  readonly _tag: 'CanonicalJsonFailure'
  readonly path: string
  readonly reason: CanonicalJsonValidationReason
  readonly actualType: string
}

interface CanonicalJsonIntrospectionFailure {
  readonly _tag: 'CanonicalJsonFailure'
  readonly path: string
  readonly reason: 'introspection-failed'
  readonly actualType: 'array' | 'object'
  readonly operation: CanonicalJsonIntrospectionOperation
  readonly cause: unknown
}

interface CanonicalJsonHashFailure {
  readonly _tag: 'CanonicalJsonFailure'
  readonly path: '$'
  readonly reason: 'sha256-failed'
  readonly actualType: 'canonical-json'
  readonly operation: 'sha256'
  readonly cause: unknown
}

export type CanonicalJsonFailure =
  | CanonicalJsonValidationFailure
  | CanonicalJsonIntrospectionFailure
  | CanonicalJsonHashFailure

export type CanonicalHashFailure = CanonicalJsonFailure

export const renderCanonicalJsonFailure = (failure: CanonicalJsonFailure): string => {
  switch (failure.reason) {
    case 'introspection-failed':
    case 'sha256-failed':
      return `${failure.reason} at ${failure.path} (${failure.actualType}; ${failure.operation})`
    default:
      return `${failure.reason} at ${failure.path} (${failure.actualType})`
  }
}

class CanonicalJsonError extends Error {
  constructor(readonly failure: CanonicalJsonFailure) {
    super(renderCanonicalJsonFailure(failure))
  }
}

// Successful serialization needs no diagnostic strings; each call owns its path segments.
type CanonicalJsonPath = (string | number)[]

const renderCanonicalJsonPath = (path: readonly (string | number)[]): string =>
  '$' + path.map((key) => (typeof key === 'number' ? `[${key}]` : `.${key}`)).join('')

const validationFailure = (
  path: CanonicalJsonPath,
  reason: CanonicalJsonValidationReason,
  actualType: string,
): never => {
  throw new CanonicalJsonError({
    _tag: 'CanonicalJsonFailure',
    path: renderCanonicalJsonPath(path),
    reason,
    actualType,
  })
}

const inspect = <A>(
  path: CanonicalJsonPath,
  actualType: CanonicalJsonIntrospectionFailure['actualType'],
  operation: CanonicalJsonIntrospectionOperation,
  evaluate: () => A,
): A => {
  try {
    return evaluate()
  } catch (cause) {
    throw new CanonicalJsonError({
      _tag: 'CanonicalJsonFailure',
      path: renderCanonicalJsonPath(path),
      reason: 'introspection-failed',
      actualType,
      operation,
      cause,
    })
  }
}

const dataProperty = (
  value: object,
  key: PropertyKey,
  path: CanonicalJsonPath,
  actualType: CanonicalJsonIntrospectionFailure['actualType'],
): unknown => {
  const descriptor = inspect(path, actualType, 'property-descriptor', () => Object.getOwnPropertyDescriptor(value, key))
  return descriptor?.enumerable === true && 'value' in descriptor
    ? descriptor.value
    : validationFailure(path, 'non-data-property', `${actualType}-property`)
}

const serializeArray = (value: readonly unknown[], ancestors: Set<object>, path: CanonicalJsonPath): string => {
  if (ancestors.has(value)) return validationFailure(path, 'cycle', 'array')

  const length = inspect(path, 'array', 'array-length', () => value.length)
  const enumerableKeys = inspect(path, 'array', 'enumerable-own-keys', () => Object.keys(value))
  const ownKeys = inspect(path, 'array', 'own-keys', () => Reflect.ownKeys(value))
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    enumerableKeys.length !== length ||
    enumerableKeys.some((key, index) => key !== String(index)) ||
    ownKeys.some(
      (key) => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length),
    )
  )
    return validationFailure(path, 'non-dense-array', 'array')

  ancestors.add(value)
  const entries: string[] = []
  for (const key of enumerableKeys) {
    path.push(Number(key))
    try {
      entries.push(serializeCanonicalValue(dataProperty(value, key, path, 'array'), ancestors, path))
    } finally {
      path.pop()
    }
  }
  ancestors.delete(value)
  return `[${entries.join(',')}]`
}

// Most evidence keys and scalar values need no JSON escaping.
const quoteCanonicalString = (value: string): string =>
  /["\\\u0000-\u001f]/u.test(value) ? JSON.stringify(value) : `"${value}"`

const serializeObject = (value: object, ancestors: Set<object>, path: CanonicalJsonPath): string => {
  if (ancestors.has(value)) return validationFailure(path, 'cycle', 'object')

  const prototype = inspect(path, 'object', 'prototype', () => Object.getPrototypeOf(value))
  if (prototype !== Object.prototype && prototype !== null) return validationFailure(path, 'non-plain-object', 'object')
  const keys = inspect(path, 'object', 'own-keys', () => Reflect.ownKeys(value))
  if (!keys.every((key) => typeof key === 'string')) return validationFailure(path, 'symbol-key', 'object')

  ancestors.add(value)
  const entries: string[] = []
  for (const key of keys.sort()) {
    if (!key.isWellFormed()) return validationFailure(path, 'invalid-unicode-key', 'string')
    path.push(key)
    try {
      const nested = serializeCanonicalValue(dataProperty(value, key, path, 'object'), ancestors, path)
      entries.push(`${quoteCanonicalString(key)}:${nested}`)
    } finally {
      path.pop()
    }
  }
  ancestors.delete(value)
  return `{${entries.join(',')}}`
}

const serializeCanonicalValue = (value: unknown, ancestors: Set<object>, path: CanonicalJsonPath): string => {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    return value.isWellFormed()
      ? quoteCanonicalString(value)
      : validationFailure(path, 'invalid-unicode-surrogate', 'string')
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : validationFailure(path, 'non-finite-number', 'number')
  }
  if (typeof value !== 'object') return validationFailure(path, 'non-json-type', typeof value)

  return inspect(path, 'object', 'array-classification', () => Array.isArray(value))
    ? serializeArray(value as readonly unknown[], ancestors, path)
    : serializeObject(value, ancestors, path)
}

export const canonicalJsonV1Result = (value: unknown): Result.Result<string, CanonicalJsonFailure> => {
  try {
    return Result.succeed(serializeCanonicalValue(value, new Set(), []))
  } catch (cause) {
    if (cause instanceof CanonicalJsonError) return Result.fail(cause.failure)
    throw cause
  }
}

const hashCanonicalJsonResult = (canonicalJson: string): Result.Result<string, CanonicalJsonFailure> =>
  Result.try({
    try: () => sha256(canonicalJson),
    catch: (cause): CanonicalJsonHashFailure => ({
      _tag: 'CanonicalJsonFailure',
      path: '$',
      reason: 'sha256-failed',
      actualType: 'canonical-json',
      operation: 'sha256',
      cause,
    }),
  })

export const canonicalHashV1Result = (value: unknown): Result.Result<string, CanonicalHashFailure> =>
  pipe(canonicalJsonV1Result(value), Result.flatMap(hashCanonicalJsonResult))

export const canonicalJsonWithHashV1Result = (value: unknown) =>
  canonicalJsonV1Result(value).pipe(
    Result.flatMap((body) => hashCanonicalJsonResult(body).pipe(Result.map((hash) => ({ body, hash })))),
  )

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
