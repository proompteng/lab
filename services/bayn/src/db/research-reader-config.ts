import { Config, Schema } from 'effect'

export const researchReaderConfig = Config.all({
  accountId: Config.Redacted('BAYN_ALPACA_ACCOUNT_ID'),
  url: Config.Redacted('BAYN_POSTGRES_URL'),
  tls: Config.Boolean('BAYN_POSTGRES_TLS').pipe(Config.withDefault(true)),
  caPath: Config.String('BAYN_POSTGRES_CA_PATH').pipe(Config.withDefault('/var/run/secrets/bayn/postgres/ca.crt')),
})

export const researchLedgerReaderConfig = Config.all({
  clusterId: Config.schema(Schema.BigIntFromString, 'BAYN_TIGERBEETLE_CLUSTER_ID').pipe(Config.withDefault(2001n)),
  replicaAddresses: Config.NonEmptyString('BAYN_TIGERBEETLE_ADDRESSES').pipe(
    Config.map((value) => value.split(',').map((address) => address.trim())),
  ),
})
