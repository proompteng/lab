import { Config, Effect, Option } from 'effect'

const optionalString = (name: string): string | undefined =>
  Effect.runSync(Config.option(Config.string(name))).pipe(Option.getOrUndefined)

export const baynTestPostgresUrl = optionalString('BAYN_TEST_POSTGRES_URL')
export const baynTestClickhouseUrl = optionalString('BAYN_TEST_CLICKHOUSE_URL')
export const baynTestClickhouseGuardToken = optionalString('BAYN_TEST_CLICKHOUSE_GUARD_TOKEN')
export const isGithubActions = Effect.runSync(Config.boolean('GITHUB_ACTIONS').pipe(Config.withDefault(false)))
