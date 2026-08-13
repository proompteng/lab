import { PgClient } from '@effect/sql-pg'
import { Context, Data, DateTime, Effect, Layer, Result, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import { BrokerEnvironmentSchema, BrokerProviderSchema, makeBrokerIdentity } from '../broker/identity'
import {
  decodeCapitalGrantRecord,
  decodeCapitalGrantRevocation,
  type GrantedCapitalAuthority,
  type CapitalGrantRecord,
  type CapitalGrantRevocation,
  grantedCapitalAuthority,
} from '../execution/authority'
import { Authority } from '../execution/contracts'
import { NonNegativeIntegerSchema, Sha256Schema, StrictNonEmptyStringSchema, strictParseOptions } from '../schemas'
import { Pipeable } from '../pipeable'

export class PersistedCapitalGrantStoreError extends Data.TaggedError('PersistedCapitalGrantStoreError')<{
  readonly operation: 'read' | 'record' | 'revoke' | 'lock-submit'
  readonly failure: 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface PersistedCapitalGrantStoreShape {
  readonly read: (
    grantHash: string,
  ) => Effect.Effect<GrantedCapitalAuthority | undefined, PersistedCapitalGrantStoreError>
  readonly lockForSubmit: (
    grantHash: string,
  ) => Effect.Effect<GrantedCapitalAuthority | undefined, PersistedCapitalGrantStoreError>
  readonly record: (
    grant: CapitalGrantRecord,
  ) => Effect.Effect<GrantedCapitalAuthority, PersistedCapitalGrantStoreError>
  readonly revoke: (
    grantHash: string,
    revocation: CapitalGrantRevocation,
  ) => Effect.Effect<GrantedCapitalAuthority, PersistedCapitalGrantStoreError>
}

export class PersistedCapitalGrantStore extends Context.Service<
  PersistedCapitalGrantStore,
  PersistedCapitalGrantStoreShape
>()('@proompteng/bayn/db/persisted-capital-grant/PersistedCapitalGrantStore') {}

const sqlTimestamp = (value: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value))

const RowSchema = Schema.Struct({
  grant_hash: Sha256Schema,
  schema_version: Schema.Literals(['bayn.live-capital-grant.v1', 'bayn.capital-grant.v2']),
  broker_identity_schema_version: Schema.Literal('bayn.broker-identity.v2'),
  broker_identity_hash: Sha256Schema,
  broker_provider: BrokerProviderSchema,
  broker_environment: BrokerEnvironmentSchema,
  account_id: StrictNonEmptyStringSchema,
  authority_generation_hash: Sha256Schema,
  generation_broker_identity_schema_version: Schema.NullOr(Schema.Literal('bayn.broker-identity.v2')),
  generation_broker_identity_hash: Schema.NullOr(Sha256Schema),
  generation_broker_provider: Schema.NullOr(BrokerProviderSchema),
  generation_broker_environment: Schema.NullOr(BrokerEnvironmentSchema),
  generation_account_id: Schema.NullOr(StrictNonEmptyStringSchema),
  generation_maximum: Schema.NullOr(Schema.Enum(Authority)),
  generation_strategy_name: Schema.NullOr(StrictNonEmptyStringSchema),
  generation_strategy_behavior_hash: Schema.NullOr(Sha256Schema),
  generation_strategy_parameter_hash: Schema.NullOr(Sha256Schema),
  generation_strategy_parameter_schema_version: Schema.NullOr(StrictNonEmptyStringSchema),
  strategy_name: StrictNonEmptyStringSchema,
  strategy_behavior_hash: Sha256Schema,
  strategy_parameter_hash: Sha256Schema,
  strategy_parameter_schema_version: StrictNonEmptyStringSchema,
  max_gross_notional_micros: StrictNonEmptyStringSchema,
  max_order_notional_micros: StrictNonEmptyStringSchema,
  max_position_notional_micros: StrictNonEmptyStringSchema,
  max_daily_loss_micros: StrictNonEmptyStringSchema,
  max_open_orders: NonNegativeIntegerSchema,
  valid_from: Schema.Date,
  valid_until: Schema.Date,
  issued_at: Schema.Date,
  issued_by: StrictNonEmptyStringSchema,
  revocation_schema_version: Schema.NullOr(
    Schema.Literals(['bayn.live-capital-grant-revocation.v1', 'bayn.capital-grant-revocation.v2']),
  ),
  revoked_at: Schema.NullOr(Schema.Date),
  revoked_by: Schema.NullOr(StrictNonEmptyStringSchema),
  revocation_reason: Schema.NullOr(StrictNonEmptyStringSchema),
})
type Row = typeof RowSchema.Type

const decodeRows = Schema.decodeUnknownResult(Schema.Array(RowSchema), strictParseOptions)
const LockedRowsSchema = Schema.Array(Schema.Struct({ grant_hash: Sha256Schema }))
const decodeLockedRows = Schema.decodeUnknownResult(LockedRowsSchema, strictParseOptions)
const decodeHash = Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)

const storeError = (
  operation: PersistedCapitalGrantStoreError['operation'],
  failure: PersistedCapitalGrantStoreError['failure'],
  message: string,
  cause?: unknown,
) => new PersistedCapitalGrantStoreError({ operation, failure, message, cause })

export interface PersistedGrantGenerationBindingFacts {
  readonly maximum: Authority | null
  readonly strategyName: string | null
  readonly strategyBehaviorHash: string | null
  readonly strategyParameterHash: string | null
  readonly strategyParameterSchemaVersion: string | null
}

export interface PersistedGrantGenerationBindingFailure {
  readonly _tag: 'CapitalGrantGenerationBindingMismatch'
  readonly field:
    | 'maximum'
    | 'strategyName'
    | 'strategyBehaviorHash'
    | 'strategyParameterHash'
    | 'strategyParameterSchemaVersion'
  readonly expected: string
  readonly observed: string | null
}

const validatePersistedGrantGenerationBindingDataFirst = (
  grant: Pick<CapitalGrantRecord, 'strategy'>,
  generation: PersistedGrantGenerationBindingFacts,
): Result.Result<void, PersistedGrantGenerationBindingFailure> => {
  const checks: readonly {
    readonly field: PersistedGrantGenerationBindingFailure['field']
    readonly expected: string
    readonly observed: string | null
  }[] = [
    { field: 'maximum', expected: Authority.Execution, observed: generation.maximum },
    { field: 'strategyName', expected: grant.strategy.name, observed: generation.strategyName },
    {
      field: 'strategyBehaviorHash',
      expected: grant.strategy.behaviorHash,
      observed: generation.strategyBehaviorHash,
    },
    {
      field: 'strategyParameterHash',
      expected: grant.strategy.parameterHash,
      observed: generation.strategyParameterHash,
    },
    {
      field: 'strategyParameterSchemaVersion',
      expected: grant.strategy.parameterSchemaVersion,
      observed: generation.strategyParameterSchemaVersion,
    },
  ]
  const mismatch = checks.find((check) => check.expected !== check.observed)
  return mismatch === undefined
    ? Result.succeed(undefined)
    : Result.fail({
        _tag: 'CapitalGrantGenerationBindingMismatch',
        field: mismatch.field,
        expected: mismatch.expected,
        observed: mismatch.observed,
      })
}

export const validatePersistedGrantGenerationBinding = Pipeable.dual(
  2,
  validatePersistedGrantGenerationBindingDataFirst,
)

const sameRevocation = (left: CapitalGrantRevocation | undefined, right: CapitalGrantRevocation): boolean =>
  left?.schemaVersion === right.schemaVersion &&
  left.revokedAt === right.revokedAt &&
  left.revokedBy === right.revokedBy &&
  left.reason === right.reason

const authorityFromRow = (row: Row): Result.Result<GrantedCapitalAuthority, PersistedCapitalGrantStoreError> => {
  const identity = makeBrokerIdentity({
    schemaVersion: row.broker_identity_schema_version,
    provider: row.broker_provider,
    environment: row.broker_environment,
    accountId: row.account_id,
  })
  if (Result.isFailure(identity)) {
    return Result.fail(
      storeError('read', 'decode', 'persisted capital grant broker identity is invalid', identity.failure),
    )
  }
  if (identity.success.identityHash !== row.broker_identity_hash) {
    return Result.fail(storeError('read', 'invariant', 'persisted capital grant broker identity hash mismatch'))
  }
  if (
    row.generation_broker_identity_schema_version !== identity.success.schemaVersion ||
    row.generation_broker_identity_hash !== identity.success.identityHash ||
    row.generation_broker_provider !== identity.success.provider ||
    row.generation_broker_environment !== identity.success.environment ||
    row.generation_account_id !== identity.success.accountId
  ) {
    return Result.fail(
      storeError(
        'read',
        'invariant',
        'persisted capital grant does not match its authority-generation broker identity',
      ),
    )
  }

  const generationBinding = validatePersistedGrantGenerationBinding(
    {
      strategy: {
        name: row.strategy_name,
        behaviorHash: row.strategy_behavior_hash,
        parameterHash: row.strategy_parameter_hash,
        parameterSchemaVersion: row.strategy_parameter_schema_version,
      },
    },
    {
      maximum: row.generation_maximum,
      strategyName: row.generation_strategy_name,
      strategyBehaviorHash: row.generation_strategy_behavior_hash,
      strategyParameterHash: row.generation_strategy_parameter_hash,
      strategyParameterSchemaVersion: row.generation_strategy_parameter_schema_version,
    },
  )
  if (Result.isFailure(generationBinding)) {
    return Result.fail(
      storeError(
        'read',
        'invariant',
        'persisted capital grant does not match its execution authority-generation strategy identity',
        generationBinding.failure,
      ),
    )
  }

  const grant = decodeCapitalGrantRecord({
    schemaVersion: row.schema_version,
    brokerIdentity: identity.success,
    authorityGenerationHash: row.authority_generation_hash,
    strategy: {
      name: row.strategy_name,
      behaviorHash: row.strategy_behavior_hash,
      parameterHash: row.strategy_parameter_hash,
      parameterSchemaVersion: row.strategy_parameter_schema_version,
    },
    limits: {
      maxGrossNotionalMicros: row.max_gross_notional_micros,
      maxOrderNotionalMicros: row.max_order_notional_micros,
      maxPositionNotionalMicros: row.max_position_notional_micros,
      maxDailyLossMicros: row.max_daily_loss_micros,
      maxOpenOrders: row.max_open_orders,
    },
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until.toISOString(),
    issuedAt: row.issued_at.toISOString(),
    issuedBy: row.issued_by,
    grantHash: row.grant_hash,
  })
  if (Result.isFailure(grant)) {
    return Result.fail(storeError('read', 'decode', 'persisted capital grant is invalid', grant.failure))
  }

  const revocationSchemaVersion = row.revocation_schema_version
  const revokedAt = row.revoked_at
  const revokedBy = row.revoked_by
  const revocationReason = row.revocation_reason
  if (revocationSchemaVersion === null && revokedAt === null && revokedBy === null && revocationReason === null) {
    return Result.succeed(grantedCapitalAuthority(grant.success))
  }
  if (revocationSchemaVersion === null || revokedAt === null || revokedBy === null || revocationReason === null) {
    return Result.fail(storeError('read', 'invariant', 'persisted capital grant revocation is incomplete'))
  }
  const revocation = decodeCapitalGrantRevocation({
    schemaVersion: revocationSchemaVersion,
    revokedAt: revokedAt.toISOString(),
    revokedBy,
    reason: revocationReason,
  })
  return Result.isFailure(revocation)
    ? Result.fail(storeError('read', 'decode', 'persisted capital grant revocation is invalid', revocation.failure))
    : Result.succeed(grantedCapitalAuthority(grant.success, revocation.success))
}

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient

  const lockGrant = (
    operation: Extract<PersistedCapitalGrantStoreError['operation'], 'lock-submit' | 'revoke'>,
    grantHash: string,
  ) =>
    sql<Record<string, unknown>>`
      SELECT grant_hash
      FROM live_capital_grants
      WHERE grant_hash = ${grantHash}
      FOR UPDATE
    `.pipe(
      Effect.mapError((cause) => storeError(operation, 'query', 'persisted capital grant lock failed', cause)),
      Effect.flatMap((rows) =>
        Effect.fromResult(
          Result.mapError(decodeLockedRows(rows), (cause) =>
            storeError(operation, 'decode', 'persisted capital grant lock result is invalid', cause),
          ),
        ),
      ),
      Effect.flatMap((rows) =>
        rows.length <= 1
          ? Effect.succeed(rows.length === 1)
          : Effect.fail(storeError(operation, 'invariant', 'persisted capital grant lock returned duplicate rows')),
      ),
    )

  const readRows = (grantHash: string) => sql<Record<string, unknown>>`
    SELECT
      grants.grant_hash,
      grants.schema_version,
      grants.broker_identity_schema_version,
      grants.broker_identity_hash,
      grants.broker_provider,
      grants.broker_environment,
      grants.account_id,
      grants.authority_generation_hash,
      generation.broker_identity_schema_version AS generation_broker_identity_schema_version,
      generation.broker_identity_hash AS generation_broker_identity_hash,
      generation.broker_provider AS generation_broker_provider,
      generation.broker_environment AS generation_broker_environment,
      generation.account_id AS generation_account_id,
      generation.maximum AS generation_maximum,
      generation.strategy_name AS generation_strategy_name,
      generation.strategy_behavior_hash AS generation_strategy_behavior_hash,
      generation.strategy_parameter_hash AS generation_strategy_parameter_hash,
      generation.strategy_parameter_schema_version AS generation_strategy_parameter_schema_version,
      grants.strategy_name,
      grants.strategy_behavior_hash,
      grants.strategy_parameter_hash,
      grants.strategy_parameter_schema_version,
      grants.max_gross_notional_micros::text,
      grants.max_order_notional_micros::text,
      grants.max_position_notional_micros::text,
      grants.max_daily_loss_micros::text,
      grants.max_open_orders,
      grants.valid_from,
      grants.valid_until,
      grants.issued_at,
      grants.issued_by,
      revocations.schema_version AS revocation_schema_version,
      revocations.revoked_at,
      revocations.revoked_by,
      revocations.reason AS revocation_reason
    FROM live_capital_grants AS grants
    LEFT JOIN authority_generations AS generation
      ON generation.generation_hash = grants.authority_generation_hash
    LEFT JOIN live_capital_grant_revocations AS revocations USING (grant_hash)
    WHERE grants.grant_hash = ${grantHash}
  `

  const read = (input: string): Effect.Effect<GrantedCapitalAuthority | undefined, PersistedCapitalGrantStoreError> =>
    decodeHash(input).pipe(
      Effect.mapError((cause) => storeError('read', 'decode', 'invalid persisted capital grant hash', cause)),
      Effect.flatMap((grantHash) =>
        readRows(grantHash).pipe(
          Effect.mapError((cause) =>
            storeError('read', 'query', 'persisted capital grant query failed', isSqlError(cause) ? cause : cause),
          ),
        ),
      ),
      Effect.flatMap((rows) => Effect.fromResult(decodeRows(rows))),
      Effect.mapError((cause) =>
        cause instanceof PersistedCapitalGrantStoreError
          ? cause
          : storeError('read', 'decode', 'persisted capital grant row decoding failed', cause),
      ),
      Effect.flatMap((rows) => {
        if (rows.length === 0) return Effect.as(Effect.void, undefined)
        if (rows.length !== 1) {
          return Effect.fail(storeError('read', 'invariant', 'persisted capital grant query returned duplicate rows'))
        }
        const row = rows[0]
        return row === undefined
          ? Effect.fail(storeError('read', 'invariant', 'persisted capital grant query returned no row'))
          : Effect.fromResult(authorityFromRow(row))
      }),
    )

  const lockForSubmit = (
    input: string,
  ): Effect.Effect<GrantedCapitalAuthority | undefined, PersistedCapitalGrantStoreError> =>
    decodeHash(input).pipe(
      Effect.mapError((cause) => storeError('lock-submit', 'decode', 'invalid persisted capital grant hash', cause)),
      Effect.flatMap((grantHash) =>
        lockGrant('lock-submit', grantHash).pipe(
          Effect.flatMap((exists) => (exists ? read(grantHash) : Effect.as(Effect.void, undefined))),
        ),
      ),
    )

  const record = (grant: CapitalGrantRecord): Effect.Effect<GrantedCapitalAuthority, PersistedCapitalGrantStoreError> =>
    sql`
      INSERT INTO live_capital_grants (
        grant_hash, schema_version,
        broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment, account_id,
        authority_generation_hash,
        strategy_name, strategy_behavior_hash, strategy_parameter_hash, strategy_parameter_schema_version,
        max_gross_notional_micros, max_order_notional_micros, max_position_notional_micros,
        max_daily_loss_micros, max_open_orders,
        valid_from, valid_until, issued_at, issued_by
      )
      SELECT
        ${grant.grantHash}, ${grant.schemaVersion},
        ${grant.brokerIdentity.schemaVersion}, ${grant.brokerIdentity.identityHash},
        ${grant.brokerIdentity.provider}, ${grant.brokerIdentity.environment}, ${grant.brokerIdentity.accountId},
        ${grant.authorityGenerationHash},
        ${grant.strategy.name}, ${grant.strategy.behaviorHash}, ${grant.strategy.parameterHash},
        ${grant.strategy.parameterSchemaVersion},
        ${grant.limits.maxGrossNotionalMicros}, ${grant.limits.maxOrderNotionalMicros},
        ${grant.limits.maxPositionNotionalMicros}, ${grant.limits.maxDailyLossMicros}, ${grant.limits.maxOpenOrders},
        ${sqlTimestamp(grant.validFrom)}, ${sqlTimestamp(grant.validUntil)}, ${sqlTimestamp(grant.issuedAt)}, ${grant.issuedBy}
      FROM authority_generations AS generation
      WHERE generation.generation_hash = ${grant.authorityGenerationHash}
        AND generation.maximum = 'PAPER'
        AND generation.broker_identity_schema_version = ${grant.brokerIdentity.schemaVersion}
        AND generation.broker_identity_hash = ${grant.brokerIdentity.identityHash}
        AND generation.broker_provider = ${grant.brokerIdentity.provider}
        AND generation.broker_environment = ${grant.brokerIdentity.environment}
        AND generation.account_id = ${grant.brokerIdentity.accountId}
        AND generation.strategy_name = ${grant.strategy.name}
        AND generation.strategy_behavior_hash = ${grant.strategy.behaviorHash}
        AND generation.strategy_parameter_hash = ${grant.strategy.parameterHash}
        AND generation.strategy_parameter_schema_version = ${grant.strategy.parameterSchemaVersion}
      ON CONFLICT (grant_hash) DO NOTHING
    `.pipe(
      Effect.mapError((cause) => storeError('record', 'query', 'persisted capital grant insert failed', cause)),
      Effect.andThen(read(grant.grantHash)),
      Effect.flatMap((persisted) =>
        persisted === undefined
          ? Effect.fail(storeError('record', 'invariant', 'persisted capital grant was not persisted'))
          : Effect.succeed(persisted),
      ),
    )

  const revoke = (
    input: string,
    revocation: CapitalGrantRevocation,
  ): Effect.Effect<GrantedCapitalAuthority, PersistedCapitalGrantStoreError> =>
    decodeHash(input).pipe(
      Effect.mapError((cause) => storeError('revoke', 'decode', 'invalid persisted capital grant hash', cause)),
      Effect.flatMap((grantHash) =>
        sql
          .withTransaction(
            lockGrant('revoke', grantHash).pipe(
              Effect.flatMap((exists) =>
                exists
                  ? sql`
                    INSERT INTO live_capital_grant_revocations (
                      grant_hash, schema_version, revoked_at, revoked_by, reason
                    ) VALUES (
                      ${grantHash}, ${revocation.schemaVersion}, ${sqlTimestamp(revocation.revokedAt)},
                      ${revocation.revokedBy}, ${revocation.reason}
                    )
                    ON CONFLICT (grant_hash) DO NOTHING
                  `.pipe(
                      Effect.mapError((cause) =>
                        storeError('revoke', 'query', 'persisted capital grant revocation insert failed', cause),
                      ),
                    )
                  : Effect.fail(storeError('revoke', 'invariant', 'revoked persisted capital grant does not exist')),
              ),
              Effect.andThen(read(grantHash)),
              Effect.flatMap((persisted) =>
                persisted === undefined
                  ? Effect.fail(storeError('revoke', 'invariant', 'revoked persisted capital grant does not exist'))
                  : sameRevocation(persisted.persistedGrant?.revocation, revocation)
                    ? Effect.succeed(persisted)
                    : Effect.fail(
                        storeError(
                          'revoke',
                          'invariant',
                          'persisted capital grant already has a different immutable revocation',
                        ),
                      ),
              ),
            ),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause instanceof PersistedCapitalGrantStoreError
                ? cause
                : storeError('revoke', 'query', 'persisted capital grant revocation transaction failed', cause),
            ),
          ),
      ),
    )

  return { lockForSubmit, read, record, revoke } satisfies PersistedCapitalGrantStoreShape
})

export const PersistedCapitalGrantStoreLive = Layer.effect(PersistedCapitalGrantStore, makeStore)
