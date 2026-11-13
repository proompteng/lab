import { createHash } from 'node:crypto'
import { types } from 'node:util'

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

const canonicalArrayKeys = (value: readonly unknown[], path: CanonicalJsonPath): string[] => {
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
  return enumerableKeys
}

const canonicalObjectKeys = (value: object, path: CanonicalJsonPath): string[] => {
  const prototype = inspect(path, 'object', 'prototype', () => Object.getPrototypeOf(value))
  if (prototype !== Object.prototype && prototype !== null) return validationFailure(path, 'non-plain-object', 'object')
  const keys = inspect(path, 'object', 'own-keys', () => Reflect.ownKeys(value))
  if (!keys.every((key) => typeof key === 'string')) return validationFailure(path, 'symbol-key', 'object')
  return keys.sort()
}

const serializeArray = (
  value: readonly unknown[],
  ancestors: Set<object>,
  path: CanonicalJsonPath,
  quotedKeys: Map<string, string>,
): string => {
  if (ancestors.has(value)) return validationFailure(path, 'cycle', 'array')

  const enumerableKeys = canonicalArrayKeys(value, path)

  ancestors.add(value)
  const entries: string[] = []
  for (const key of enumerableKeys) {
    path.push(Number(key))
    try {
      entries.push(serializeCanonicalValue(dataProperty(value, key, path, 'array'), ancestors, path, quotedKeys))
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

const serializeObject = (
  value: object,
  ancestors: Set<object>,
  path: CanonicalJsonPath,
  quotedKeys: Map<string, string>,
): string => {
  if (ancestors.has(value)) return validationFailure(path, 'cycle', 'object')

  const keys = canonicalObjectKeys(value, path)

  ancestors.add(value)
  const entries: string[] = []
  for (const key of keys) {
    if (!key.isWellFormed()) return validationFailure(path, 'invalid-unicode-key', 'string')
    path.push(key)
    try {
      const nested = serializeCanonicalValue(dataProperty(value, key, path, 'object'), ancestors, path, quotedKeys)
      let quotedKey = quotedKeys.get(key)
      if (quotedKey === undefined) {
        quotedKey = quoteCanonicalString(key)
        quotedKeys.set(key, quotedKey)
      }
      entries.push(`${quotedKey}:${nested}`)
    } finally {
      path.pop()
    }
  }
  ancestors.delete(value)
  return `{${entries.join(',')}}`
}

const serializeCanonicalValue = (
  value: unknown,
  ancestors: Set<object>,
  path: CanonicalJsonPath,
  quotedKeys: Map<string, string>,
): string => {
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
    ? serializeArray(value as readonly unknown[], ancestors, path, quotedKeys)
    : serializeObject(value, ancestors, path, quotedKeys)
}

export const canonicalJsonV1Result = (value: unknown): Result.Result<string, CanonicalJsonFailure> => {
  try {
    // Reuse only immutable key encodings within this call; every property and value is still inspected.
    return Result.succeed(serializeCanonicalValue(value, new Set(), [], new Map()))
  } catch (cause) {
    if (cause instanceof CanonicalJsonError) return Result.fail(cause.failure)
    throw cause
  }
}

const equalCanonicalValue = (
  left: unknown,
  right: unknown,
  leftAncestors: Set<object>,
  rightAncestors: Set<object>,
  path: CanonicalJsonPath,
): boolean | undefined => {
  if (left === null || right === null) return left === null && right === null
  if (typeof left !== typeof right) return false
  if (typeof left === 'boolean') return left === right
  if (typeof left === 'number') return Number.isFinite(left) && Number.isFinite(right) && left === right
  if (typeof left === 'string')
    return typeof right === 'string' && left.isWellFormed() && right.isWellFormed() && left === right
  if (typeof left !== 'object' || typeof right !== 'object') return false
  // Reflection traps can depend on traversal order. Defer before invoking one so the original serializers own it.
  if (types.isProxy(left) || types.isProxy(right)) return undefined
  if (leftAncestors.has(left) || rightAncestors.has(right)) return false
  const array = Array.isArray(left)
  if (array !== Array.isArray(right)) return false
  const leftKeys = array ? canonicalArrayKeys(left, path) : canonicalObjectKeys(left, path)
  const rightKeys = array ? canonicalArrayKeys(right as readonly unknown[], path) : canonicalObjectKeys(right, path)
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false
  leftAncestors.add(left)
  rightAncestors.add(right)
  for (const key of leftKeys) {
    if (!array && !key.isWellFormed()) return false
    path.push(array ? Number(key) : key)
    const equal = equalCanonicalValue(
      dataProperty(left, key, path, array ? 'array' : 'object'),
      dataProperty(right, key, path, array ? 'array' : 'object'),
      leftAncestors,
      rightAncestors,
      path,
    )
    path.pop()
    if (equal !== true) return equal
  }
  leftAncestors.delete(left)
  rightAncestors.delete(right)
  return true
}

/** Compare canonical data without allocating its encodings; invalid evidence never compares equal. */
export const canonicalJsonEqualV1 = (left: unknown, right: unknown): boolean => {
  try {
    const equal = equalCanonicalValue(left, right, new Set(), new Set(), [])
    if (equal !== undefined) return equal
  } catch (cause) {
    if (cause instanceof CanonicalJsonError) return false
    throw cause
  }
  const a = canonicalJsonV1Result(left),
    b = canonicalJsonV1Result(right)
  return Result.isSuccess(a) && Result.isSuccess(b) && a.success === b.success
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
