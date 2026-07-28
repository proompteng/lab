import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Result, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import {
  BrokerEnvironment,
  BrokerEnvironmentSchema,
  BrokerProviderSchema,
  makeBrokerIdentity,
} from '../broker/identity'
import {
  decodeLiveCapitalGrant,
  decodeLiveCapitalGrantRevocation,
  type LiveCapitalAuthority,
  type LiveCapitalGrant,
  type LiveCapitalGrantRevocation,
  liveCapitalAuthority,
} from '../execution/authority'
import { NonNegativeIntegerSchema, Sha256Schema, StrictNonEmptyStringSchema, strictParseOptions } from '../schemas'

export class LiveCapitalGrantStoreError extends Data.TaggedError('LiveCapitalGrantStoreError')<{
  readonly operation: 'read' | 'record' | 'revoke'
  readonly failure: 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface LiveCapitalGrantStoreShape {
  readonly read: (grantHash: string) => Effect.Effect<LiveCapitalAuthority | undefined, LiveCapitalGrantStoreError>
  readonly record: (grant: LiveCapitalGrant) => Effect.Effect<LiveCapitalAuthority, LiveCapitalGrantStoreError>
  readonly revoke: (
    grantHash: string,
    revocation: LiveCapitalGrantRevocation,
  ) => Effect.Effect<LiveCapitalAuthority, LiveCapitalGrantStoreError>
}

export class LiveCapitalGrantStore extends Context.Service<LiveCapitalGrantStore, LiveCapitalGrantStoreShape>()(
  'bayn/LiveCapitalGrantStore',
) {}

const RowSchema = Schema.Struct({
  grant_hash: Sha256Schema,
  schema_version: Schema.Literal('bayn.live-capital-grant.v1'),
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
  revocation_schema_version: Schema.NullOr(Schema.Literal('bayn.live-capital-grant-revocation.v1')),
  revoked_at: Schema.NullOr(Schema.Date),
  revoked_by: Schema.NullOr(StrictNonEmptyStringSchema),
  revocation_reason: Schema.NullOr(StrictNonEmptyStringSchema),
})
type Row = typeof RowSchema.Type

const decodeRows = Schema.decodeUnknownResult(Schema.Array(RowSchema), strictParseOptions)
const decodeHash = Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)

const storeError = (
  operation: LiveCapitalGrantStoreError['operation'],
  failure: LiveCapitalGrantStoreError['failure'],
  message: string,
  cause?: unknown,
) => new LiveCapitalGrantStoreError({ operation, failure, message, cause })

const sameRevocation = (left: LiveCapitalGrantRevocation | undefined, right: LiveCapitalGrantRevocation): boolean =>
  left?.schemaVersion === right.schemaVersion &&
  left.revokedAt === right.revokedAt &&
  left.revokedBy === right.revokedBy &&
  left.reason === right.reason

const authorityFromRow = (row: Row): Result.Result<LiveCapitalAuthority, LiveCapitalGrantStoreError> => {
  const identity = makeBrokerIdentity({
    schemaVersion: row.broker_identity_schema_version,
    provider: row.broker_provider,
    environment: row.broker_environment,
    accountId: row.account_id,
  })
  if (Result.isFailure(identity)) {
    return Result.fail(
      storeError('read', 'decode', 'persisted live grant broker identity is invalid', identity.failure),
    )
  }
  if (identity.success.environment !== BrokerEnvironment.Live) {
    return Result.fail(storeError('read', 'invariant', 'persisted live grant is not bound to a live broker identity'))
  }
  if (identity.success.identityHash !== row.broker_identity_hash) {
    return Result.fail(storeError('read', 'invariant', 'persisted live grant broker identity hash mismatch'))
  }
  if (
    row.generation_broker_identity_schema_version !== identity.success.schemaVersion ||
    row.generation_broker_identity_hash !== identity.success.identityHash ||
    row.generation_broker_provider !== identity.success.provider ||
    row.generation_broker_environment !== identity.success.environment ||
    row.generation_account_id !== identity.success.accountId
  ) {
    return Result.fail(
      storeError('read', 'invariant', 'live capital grant does not match its authority-generation broker identity'),
    )
  }

  const grant = decodeLiveCapitalGrant({
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
    return Result.fail(storeError('read', 'decode', 'persisted live capital grant is invalid', grant.failure))
  }

  const revocationFields = [row.revocation_schema_version, row.revoked_at, row.revoked_by, row.revocation_reason]
  if (revocationFields.every((value) => value === null)) return Result.succeed(liveCapitalAuthority(grant.success))
  if (revocationFields.some((value) => value === null)) {
    return Result.fail(storeError('read', 'invariant', 'persisted live capital grant revocation is incomplete'))
  }
  const revocation = decodeLiveCapitalGrantRevocation({
    schemaVersion: row.revocation_schema_version,
    revokedAt: row.revoked_at!.toISOString(),
    revokedBy: row.revoked_by,
    reason: row.revocation_reason,
  })
  return Result.isFailure(revocation)
    ? Result.fail(
        storeError('read', 'decode', 'persisted live capital grant revocation is invalid', revocation.failure),
      )
    : Result.succeed(liveCapitalAuthority(grant.success, revocation.success))
}

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient

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

  const read = (input: string): Effect.Effect<LiveCapitalAuthority | undefined, LiveCapitalGrantStoreError> =>
    decodeHash(input).pipe(
      Effect.mapError((cause) => storeError('read', 'decode', 'invalid live capital grant hash', cause)),
      Effect.flatMap((grantHash) =>
        readRows(grantHash).pipe(
          Effect.mapError((cause) =>
            storeError('read', 'query', 'live capital grant query failed', isSqlError(cause) ? cause : cause),
          ),
        ),
      ),
      Effect.flatMap((rows) => Effect.fromResult(decodeRows(rows))),
      Effect.mapError((cause) =>
        cause instanceof LiveCapitalGrantStoreError
          ? cause
          : storeError('read', 'decode', 'live capital grant row decoding failed', cause),
      ),
      Effect.flatMap((rows) => {
        if (rows.length === 0) return Effect.succeed(undefined)
        if (rows.length !== 1) {
          return Effect.fail(storeError('read', 'invariant', 'live capital grant query returned duplicate rows'))
        }
        return Effect.fromResult(authorityFromRow(rows[0]!))
      }),
    )

  const record = (grant: LiveCapitalGrant): Effect.Effect<LiveCapitalAuthority, LiveCapitalGrantStoreError> =>
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
        ${new Date(grant.validFrom)}, ${new Date(grant.validUntil)}, ${new Date(grant.issuedAt)}, ${grant.issuedBy}
      FROM authority_generations AS generation
      WHERE generation.generation_hash = ${grant.authorityGenerationHash}
        AND generation.broker_identity_schema_version = ${grant.brokerIdentity.schemaVersion}
        AND generation.broker_identity_hash = ${grant.brokerIdentity.identityHash}
        AND generation.broker_provider = ${grant.brokerIdentity.provider}
        AND generation.broker_environment = ${grant.brokerIdentity.environment}
        AND generation.account_id = ${grant.brokerIdentity.accountId}
      ON CONFLICT (grant_hash) DO NOTHING
    `.pipe(
      Effect.mapError((cause) => storeError('record', 'query', 'live capital grant insert failed', cause)),
      Effect.andThen(read(grant.grantHash)),
      Effect.flatMap((persisted) =>
        persisted === undefined
          ? Effect.fail(storeError('record', 'invariant', 'live capital grant was not persisted'))
          : Effect.succeed(persisted),
      ),
    )

  const revoke = (
    grantHash: string,
    revocation: LiveCapitalGrantRevocation,
  ): Effect.Effect<LiveCapitalAuthority, LiveCapitalGrantStoreError> =>
    sql`
      INSERT INTO live_capital_grant_revocations (
        grant_hash, schema_version, revoked_at, revoked_by, reason
      ) VALUES (
        ${grantHash}, ${revocation.schemaVersion}, ${new Date(revocation.revokedAt)},
        ${revocation.revokedBy}, ${revocation.reason}
      )
      ON CONFLICT (grant_hash) DO NOTHING
    `.pipe(
      Effect.mapError((cause) => storeError('revoke', 'query', 'live capital grant revocation insert failed', cause)),
      Effect.andThen(read(grantHash)),
      Effect.flatMap((persisted) =>
        persisted === undefined
          ? Effect.fail(storeError('revoke', 'invariant', 'revoked live capital grant does not exist'))
          : sameRevocation(persisted.revocation, revocation)
            ? Effect.succeed(persisted)
            : Effect.fail(
                storeError('revoke', 'invariant', 'live capital grant already has a different immutable revocation'),
              ),
      ),
    )

  return { read, record, revoke } satisfies LiveCapitalGrantStoreShape
})

export const LiveCapitalGrantStoreLive = Layer.effect(LiveCapitalGrantStore, makeStore)
