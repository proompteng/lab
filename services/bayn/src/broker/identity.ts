import { pipe, Result, Schema } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  strictParseOptions as StrictParseOptions,
} from '../schemas'

export enum BrokerProvider {
  Alpaca = 'alpaca',
}

export enum BrokerEnvironment {
  Sandbox = 'sandbox',
  Live = 'live',
}

export const BrokerProviderSchema = Schema.Enum(BrokerProvider)
export const BrokerEnvironmentSchema = Schema.Enum(BrokerEnvironment)

export const BrokerIdentityMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.broker-identity.v2'),
  provider: BrokerProviderSchema,
  environment: BrokerEnvironmentSchema,
  accountId: NonEmptyString,
})
export type BrokerIdentityMaterial = typeof BrokerIdentityMaterialSchema.Type

const BrokerIdentityBase = Schema.Struct({
  ...BrokerIdentityMaterialSchema.fields,
  identityHash: Sha256,
})

export const BrokerIdentitySchema = BrokerIdentityBase.check(
  Schema.makeFilter(
    (identity: typeof BrokerIdentityBase.Type) => {
      const { identityHash, ...material } = identity
      const expected = canonicalHashV1Result(material)
      return Result.isSuccess(expected) && identityHash === expected.success
    },
    { expected: 'a broker identity hash matching provider, environment, and account' },
  ),
)
export type BrokerIdentity = typeof BrokerIdentitySchema.Type

export type BrokerIdentityConstructionFailure =
  | {
      readonly _tag: 'BrokerIdentitySchemaInvalid'
      readonly operation: 'material' | 'identity'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'BrokerIdentityCanonicalizationFailed'
      readonly cause: CanonicalHashFailure
    }

const decodeMaterial = Schema.decodeUnknownResult(BrokerIdentityMaterialSchema, StrictParseOptions)
const decodeIdentity = Schema.decodeUnknownResult(BrokerIdentitySchema, StrictParseOptions)

export const makeBrokerIdentity = <Environment extends BrokerEnvironment>(
  input: BrokerIdentityMaterial & { readonly environment: Environment },
): Result.Result<BrokerIdentity & { readonly environment: Environment }, BrokerIdentityConstructionFailure> =>
  pipe(
    decodeMaterial(input),
    Result.mapError(
      (cause): BrokerIdentityConstructionFailure => ({
        _tag: 'BrokerIdentitySchemaInvalid',
        operation: 'material',
        cause,
      }),
    ),
    Result.flatMap((material) =>
      pipe(
        canonicalHashV1Result(material),
        Result.mapError(
          (cause): BrokerIdentityConstructionFailure => ({
            _tag: 'BrokerIdentityCanonicalizationFailed',
            cause,
          }),
        ),
        Result.flatMap((identityHash) =>
          pipe(
            decodeIdentity({ ...material, identityHash }),
            Result.map((identity) => identity as BrokerIdentity & { readonly environment: Environment }),
            Result.mapError(
              (cause): BrokerIdentityConstructionFailure => ({
                _tag: 'BrokerIdentitySchemaInvalid',
                operation: 'identity',
                cause,
              }),
            ),
          ),
        ),
      ),
    ),
  )

export interface HistoricalBrokerIdentity {
  readonly schemaVersion: 'bayn.broker-account.v1'
  readonly provider: BrokerProvider.Alpaca
  readonly environment: BrokerEnvironment.Sandbox
  readonly accountId: string
}

export type DecodedPersistedBrokerIdentity = BrokerIdentity | HistoricalBrokerIdentity

const PersistedBrokerIdentityRowSchema = Schema.Struct({
  broker_identity_schema_version: Schema.NullOr(NonEmptyString),
  broker_identity_hash: Schema.NullOr(Sha256),
  broker_provider: Schema.NullOr(BrokerProviderSchema),
  broker_environment: Schema.NullOr(BrokerEnvironmentSchema),
  account_id: Schema.NullOr(NonEmptyString),
})
type PersistedBrokerIdentityRow = typeof PersistedBrokerIdentityRowSchema.Type

export type PersistedBrokerIdentityDecodeFailure =
  | {
      readonly _tag: 'PersistedBrokerIdentityRowInvalid'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'PersistedBrokerIdentityIncomplete'
      readonly schemaVersion: string | null
    }
  | {
      readonly _tag: 'PersistedBrokerIdentityHashMismatch'
      readonly expected: string
      readonly observed: string
    }
  | BrokerIdentityConstructionFailure

const decodePersistedRow = Schema.decodeUnknownResult(PersistedBrokerIdentityRowSchema, StrictParseOptions)

const allVersionedFieldsAbsent = (row: PersistedBrokerIdentityRow): boolean =>
  row.broker_identity_schema_version === null &&
  row.broker_identity_hash === null &&
  row.broker_provider === null &&
  row.broker_environment === null

const historicalIdentity = (row: PersistedBrokerIdentityRow): HistoricalBrokerIdentity | undefined =>
  row.account_id === null
    ? undefined
    : {
        schemaVersion: 'bayn.broker-account.v1',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId: row.account_id,
      }

/**
 * Historical authority generations persisted only an account ID under the legacy execution contract.
 * That token represented Alpaca sandbox execution exclusively. The inference is intentionally
 * isolated here; new durable identities must use bayn.broker-identity.v2.
 */
export const decodePersistedBrokerIdentity = (
  input: unknown,
): Result.Result<DecodedPersistedBrokerIdentity | undefined, PersistedBrokerIdentityDecodeFailure> => {
  const decoded = decodePersistedRow(input)
  if (Result.isFailure(decoded)) {
    return Result.fail({
      _tag: 'PersistedBrokerIdentityRowInvalid',
      cause: decoded.failure,
    })
  }
  const row = decoded.success
  if (allVersionedFieldsAbsent(row)) return Result.succeed(historicalIdentity(row))
  if (
    row.broker_identity_schema_version !== 'bayn.broker-identity.v2' ||
    row.broker_identity_hash === null ||
    row.broker_provider === null ||
    row.broker_environment === null ||
    row.account_id === null
  ) {
    return Result.fail({
      _tag: 'PersistedBrokerIdentityIncomplete',
      schemaVersion: row.broker_identity_schema_version,
    })
  }
  const constructed = makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: row.broker_provider,
    environment: row.broker_environment,
    accountId: row.account_id,
  })
  if (Result.isFailure(constructed)) return Result.fail(constructed.failure)
  return constructed.success.identityHash === row.broker_identity_hash
    ? Result.succeed(constructed.success)
    : Result.fail({
        _tag: 'PersistedBrokerIdentityHashMismatch',
        expected: constructed.success.identityHash,
        observed: row.broker_identity_hash,
      })
}
