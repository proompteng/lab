import { Config, Context, Effect, Layer } from 'effect'

import { ConfigurationError } from './errors'

export interface BaynConfigShape {
  readonly hostname: string
  readonly port: number
}

export class BaynConfig extends Context.Tag('@bayn/Config')<BaynConfig, BaynConfigShape>() {}

const configDescriptor = Config.all({
  hostname: Config.string('BAYN_HOST').pipe(
    Config.withDefault('0.0.0.0'),
    Config.validate({
      message: 'BAYN_HOST must not be empty',
      validation: (hostname) => hostname.trim().length > 0,
    }),
  ),
  port: Config.port('BAYN_PORT').pipe(Config.withDefault(8080)),
})

export const loadConfig: Effect.Effect<BaynConfigShape, ConfigurationError> = configDescriptor.pipe(
  Effect.map(({ hostname, port }) => ({ hostname: hostname.trim(), port })),
  Effect.mapError(
    (error) =>
      new ConfigurationError({
        message: `Invalid Bayn configuration: ${error.message}`,
      }),
  ),
)

export const BaynConfigLive = Layer.effect(BaynConfig, loadConfig)
