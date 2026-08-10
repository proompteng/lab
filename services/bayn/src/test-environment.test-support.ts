import { Config, Effect, Option } from 'effect'

const optionalString = (name: string): string | undefined =>
  Effect.runSync(Config.option(Config.string(name))).pipe(Option.getOrUndefined)

export const baynTestPostgresUrl = optionalString('BAYN_TEST_POSTGRES_URL')
export const isGithubActions = Effect.runSync(Config.boolean('GITHUB_ACTIONS').pipe(Config.withDefault(false)))
