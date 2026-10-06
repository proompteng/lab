import { Config } from 'effect'

export const researchReaderConfig = Config.all({
  accountId: Config.Redacted('BAYN_ALPACA_ACCOUNT_ID'),
  url: Config.Redacted('BAYN_POSTGRES_URL'),
  tls: Config.Boolean('BAYN_POSTGRES_TLS').pipe(Config.withDefault(true)),
  caPath: Config.String('BAYN_POSTGRES_CA_PATH').pipe(Config.withDefault('/var/run/secrets/bayn/postgres/ca.crt')),
})
