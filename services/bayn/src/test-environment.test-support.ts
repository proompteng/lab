import { Config, Effect, Option, Result } from 'effect'

const optionalString = (name: string): string | undefined =>
  Effect.runSync(Config.option(Config.string(name))).pipe(Option.getOrUndefined)

export const baynTestPostgresUrl = optionalString('BAYN_TEST_POSTGRES_URL')
export const baynTestClickhouseUrl = optionalString('BAYN_TEST_CLICKHOUSE_URL')
export const isGithubActions = Effect.runSync(Config.boolean('GITHUB_ACTIONS').pipe(Config.withDefault(false)))

const loopbackClickhouseHosts = new Set(['127.0.0.1', '[::1]', 'localhost'])

export const validateBaynTestClickhouseUrl = (value: string): Result.Result<URL, Error> =>
  Result.try({
    try: () => new URL(value),
    catch: (cause) => new Error('BAYN_TEST_CLICKHOUSE_URL must be a valid URL', { cause }),
  }).pipe(
    Result.flatMap((url) =>
      (url.protocol === 'http:' || url.protocol === 'https:') && loopbackClickhouseHosts.has(url.hostname.toLowerCase())
        ? Result.succeed(url)
        : Result.fail(new Error('BAYN_TEST_CLICKHOUSE_URL must target a loopback-only disposable ClickHouse instance')),
    ),
  )
