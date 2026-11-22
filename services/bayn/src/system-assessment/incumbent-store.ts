import { PgClient } from '@effect/sql-pg'
import { Config, Context, Effect, Layer, Schema } from 'effect'

import type { RuntimeConfig } from '../config/model'
import { ReplicaAddresses } from '../config/source'
import { PostgresClientLive } from '../db/postgres-client'

const prefix = 'BAYN_QUALIFICATION_INCUMBENT_JEV'

export const openIncumbentPostgres = (config: RuntimeConfig, readOnly: boolean) =>
  Effect.gen(function* () {
    const connection = yield* Config.all({
      url: Config.Redacted(`${prefix}_POSTGRES_URL`),
      caPath: Config.NonEmptyString(`${prefix}_POSTGRES_CA_PATH`).pipe(Config.withDefault(config.postgres.caPath)),
    })
    const services = yield* Layer.build(
      PostgresClientLive(
        { ...config, postgres: { ...config.postgres, ...connection } },
        { maxConnections: 2, applicationName: 'bayn-qualification-incumbent', readOnly },
      ),
    )
    return Context.get(services, PgClient.PgClient)
  })

export const incumbentTigerBeetle = Config.all({
  clusterId: Config.schema(Schema.BigIntFromString, `${prefix}_TIGERBEETLE_CLUSTER_ID`),
  replicaAddresses: Config.schema(ReplicaAddresses, `${prefix}_TIGERBEETLE_ADDRESSES`),
  ledger: Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0xffffffff })),
    `${prefix}_TIGERBEETLE_LEDGER`,
  ),
})
