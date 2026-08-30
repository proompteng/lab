import { Result } from 'effect'

import type { EvaluationBounds } from '../../contracts'
import { canonicalHashV1Result } from '../../hash'
import type { BoundField, MarketDataVerificationError } from './errors'
import { Pipeable } from '../../pipeable'

export const database = 'signal' as const
export const tables = {
  bars: 'adjusted_daily_bars_v2',
  sessions: 'exchange_sessions_v1',
  manifests: 'snapshot_manifests_v2',
} as const

export const fail = <A>(error: MarketDataVerificationError): Result.Result<A, MarketDataVerificationError> =>
  Result.fail(error)

const requireConditionDataFirst = (
  condition: boolean,
  error: MarketDataVerificationError,
): Result.Result<void, MarketDataVerificationError> => (condition ? Result.succeed(undefined) : fail(error))

export const requireCondition = Pipeable.dual(2, requireConditionDataFirst)

const requireValueDataFirst = <A>(
  value: A | null | undefined,
  error: MarketDataVerificationError,
): Result.Result<A, MarketDataVerificationError> =>
  value === null || value === undefined ? fail(error) : Result.succeed(value)

export const requireValue = Pipeable.generic<
  <A>(
    error: MarketDataVerificationError,
  ) => (value: A | null | undefined) => Result.Result<A, MarketDataVerificationError>,
  typeof requireValueDataFirst
>(2, requireValueDataFirst)

export const validateAll = (
  validations: ReadonlyArray<Result.Result<void, MarketDataVerificationError>>,
): Result.Result<void, MarketDataVerificationError> => Result.map(Result.all(validations), () => undefined)

const canonicalHashResultDataFirst = (
  target: Extract<MarketDataVerificationError, { readonly _tag: 'CanonicalizationFailed' }>['target'],
  snapshotId: string,
  value: unknown,
): Result.Result<string, MarketDataVerificationError> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): MarketDataVerificationError => ({
      _tag: 'CanonicalizationFailed',
      target,
      snapshotId,
      cause,
    }),
  )

export const canonicalHashResult = Pipeable.dual(3, canonicalHashResultDataFirst)

const decodeSignalCountDataFirst = (
  value: string | number,
  field: Extract<MarketDataVerificationError, { readonly _tag: 'CountInvalid' }>['field'],
): Result.Result<number, MarketDataVerificationError> => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Result.succeed(parsed)
    : fail({ _tag: 'CountInvalid', field, value })
}

export const decodeSignalCount = Pipeable.dual(2, decodeSignalCountDataFirst)

export const canonicalUniverse = (
  universe: readonly string[],
): Result.Result<readonly string[], MarketDataVerificationError> => {
  const canonical = [...new Set(universe)].sort()
  if (canonical.length === 0 || canonical.length !== universe.length) {
    return fail({ _tag: 'UniverseInvalid', reason: 'empty-or-duplicate', universe })
  }
  return canonical.some((symbol, index) => symbol !== universe[index])
    ? fail({ _tag: 'UniverseInvalid', reason: 'not-canonical', universe })
    : Result.succeed(canonical)
}

export const withoutSnapshot = <A extends { readonly snapshot_id: string }>({ snapshot_id: _, ...row }: A) => row
export const withoutManifestHash = <A extends { readonly manifest_content_hash: string }>({
  manifest_content_hash: _,
  ...manifest
}: A) => manifest
export const toUtcInstant = (value: string): string => `${value.replace(' ', 'T')}Z`

const boundFields: readonly BoundField[] = ['dataStart', 'dataEnd', 'lookbackStart', 'evaluationStart', 'evaluationEnd']

const validateBoundSessionsDataFirst = (
  sessions: ReadonlySet<string>,
  bounds: EvaluationBounds,
): Result.Result<void, MarketDataVerificationError> =>
  validateAll(
    boundFields.map((field) =>
      requireCondition(sessions.has(bounds[field]), {
        _tag: 'BoundSessionMissing',
        field,
        value: bounds[field],
      }),
    ),
  )

export const validateBoundSessions = Pipeable.dual(2, validateBoundSessionsDataFirst)
