import { createHash } from 'node:crypto'

import { pipe, Result } from 'effect'

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const compareUtf16 = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

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

const validationFailure = (
  path: string,
  reason: CanonicalJsonValidationReason,
  actualType: string,
): Result.Result<never, CanonicalJsonFailure> => Result.fail({ _tag: 'CanonicalJsonFailure', path, reason, actualType })

const inspect = <A>(
  path: string,
  actualType: CanonicalJsonIntrospectionFailure['actualType'],
  operation: CanonicalJsonIntrospectionOperation,
  evaluate: () => A,
): Result.Result<A, CanonicalJsonFailure> =>
  Result.try({
    try: evaluate,
    catch: (cause): CanonicalJsonIntrospectionFailure => ({
      _tag: 'CanonicalJsonFailure',
      path,
      reason: 'introspection-failed',
      actualType,
      operation,
      cause,
    }),
  })

const hasInvalidUnicodeSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

const arrayLength = (value: readonly unknown[], path: string): Result.Result<number, CanonicalJsonFailure> =>
  inspect(path, 'array', 'array-length', () => value.length)

const enumerableArrayKeys = (
  value: readonly unknown[],
  path: string,
): Result.Result<readonly string[], CanonicalJsonFailure> =>
  inspect(path, 'array', 'enumerable-own-keys', () => Object.keys(value))

const arrayOwnKeys = (
  value: readonly unknown[],
  path: string,
): Result.Result<readonly PropertyKey[], CanonicalJsonFailure> =>
  inspect(path, 'array', 'own-keys', () => Reflect.ownKeys(value))

const dataProperty = (
  value: object,
  key: PropertyKey,
  path: string,
  actualType: CanonicalJsonIntrospectionFailure['actualType'],
): Result.Result<unknown, CanonicalJsonFailure> =>
  pipe(
    inspect(path, actualType, 'property-descriptor', () => Object.getOwnPropertyDescriptor(value, key)),
    Result.flatMap((descriptor) =>
      descriptor?.enumerable === true && 'value' in descriptor
        ? Result.succeed(descriptor.value)
        : validationFailure(path, 'non-data-property', `${actualType}-property`),
    ),
  )

const serializeArrayResult = (
  value: readonly unknown[],
  ancestors: readonly object[],
  path: string,
): Result.Result<string, CanonicalJsonFailure> => {
  if (ancestors.includes(value)) return validationFailure(path, 'cycle', 'array')

  return pipe(
    Result.all({
      length: arrayLength(value, path),
      enumerableKeys: enumerableArrayKeys(value, path),
      ownKeys: arrayOwnKeys(value, path),
    }),
    Result.flatMap(({ enumerableKeys, length, ownKeys }) => {
      const invalidShape =
        !Number.isSafeInteger(length) ||
        length < 0 ||
        enumerableKeys.length !== length ||
        enumerableKeys.some((key, index) => key !== String(index)) ||
        ownKeys.some(
          (key) =>
            key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length),
        )

      if (invalidShape) return validationFailure(path, 'non-dense-array', 'array')

      const nextAncestors = [...ancestors, value]
      return pipe(
        Result.all(
          enumerableKeys.map((key, index) =>
            pipe(
              dataProperty(value, key, `${path}[${key}]`, 'array'),
              Result.flatMap((nested) => serializeCanonicalValueResult(nested, nextAncestors, `${path}[${index}]`)),
            ),
          ),
        ),
        Result.map((values) => `[${values.join(',')}]`),
      )
    }),
  )
}

const objectPrototype = (value: object, path: string): Result.Result<object | null, CanonicalJsonFailure> =>
  inspect(path, 'object', 'prototype', () => Object.getPrototypeOf(value))

const objectOwnKeys = (value: object, path: string): Result.Result<readonly PropertyKey[], CanonicalJsonFailure> =>
  inspect(path, 'object', 'own-keys', () => Reflect.ownKeys(value))

const serializeObjectResult = (
  value: object,
  ancestors: readonly object[],
  path: string,
): Result.Result<string, CanonicalJsonFailure> => {
  if (ancestors.includes(value)) return validationFailure(path, 'cycle', 'object')

  return pipe(
    objectPrototype(value, path),
    Result.flatMap((prototype) =>
      prototype === Object.prototype || prototype === null
        ? objectOwnKeys(value, path)
        : validationFailure(path, 'non-plain-object', 'object'),
    ),
    Result.flatMap((keys) => {
      if (keys.some((key) => typeof key !== 'string')) {
        return validationFailure(path, 'symbol-key', 'object')
      }

      const nextAncestors = [...ancestors, value]
      return pipe(
        Result.all(
          (keys as readonly string[])
            .slice()
            .sort(compareUtf16)
            .map((key) => {
              if (hasInvalidUnicodeSurrogate(key)) {
                return validationFailure(path, 'invalid-unicode-key', 'string')
              }
              return pipe(
                dataProperty(value, key, `${path}.${key}`, 'object'),
                Result.flatMap((nested) => serializeCanonicalValueResult(nested, nextAncestors, `${path}.${key}`)),
                Result.map((nested) => `${JSON.stringify(key)}:${nested}`),
              )
            }),
        ),
        Result.map((entries) => `{${entries.join(',')}}`),
      )
    }),
  )
}

const classifyArray = (value: object, path: string): Result.Result<boolean, CanonicalJsonFailure> =>
  inspect(path, 'object', 'array-classification', () => Array.isArray(value))

const serializeCanonicalValueResult = (
  value: unknown,
  ancestors: readonly object[],
  path: string,
): Result.Result<string, CanonicalJsonFailure> => {
  if (value === null) return Result.succeed('null')
  if (typeof value === 'boolean') return Result.succeed(value ? 'true' : 'false')
  if (typeof value === 'string') {
    return hasInvalidUnicodeSurrogate(value)
      ? validationFailure(path, 'invalid-unicode-surrogate', 'string')
      : Result.succeed(JSON.stringify(value))
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? Result.succeed(JSON.stringify(Object.is(value, -0) ? 0 : value))
      : validationFailure(path, 'non-finite-number', 'number')
  }
  if (typeof value !== 'object') return validationFailure(path, 'non-json-type', typeof value)

  return pipe(
    classifyArray(value, path),
    Result.flatMap((isArray) =>
      isArray
        ? serializeArrayResult(value as readonly unknown[], ancestors, path)
        : serializeObjectResult(value, ancestors, path),
    ),
  )
}

export const canonicalJsonV1Result = (value: unknown): Result.Result<string, CanonicalJsonFailure> =>
  serializeCanonicalValueResult(value, [], '$')

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

const compatibilityError = (failure: CanonicalJsonFailure): unknown => {
  switch (failure.reason) {
    case 'cycle':
      return new TypeError(`${failure.path} contains a cycle`)
    case 'invalid-unicode-key':
      return new TypeError(`${failure.path} contains an invalid Unicode key`)
    case 'invalid-unicode-surrogate':
      return new TypeError(`${failure.path} contains an invalid Unicode surrogate`)
    case 'non-data-property':
      return new TypeError(`${failure.path} must be an enumerable data property`)
    case 'non-dense-array':
      return new TypeError(`${failure.path} must be a dense array without custom properties`)
    case 'non-finite-number':
      return new TypeError(`${failure.path} contains a non-finite number`)
    case 'non-json-type':
      return new TypeError(`${failure.path} contains a non-JSON ${failure.actualType} value`)
    case 'non-plain-object':
      return new TypeError(`${failure.path} must contain only plain JSON objects`)
    case 'symbol-key':
      return new TypeError(`${failure.path} contains a symbol key`)
    case 'introspection-failed':
    case 'sha256-failed':
      return failure.cause
  }
}

export const canonicalJsonV1OrThrow = (value: unknown): string =>
  pipe(canonicalJsonV1Result(value), Result.getOrThrowWith(compatibilityError))

export const canonicalHashV1OrThrow = (value: unknown): string =>
  pipe(canonicalHashV1Result(value), Result.getOrThrowWith(compatibilityError))

/** @deprecated Use canonicalJsonV1Result. This alias remains while callers migrate to total canonicalization. */
export const canonicalJsonV1 = canonicalJsonV1OrThrow

/** @deprecated Use canonicalHashV1Result. This alias remains while callers migrate to total canonicalization. */
export const canonicalHashV1 = canonicalHashV1OrThrow

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
